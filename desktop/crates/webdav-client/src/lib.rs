//! HTTPS-only WebDAV transport. Archive publication and retention live above it.
//! Mutations are never automatically retried: unknown outcomes require reconciliation.
mod error;
mod listing;
mod path;
mod probe;
#[cfg(test)]
mod tests;

pub use error::{Error, ErrorKind};
pub use listing::{Completeness, Entry, Listing};
pub use path::RemotePath;
pub use probe::{Capabilities, MoveSupport};
pub use secrecy::SecretString;
pub use tokio_util::sync::CancellationToken;

use reqwest::{header, Body, Method, Response};
use secrecy::ExposeSecret;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio::time::Instant;
use tokio_util::io::ReaderStream;
use url::Url;

pub const NUTSTORE_ENDPOINT: &str = "https://dav.jianguoyun.com/dav/";
pub const NUTSTORE_MAX_FILE_BYTES: u64 = 500_000_000;
const PROP_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getetag/></d:prop></d:propfind>"#;
const MAX_RETRY_WAIT: Duration = Duration::from_secs(60);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(60);
// Budget slow but progressing transfers at 64 KiB/s plus connection overhead.
// Uploads have this finite total deadline; downloads also detect stalled chunks.
fn transfer_timeout(bytes: u64) -> Duration {
    CONTROL_TIMEOUT + Duration::from_secs(bytes.div_ceil(64 * 1024))
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    root: Url,
    username: String,
    password: SecretString,
    next_request: Arc<Mutex<Instant>>,
    interval: Duration,
    control_timeout: Duration,
    known_listing_limit: Option<usize>,
}
impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WebDavClient { connection: [REDACTED] }")
    }
}
#[derive(Debug, Clone)]
pub struct ObjectInfo {
    pub size: Option<u64>,
    pub etag: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Download {
    pub bytes: u64,
    pub sha256: [u8; 32],
}

impl Client {
    pub fn nutstore(username: String, password: SecretString) -> Result<Self, Error> {
        Self::new(NUTSTORE_ENDPOINT, username, password)
    }
    /// Custom HTTPS endpoints have unverified listing completeness.
    pub fn new(endpoint: &str, username: String, password: SecretString) -> Result<Self, Error> {
        Self::build(endpoint, username, password, false)
    }
    fn build(
        endpoint: &str,
        username: String,
        password: SecretString,
        test_http: bool,
    ) -> Result<Self, Error> {
        if username.is_empty()
            || username.len() > 4096
            || username.contains(':')
            || username.chars().any(char::is_control)
            || password.expose_secret().is_empty()
        {
            return Err(Error::new(ErrorKind::InvalidConfig));
        }
        let root = path::checked_root(endpoint, test_http)?;
        let known_listing_limit = if root.as_str() == NUTSTORE_ENDPOINT {
            Some(listing::NUTSTORE_LIST_LIMIT)
        } else {
            None
        };
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10));
        if test_http {
            builder = builder.no_proxy().http1_only();
        }
        let http = builder
            .build()
            .map_err(|_| Error::new(ErrorKind::InvalidConfig))?;
        Ok(Self {
            http,
            root,
            username,
            password,
            next_request: Arc::new(Mutex::new(Instant::now())),
            interval: if test_http {
                Duration::ZERO
            } else {
                Duration::from_secs(3)
            },
            known_listing_limit,
            control_timeout: CONTROL_TIMEOUT,
        })
    }
    async fn throttle(&self, cancel: &CancellationToken) -> Result<(), Error> {
        let mut next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::new(ErrorKind::Cancelled)),
            guard = self.next_request.lock() => guard,
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::new(ErrorKind::Cancelled)),
            _ = tokio::time::sleep_until(*next) => {},
        }
        *next = Instant::now() + self.interval;
        Ok(())
    }
    fn request(&self, method: Method, path: &RemotePath) -> Result<reqwest::RequestBuilder, Error> {
        let collection = matches!(method.as_str(), "PROPFIND" | "MKCOL");
        self.request_to(method, path, collection)
    }
    fn request_to(
        &self,
        method: Method,
        path: &RemotePath,
        collection: bool,
    ) -> Result<reqwest::RequestBuilder, Error> {
        let mut url = path::resource_url(&self.root, path)?;
        if collection && !url.path().ends_with('/') {
            url.path_segments_mut()
                .map_err(|_| Error::new(ErrorKind::InvalidPath))?
                .push("");
        }
        Ok(self
            .http
            .request(method, url)
            .timeout(self.control_timeout)
            .basic_auth(&self.username, Some(self.password.expose_secret())))
    }
    async fn perform(
        &self,
        request: reqwest::RequestBuilder,
        cancel: &CancellationToken,
        mutation: bool,
    ) -> Result<Response, Error> {
        self.throttle(cancel).await?;
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                let mut error = Error::new(ErrorKind::Cancelled);
                error.outcome_unknown = mutation;
                return Err(error);
            }
            result = request.send() => result.map_err(|error| network_error(error, mutation))?,
        };
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status().as_u16();
        let kind = match status {
            301..=399 => ErrorKind::Redirect,
            401 => ErrorKind::Authentication,
            403 => ErrorKind::Permission,
            404 => ErrorKind::NotFound,
            409 | 412 => ErrorKind::Conflict,
            413 => ErrorKind::TooLarge,
            429 => ErrorKind::RateLimited,
            507 => ErrorKind::NoSpace,
            405 | 501 => ErrorKind::Unsupported,
            500..=599 => ErrorKind::Server,
            _ => ErrorKind::InvalidResponse,
        };
        let retry_after = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_retry_after);
        Err(Error {
            kind,
            status: Some(status),
            retry_after,
            outcome_unknown: mutation && status >= 500,
        })
    }
    async fn read_response(
        &self,
        method: Method,
        path: &RemotePath,
        cancel: &CancellationToken,
    ) -> Result<Response, Error> {
        self.read_response_with_timeout(method, path, cancel, self.control_timeout)
            .await
    }
    async fn read_response_with_timeout(
        &self,
        method: Method,
        path: &RemotePath,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<Response, Error> {
        self.read_response_at_depth(method, path, cancel, timeout, "1")
            .await
    }
    async fn read_response_at_depth(
        &self,
        method: Method,
        path: &RemotePath,
        cancel: &CancellationToken,
        timeout: Duration,
        depth: &'static str,
    ) -> Result<Response, Error> {
        for attempt in 0..=2u32 {
            // Depth:0 addresses the object itself, so a file keeps its exact URL.
            let mut request = if depth == "0" {
                self.request_to(method.clone(), path, false)?
            } else {
                self.request(method.clone(), path)?
            }
            .timeout(timeout);
            if method.as_str() == "PROPFIND" {
                request = request
                    .header("Depth", depth)
                    .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
                    .body(PROP_BODY);
            }
            match self.perform(request, cancel, false).await {
                Ok(response) => return Ok(response),
                Err(error) => {
                    if !error.retryable() || attempt == 2 {
                        return Err(error);
                    }
                    let delay = error
                        .retry_after
                        .unwrap_or(Duration::from_millis(250 * (1u64 << attempt)));
                    if delay > MAX_RETRY_WAIT {
                        return Err(error);
                    }
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return Err(Error::new(ErrorKind::Cancelled)),
                        _ = tokio::time::sleep(delay) => {},
                    }
                }
            }
        }
        unreachable!()
    }
    pub async fn list(
        &self,
        path: &RemotePath,
        cancel: &CancellationToken,
    ) -> Result<Listing, Error> {
        let response = self
            .read_response(Method::from_bytes(b"PROPFIND").unwrap(), path, cancel)
            .await?;
        expect_status(&response, &[207], false)?;
        let bytes = bounded_bytes(response, listing::MAX_XML_BYTES, cancel).await?;
        listing::parse(&self.root, path, &bytes, self.known_listing_limit)
    }
    /// Size and ETag of one object from `PROPFIND Depth: 0`. Deliberately not
    /// HEAD: Nutstore was observed answering HEAD with `Content-Length: 0` for a
    /// complete file (#316).
    pub async fn stat(
        &self,
        path: &RemotePath,
        cancel: &CancellationToken,
    ) -> Result<ObjectInfo, Error> {
        let response = self
            .read_response_at_depth(
                Method::from_bytes(b"PROPFIND").unwrap(),
                path,
                cancel,
                self.control_timeout,
                "0",
            )
            .await?;
        expect_status(&response, &[207], false)?;
        let bytes = bounded_bytes(response, listing::MAX_XML_BYTES, cancel).await?;
        let entry = listing::parse_object(&self.root, path, &bytes)?;
        Ok(ObjectInfo {
            size: entry.size,
            etag: entry.etag,
        })
    }
    pub async fn get_bytes(
        &self,
        path: &RemotePath,
        max: usize,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, Error> {
        if max > listing::MAX_XML_BYTES {
            return Err(Error::new(ErrorKind::TooLarge));
        }
        let response = self.read_response(Method::GET, path, cancel).await?;
        expect_status(&response, &[200], false)?;
        bounded_bytes(response, max, cancel).await
    }
    pub async fn mkcol(&self, path: &RemotePath, cancel: &CancellationToken) -> Result<(), Error> {
        if path.0.is_empty() {
            return Err(Error::new(ErrorKind::InvalidPath));
        }
        let response = self
            .perform(
                self.request(Method::from_bytes(b"MKCOL").unwrap(), path)?,
                cancel,
                true,
            )
            .await?;
        expect_status(&response, &[201], true)
    }
    /// Create-only PUT. Probe If-None-Match semantics and use unique owned names.
    pub async fn put_bytes_new(
        &self,
        path: &RemotePath,
        bytes: Vec<u8>,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        if bytes.len() as u64 > NUTSTORE_MAX_FILE_BYTES || path.0.is_empty() {
            return Err(Error::new(ErrorKind::TooLarge));
        }
        let request = self
            .request(Method::PUT, path)?
            .timeout(transfer_timeout(bytes.len() as u64))
            .header(header::IF_NONE_MATCH, "*")
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(bytes);
        let response = self.perform(request, cancel, true).await?;
        expect_status(&response, &[201, 204], true)
    }
    pub async fn put_file_new(
        &self,
        path: &RemotePath,
        source: &Path,
        max: u64,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        if max > NUTSTORE_MAX_FILE_BYTES || path.0.is_empty() {
            return Err(Error::new(ErrorKind::InvalidConfig));
        }
        let file = tokio::fs::File::open(source).await?;
        let meta = file.metadata().await?;
        if !meta.is_file() {
            return Err(Error::new(ErrorKind::InvalidPath));
        }
        if meta.len() > max {
            return Err(Error::new(ErrorKind::TooLarge));
        }
        let length = meta.len();
        let body = Body::wrap_stream(ReaderStream::new(file.take(length)));
        let request = self
            .request(Method::PUT, path)?
            .timeout(transfer_timeout(length))
            .header(header::IF_NONE_MATCH, "*")
            .header(header::CONTENT_LENGTH, length)
            .body(body);
        let response = self.perform(request, cancel, true).await?;
        expect_status(&response, &[201, 204], true)
    }
    pub async fn move_new(
        &self,
        from: &RemotePath,
        to: &RemotePath,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        if from.0.is_empty() || to.0.is_empty() || from == to {
            return Err(Error::new(ErrorKind::InvalidPath));
        }
        let destination = path::resource_url(&self.root, to)?;
        let request = self
            .request(Method::from_bytes(b"MOVE").unwrap(), from)?
            .header("Destination", destination.as_str())
            .header("Overwrite", "F");
        let response = self.perform(request, cancel, true).await?;
        expect_status(&response, &[201, 204], true)
    }
    pub async fn delete(&self, path: &RemotePath, cancel: &CancellationToken) -> Result<(), Error> {
        if path.0.is_empty() {
            return Err(Error::new(ErrorKind::InvalidPath));
        }
        let response = self
            .perform(self.request(Method::DELETE, path)?, cancel, true)
            .await?;
        expect_status(&response, &[200, 204], true)
    }
    /// Publish a new task file only when the complete bounded download is on disk.
    pub async fn download_new(
        &self,
        path: &RemotePath,
        destination: &Path,
        max: u64,
        cancel: &CancellationToken,
    ) -> Result<Download, Error> {
        if max > NUTSTORE_MAX_FILE_BYTES {
            return Err(Error::new(ErrorKind::InvalidConfig));
        }
        let mut response = tokio::time::timeout(
            self.control_timeout,
            self.read_response_with_timeout(Method::GET, path, cancel, transfer_timeout(max)),
        )
        .await
        .map_err(|_| Error::new(ErrorKind::Timeout))??;
        expect_status(&response, &[200], false)?;
        let expected = response.content_length();
        if expected.is_some_and(|length| length > max) {
            return Err(Error::new(ErrorKind::TooLarge));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| Error::new(ErrorKind::InvalidPath))?;
        let temporary = tempfile::Builder::new()
            .prefix(".resumepro-download-")
            .tempfile_in(parent)?;
        let mut file = tokio::fs::File::from_std(temporary.reopen()?);
        let mut bytes = 0u64;
        let mut hasher = Sha256::new();
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(Error::new(ErrorKind::Cancelled)),
                chunk = tokio::time::timeout(self.control_timeout, response.chunk()) =>
                    chunk.map_err(|_| Error::new(ErrorKind::Timeout))?
                        .map_err(|error| network_error(error, false))?,
            };
            let Some(chunk) = chunk else {
                break;
            };
            bytes = bytes
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| Error::new(ErrorKind::TooLarge))?;
            if bytes > max {
                return Err(Error::new(ErrorKind::TooLarge));
            }
            hasher.update(&chunk);
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(Error::new(ErrorKind::Cancelled)),
                result = file.write_all(&chunk) => result?,
            }
        }
        if expected.is_some_and(|length| length != bytes) {
            return Err(Error::new(ErrorKind::InvalidResponse));
        }
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        if cancel.is_cancelled() {
            return Err(Error::new(ErrorKind::Cancelled));
        }
        temporary
            .persist_noclobber(destination)
            .map_err(|_| Error::new(ErrorKind::Io))?;
        Ok(Download {
            bytes,
            sha256: hasher.finalize().into(),
        })
    }
}
fn expect_status(response: &Response, allowed: &[u16], mutation: bool) -> Result<(), Error> {
    if allowed.contains(&response.status().as_u16()) {
        Ok(())
    } else {
        Err(Error {
            kind: ErrorKind::InvalidResponse,
            status: Some(response.status().as_u16()),
            retry_after: None,
            outcome_unknown: mutation,
        })
    }
}
fn network_error(error: reqwest::Error, mutation: bool) -> Error {
    Error {
        kind: if error.is_timeout() {
            ErrorKind::Timeout
        } else {
            ErrorKind::Network
        },
        status: None,
        retry_after: None,
        outcome_unknown: mutation,
    }
}
fn parse_retry_after(text: &str) -> Option<Duration> {
    text.parse::<u64>()
        .ok()
        .map(Duration::from_secs)
        .or_else(|| {
            httpdate::parse_http_date(text).ok().map(|at| {
                at.duration_since(SystemTime::now())
                    .unwrap_or(Duration::ZERO)
            })
        })
}
async fn bounded_bytes(
    mut response: Response,
    max: usize,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, Error> {
    if response
        .content_length()
        .is_some_and(|length| length > max as u64)
    {
        return Err(Error::new(ErrorKind::TooLarge));
    }
    let mut output = Vec::new();
    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::new(ErrorKind::Cancelled)),
            chunk = response.chunk() => chunk.map_err(|error| network_error(error, false))?,
        };
        let Some(chunk) = chunk else {
            return Ok(output);
        };
        if chunk.len() > max.saturating_sub(output.len()) {
            return Err(Error::new(ErrorKind::TooLarge));
        }
        output.extend_from_slice(&chunk);
    }
}
