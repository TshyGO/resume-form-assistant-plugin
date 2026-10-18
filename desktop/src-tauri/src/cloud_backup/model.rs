use super::{fail, Result};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use webdav_client::{RemotePath, NUTSTORE_MAX_FILE_BYTES};

pub const META_LIMIT: usize = 16 * 1024;
pub const MAX_CATALOG: usize = 512;
pub const MAX_MONTHS: usize = 120;
pub const MARKER: &str = "resume-pro.cloud-backup";

pub fn uuid(value: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| fail("INVALID_ID"))?;
    if parsed.to_string() != value {
        return Err(fail("INVALID_ID"));
    }
    Ok(())
}
pub fn date(value: &str) -> Result<OffsetDateTime> {
    let parsed = OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map_err(|_| fail("INVALID_DATE"))?;
    if parsed.offset() != time::UtcOffset::UTC
        || value.len() > 40
        || !(1..=9999).contains(&parsed.year())
    {
        return Err(fail("INVALID_DATE"));
    }
    Ok(parsed)
}
pub fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}
pub fn month(value: &str) -> Result<String> {
    let d = date(value)?;
    Ok(format!("{:04}-{:02}", d.year(), u8::from(d.month())))
}
pub fn stem(created: &str, id: &str) -> Result<String> {
    uuid(id)?;
    let d = date(created)?;
    Ok(format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z-{id}",
        d.year(),
        u8::from(d.month()),
        d.day(),
        d.hour(),
        d.minute(),
        d.second()
    ))
}
pub fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Encryption {
    AgeV1Scrypt,
    None,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    pub format: String,
    pub format_version: u32,
    pub backup_id: String,
    pub created_at: String,
    pub archive_id: String,
    pub device_id: String,
    pub package: String,
    pub size_bytes: u64,
    pub package_sha256: String,
    pub encryption_format: Encryption,
}
impl Metadata {
    pub fn check(&self) -> Result<()> {
        uuid(&self.backup_id)?;
        uuid(&self.archive_id)?;
        uuid(&self.device_id)?;
        if self.format != MARKER
            || self.format_version != 1
            || self.size_bytes == 0
            || self.size_bytes > NUTSTORE_MAX_FILE_BYTES
            || !digest_valid(&self.package_sha256)
            || self.package != self.package_name()?
        {
            return Err(fail("INVALID_METADATA"));
        }
        Ok(())
    }
    pub fn package_name(&self) -> Result<String> {
        Ok(format!(
            "{}.rpbak{}",
            stem(&self.created_at, &self.backup_id)?,
            if self.encryption_format == Encryption::AgeV1Scrypt {
                ".age"
            } else {
                ""
            }
        ))
    }
    pub fn meta_name(&self) -> Result<String> {
        Ok(format!(
            "{}.meta.json",
            stem(&self.created_at, &self.backup_id)?
        ))
    }
    pub fn folder(&self, root: &RemotePath) -> Result<RemotePath> {
        self.check()?;
        Ok(device_folder(root, &self.archive_id, &self.device_id)?
            .child(&month(&self.created_at)?)?)
    }
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > META_LIMIT {
            return Err(fail("INVALID_METADATA"));
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| fail("INVALID_METADATA"))?;
        value.check()?;
        Ok(value)
    }
}
pub fn device_folder(root: &RemotePath, archive: &str, device: &str) -> Result<RemotePath> {
    uuid(archive)?;
    uuid(device)?;
    Ok(root.child("ResumePro")?.child(archive)?.child(device)?)
}

#[derive(Clone, Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    #[serde(default)]
    pub root: Vec<String>,
    #[serde(default = "yes")]
    pub encrypted: bool,
    #[serde(default = "maximum")]
    pub max_upload_bytes: u64,
    #[serde(default = "keep")]
    pub keep_last: Option<usize>,
    /// Probe synthetic content first. MOVE is used only after no-overwrite is observed.
    #[serde(default)]
    pub prefer_move: bool,
}
fn yes() -> bool {
    true
}
fn maximum() -> u64 {
    NUTSTORE_MAX_FILE_BYTES
}
fn keep() -> Option<usize> {
    Some(5)
}
impl Options {
    pub fn check(&self) -> Result<RemotePath> {
        if self.root.len() > 24
            || self.root.iter().map(String::len).sum::<usize>() > 512
            || self.max_upload_bytes == 0
            || self.max_upload_bytes > maximum()
            || self.keep_last.is_some_and(|n| !(1..=100).contains(&n))
        {
            return Err(fail("INVALID_OPTIONS"));
        }
        Ok(RemotePath::new(
            &self.root.iter().map(String::as_str).collect::<Vec<_>>(),
        )?)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Packing,
    Encrypting,
    Uploading,
    Confirming,
    Succeeded,
    CleanupWarning,
    Failed,
    Cancelled,
    Interrupted,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub id: String,
    pub scope: String,
    pub options: Options,
    pub metadata: Metadata,
    pub phase: Phase,
    pub candidate_ready: bool,
    pub move_verified: bool,
    pub part_intent: bool,
    pub package_intent: bool,
    pub meta_intent: bool,
    pub published: bool,
    pub error_code: Option<String>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub scope: String,
    pub root: Vec<String>,
    pub metadata: Metadata,
    pub deleting: bool,
    pub orphan: bool,
    pub part_intent: bool,
    pub package_intent: bool,
    pub touched_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal {
    pub device_id: String,
    pub job: Option<Job>,
    pub latest: Option<String>,
    pub receipts: Vec<Receipt>,
    #[serde(default)]
    pub local_garbage: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub device_id: String,
    pub job: Option<Job>,
    pub retry_package: Option<String>,
    pub latest_package: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub entries: Vec<Metadata>,
    pub cleanup_safe: bool,
    /// HEAD/length checks do not verify package content hashes.
    pub content_hash_verified: bool,
}
