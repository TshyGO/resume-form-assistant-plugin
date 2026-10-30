//! Small source boundary. IMAP keeps its UID planning/header retry machinery;
//! paged APIs own opaque pagination/delta state. Both commit Metadata through
//! Database::commit_metadata and download through MimeSource only on confirmation.
use crate::{Candidate, Cursor, Error, Header, Result};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Imap,
    MicrosoftGraph,
    GmailApi,
    /// Display-only fallback for an unsupported/corrupt stored source. Never connect.
    Unknown,
}
impl SourceKind {
    pub(crate) fn as_db(self) -> &'static str {
        match self {
            Self::Imap => "imap",
            Self::MicrosoftGraph => "microsoftGraph",
            Self::GmailApi => "gmailApi",
            Self::Unknown => "unknown",
        }
    }
    pub fn is_api(self) -> bool {
        matches!(self, Self::MicrosoftGraph | Self::GmailApi)
    }
    pub(crate) fn from_db(value: &str) -> Result<Self> {
        match value {
            "imap" => Ok(Self::Imap),
            "microsoftGraph" => Ok(Self::MicrosoftGraph),
            "gmailApi" => Ok(Self::GmailApi),
            _ => Err(Error::Storage),
        }
    }
}

/// Source IDs locate bytes. They never replace RFC Message-ID + sender + date
/// (or the existing fallback fingerprint) used for cross-entry deduplication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MessageLocator {
    Imap {
        folder: String,
        validity: u32,
        uid: u32,
    },
    Api {
        source: SourceKind,
        message_id: String,
    },
}
impl MessageLocator {
    pub fn validate(&self, expected: SourceKind) -> Result<()> {
        match self {
            Self::Imap { folder, uid, .. }
                if expected == SourceKind::Imap && !folder.is_empty() && *uid > 0 =>
            {
                Ok(())
            }
            Self::Api { source, message_id }
                if *source == expected
                    && expected.is_api()
                    && !message_id.is_empty()
                    && message_id.len() <= 4096 =>
            {
                Ok(())
            }
            _ => Err(Error::Changed),
        }
    }
}

/// Opaque API progress is machine-local, never logged or exposed to the webview.
/// Adapters must store continuation state, not OAuth/session/access tokens.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum Position {
    Imap(Cursor),
    Api { source: SourceKind, cursor: String },
}
impl Position {
    pub fn validate(&self, expected: SourceKind) -> Result<()> {
        match self {
            Self::Imap(_) if expected == SourceKind::Imap => Ok(()),
            Self::Api { source, cursor }
                if *source == expected
                    && expected.is_api()
                    && !cursor.is_empty()
                    && cursor.len() <= 65536 =>
            {
                Ok(())
            }
            _ => Err(Error::Changed),
        }
    }
}

#[derive(Clone)]
pub struct Metadata {
    pub locator: MessageLocator,
    pub header: Header,
}
/// Headers only: never body, preview, attachments or MIME. The adapter owns
/// whether next is a page continuation or a delta checkpoint.
pub struct MetadataPage {
    pub messages: Vec<Metadata>,
    pub next: Position,
    pub has_more: bool,
}

pub trait MimeSource {
    fn kind(&self) -> SourceKind;
    /// Local account authenticated by this source instance, never an alias.
    fn account_id(&self) -> &str;
    /// Enforce max_bytes while streaming, before buffering an unbounded response.
    /// Allowed only after user confirmation.
    fn download_mime(
        &mut self,
        item: &Candidate,
        max_bytes: usize,
    ) -> impl Future<Output = Result<Vec<u8>>>;
}
/// API paging extends the common download seam without replacing IMAP's working
/// folder/UID/retry scanner. Resume only from persisted positions.
pub trait PagedSource: MimeSource {
    fn read_metadata(
        &mut self,
        scope: &str,
        position: Option<&Position>,
    ) -> impl Future<Output = Result<MetadataPage>>;
}

#[derive(Default)]
pub struct Cancellation {
    cancelled: AtomicBool,
    wake: tokio::sync::Notify,
}
impl Cancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.wake.notify_waiters();
    }
    pub fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }

    /// Drop pending network work when cancelled, including a stalled request.
    /// The source must discard any interrupted transport before its next read.
    pub async fn run<T>(&self, operation: impl Future<Output = Result<T>>) -> Result<T> {
        // notify_waiters also wakes a Notified created before its first poll.
        // Create it before checking the flag so cancellation cannot be missed.
        let cancelled = self.wake.notified();
        self.check()?;
        tokio::select! {
            biased;
            _ = cancelled => Err(Error::Cancelled),
            result = operation => {
                self.check()?;
                result
            }
        }
    }
}

/// Read one metadata page and hand it to a short guarded local transaction.
/// On any read/commit failure the caller reloads the persisted checkpoint;
/// advancing an adapter's in-memory cursor is never sufficient for progress.
pub async fn scan_page<E: From<Error>>(
    source: &mut impl PagedSource,
    scope: &str,
    position: Option<&Position>,
    cancellation: &Cancellation,
    commit: impl FnOnce(MetadataPage) -> std::result::Result<(), E>,
) -> std::result::Result<bool, E> {
    cancellation.check()?;
    if !source.kind().is_api() {
        return Err(Error::UnsupportedSource.into());
    }
    if let Some(position) = position {
        position.validate(source.kind())?;
    }
    let page = cancellation
        .run(crate::imap::bounded(source.read_metadata(scope, position)))
        .await?;
    cancellation.check()?;
    page.next.validate(source.kind())?;
    if page.messages.len() > crate::imap::BATCH_SIZE {
        return Err(Error::TooLarge.into());
    }
    for message in &page.messages {
        message.locator.validate(source.kind())?;
        if serde_json::to_vec(&message.header)
            .map_err(|_| Error::Protocol)?
            .len()
            > 65536
        {
            return Err(Error::TooLarge.into());
        }
    }
    let has_more = page.has_more;
    commit(page)?;
    Ok(has_more)
}

pub async fn confirmed_mime(source: &mut impl MimeSource, item: &Candidate) -> Result<Vec<u8>> {
    if source.account_id() != item.account_id {
        return Err(Error::Changed);
    }
    item.locator.validate(source.kind())?;
    let limit = evidence_import::MAX_ATTACHMENT_BYTES as usize;
    let bytes = source.download_mime(item, limit).await?;
    if bytes.len() > limit {
        return Err(Error::TooLarge);
    }
    if Header::parse(&bytes).fingerprint() != item.header.fingerprint() {
        return Err(Error::Changed);
    }
    Ok(bytes)
}

pub struct ImapSource<'a>(pub &'a mut crate::imap::LiveSession, pub &'a str);
impl MimeSource for ImapSource<'_> {
    fn kind(&self) -> SourceKind {
        SourceKind::Imap
    }
    fn account_id(&self) -> &str {
        self.1
    }
    async fn download_mime(&mut self, item: &Candidate, _max_bytes: usize) -> Result<Vec<u8>> {
        crate::imap::download(self.0, item).await
    }
}
