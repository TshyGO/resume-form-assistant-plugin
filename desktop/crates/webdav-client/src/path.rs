use crate::{Error, ErrorKind};
use percent_encoding::percent_decode_str;
use url::Url;

/// Literal decoded path segments; never an external URL or filesystem path.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct RemotePath(pub(crate) Vec<String>);
impl RemotePath {
    pub fn root() -> Self {
        Self::default()
    }
    pub fn new(segments: &[&str]) -> Result<Self, Error> {
        let mut path = Self::root();
        for segment in segments {
            path = path.child(segment)?;
        }
        Ok(path)
    }
    pub fn child(&self, segment: &str) -> Result<Self, Error> {
        validate_segment(segment)?;
        if self.0.len() >= 32 {
            return Err(Error::new(ErrorKind::InvalidPath));
        }
        let mut next = self.clone();
        next.0.push(segment.to_owned());
        Ok(next)
    }
    pub fn segments(&self) -> &[String] {
        &self.0
    }
}

fn validate_segment(segment: &str) -> Result<(), Error> {
    if segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment.len() > 1024
        || segment.contains(['/', '\\'])
        || segment.chars().any(char::is_control)
    {
        return Err(Error::new(ErrorKind::InvalidPath));
    }
    Ok(())
}
pub(crate) fn decoded_segments(url: &Url) -> Result<Vec<String>, Error> {
    let path = url
        .path()
        .strip_prefix('/')
        .ok_or_else(|| Error::new(ErrorKind::InvalidPath))?;
    let path = path.strip_suffix('/').unwrap_or(path);
    if path.is_empty() {
        return Ok(Vec::new());
    }
    path.split('/')
        .map(|part| {
            let decoded = percent_decode_str(part)
                .decode_utf8()
                .map_err(|_| Error::new(ErrorKind::InvalidPath))?
                .into_owned();
            validate_segment(&decoded)?;
            Ok(decoded)
        })
        .collect()
}
pub(crate) fn checked_root(endpoint: &str, allow_http: bool) -> Result<Url, Error> {
    let mut url = Url::parse(endpoint).map_err(|_| Error::new(ErrorKind::InvalidConfig))?;
    if !(url.scheme() == "https" || (allow_http && url.scheme() == "http"))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::new(ErrorKind::InvalidConfig));
    }
    decoded_segments(&url)?;
    if !url.path().ends_with('/') {
        url.path_segments_mut()
            .map_err(|_| Error::new(ErrorKind::InvalidConfig))?
            .push("");
    }
    Ok(url)
}
pub(crate) fn resource_url(root: &Url, path: &RemotePath) -> Result<Url, Error> {
    if path.0.is_empty() {
        return Ok(root.clone());
    }
    let mut result = root.clone();
    {
        let mut segments = result
            .path_segments_mut()
            .map_err(|_| Error::new(ErrorKind::InvalidPath))?;
        segments.pop_if_empty();
        for part in &path.0 {
            segments.push(part);
        }
    }
    Ok(result)
}
/// Check decoded segments as well as origin: encoded slashes/dot paths and sibling
/// prefixes must never escape the configured root or the requested Depth:1 scope.
pub(crate) fn response_path(
    root: &Url,
    requested: &RemotePath,
    href: &str,
) -> Result<RemotePath, Error> {
    if href.len() > 16 * 1024 || href.contains('\\') || href.chars().any(char::is_control) {
        return Err(Error::new(ErrorKind::InvalidResponse));
    }
    // URL::join normalizes dot segments (including percent-encoded dots). Reject
    // them before normalization so a malicious alias cannot become a valid child.
    for segment in href.split(['/', '?', '#']) {
        let decoded = percent_decode_str(segment)
            .decode_utf8()
            .map_err(|_| Error::new(ErrorKind::InvalidResponse))?;
        if decoded == "."
            || decoded == ".."
            || decoded.contains(['/', '\\'])
            || decoded.chars().any(char::is_control)
        {
            return Err(Error::new(ErrorKind::InvalidResponse));
        }
    }
    let request_url = resource_url(root, requested)?;
    // Relative hrefs are interpreted beneath the requested collection.
    let mut collection = request_url;
    if !collection.path().ends_with('/') {
        collection.path_segments_mut().unwrap().push("");
    }
    let url = collection
        .join(href)
        .map_err(|_| Error::new(ErrorKind::InvalidResponse))?;
    if url.origin() != root.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::new(ErrorKind::InvalidResponse));
    }
    let base = decoded_segments(root)?;
    let full = decoded_segments(&url)?;
    let relative = full
        .strip_prefix(base.as_slice())
        .ok_or_else(|| Error::new(ErrorKind::InvalidResponse))?;
    if !relative.starts_with(&requested.0) || relative.len() > requested.0.len() + 1 {
        return Err(Error::new(ErrorKind::InvalidResponse));
    }
    Ok(RemotePath(relative.to_vec()))
}
