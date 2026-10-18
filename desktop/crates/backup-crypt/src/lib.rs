//! Bounded, atomic age v1 encryption for local backup packages.
//!
//! Outputs are new task files: existing destinations are never replaced. A final
//! file is published only after age's final chunk/EOF check and fsync succeed.
//! Cancellation is observed between chunks and before/after the bounded scrypt
//! call; scrypt itself cannot be interrupted by this synchronous library.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Cursor, Read, Write};
use std::path::Path;
pub mod workspace;

pub use age::secrecy::{ExposeSecret, SecretString};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024 + 4 * 1024 * 1024;
const WORK_FACTOR: u8 = 18; // age scrypt N=2^18, r=8: bounded to about 256 MiB.

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_input_bytes: u64,
    pub max_output_bytes: u64,
    pub max_work_factor: u8,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_input_bytes: MAX_BYTES,
            max_output_bytes: MAX_BYTES,
            max_work_factor: WORK_FACTOR,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Io,
    InvalidInput,
    Limit,
    Cancelled,
    InvalidCiphertext,
    Encryption,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Io => "备份文件读写失败；未发布输出文件。",
            Self::InvalidInput => "备份加密参数或输入不合法。",
            Self::Limit => "备份超出大小、头部或加密工作因子上限。",
            Self::Cancelled => "备份加解密已取消。",
            Self::InvalidCiphertext => "口令不正确或加密备份已损坏/不受支持。",
            Self::Encryption => "备份加密失败；未发布输出文件。",
        })
    }
}
impl std::error::Error for Error {}
impl From<io::Error> for Error {
    fn from(_: io::Error) -> Self {
        Self::Io
    }
}

fn check_cancel(cancel: &impl Fn() -> bool) -> Result<(), Error> {
    if cancel() {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

fn input_file(path: &Path, limits: Limits) -> Result<File, Error> {
    if limits.max_input_bytes > MAX_BYTES
        || limits.max_output_bytes > MAX_BYTES
        || limits.max_work_factor == 0
        || limits.max_work_factor > WORK_FACTOR
    {
        return Err(Error::InvalidInput);
    }
    let file = File::open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(Error::InvalidInput);
    }
    if meta.len() > limits.max_input_bytes {
        return Err(Error::Limit);
    }
    Ok(file)
}

fn copy_bounded(
    input: &mut impl Read,
    output: &mut impl Write,
    max: u64,
    cancel: &impl Fn() -> bool,
) -> Result<u64, Error> {
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        check_cancel(cancel)?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            return Ok(total);
        }
        total = total.checked_add(count as u64).ok_or(Error::Limit)?;
        if total > max {
            return Err(Error::Limit);
        }
        output.write_all(&buffer[..count])?;
    }
}

/// The public encryptor uses one documented work factor; tests use the same age
/// protocol with a cheaper factor through the private implementation.
pub fn encrypt_file(
    input: &Path,
    destination: &Path,
    passphrase: SecretString,
    limits: Limits,
    cancel: &impl Fn() -> bool,
) -> Result<u64, Error> {
    encrypt_with_factor(input, destination, passphrase, limits, cancel, WORK_FACTOR)
}

fn encrypt_with_factor(
    input: &Path,
    destination: &Path,
    passphrase: SecretString,
    limits: Limits,
    cancel: &impl Fn() -> bool,
    factor: u8,
) -> Result<u64, Error> {
    check_cancel(cancel)?;
    if passphrase.expose_secret().is_empty() || factor > limits.max_work_factor {
        return Err(Error::InvalidInput);
    }
    let mut input = input_file(input, limits)?.take(limits.max_input_bytes.saturating_add(1));
    let parent = destination.parent().ok_or(Error::InvalidInput)?;
    let mut output = tempfile::Builder::new()
        .prefix(".resumepro-crypt-")
        .tempfile_in(parent)?;
    let mut recipient = age::scrypt::Recipient::new(passphrase);
    recipient.set_work_factor(factor);
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
            .map_err(|_| Error::Encryption)?;
    check_cancel(cancel)?;
    {
        // Limit the encrypted stream too, including header and authentication tags.
        let mut bounded = LimitedWriter {
            inner: output.as_file_mut(),
            remaining: limits.max_output_bytes,
        };
        let mut encrypted = encryptor
            .wrap_output(&mut bounded)
            .map_err(|_| Error::Encryption)?;
        copy_bounded(&mut input, &mut encrypted, limits.max_input_bytes, cancel)?;
        encrypted.finish().map_err(|_| Error::Encryption)?;
    }
    publish(output, destination, cancel)
}

struct LimitedWriter<'a> {
    inner: &'a mut File,
    remaining: u64,
}
impl Write for LimitedWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.len() as u64 > self.remaining {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "encrypted output limit",
            ));
        }
        let written = self.inner.write(buffer)?;
        self.remaining -= written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Bound header parsing before giving untrusted input to age. No unbounded
/// read_until: each line can consume only the remaining header budget.
fn bounded_header(input: File, max_input: u64) -> Result<impl BufRead, Error> {
    let mut input = BufReader::new(input.take(max_input.saturating_add(1)));
    let mut header = Vec::new();
    loop {
        let start = header.len();
        let remaining = MAX_HEADER_BYTES.saturating_sub(start);
        if remaining == 0 {
            return Err(Error::Limit);
        }
        let count = input
            .by_ref()
            .take(remaining as u64)
            .read_until(b'\n', &mut header)?;
        if count == 0 || header.last() != Some(&b'\n') {
            return Err(Error::InvalidCiphertext);
        }
        let line = &header[start..];
        if start == 0 && line != b"age-encryption.org/v1\n" {
            return Err(Error::InvalidCiphertext);
        }
        if line.starts_with(b"--- ") {
            break;
        }
    }
    Ok(BufReader::new(Cursor::new(header).chain(input)))
}

pub fn decrypt_file(
    input: &Path,
    destination: &Path,
    passphrase: SecretString,
    limits: Limits,
    cancel: &impl Fn() -> bool,
) -> Result<u64, Error> {
    check_cancel(cancel)?;
    if passphrase.expose_secret().is_empty() {
        return Err(Error::InvalidInput);
    }
    let file = input_file(input, limits)?;
    let decryptor = age::Decryptor::new_buffered(bounded_header(file, limits.max_input_bytes)?)
        .map_err(|_| Error::InvalidCiphertext)?;
    if !decryptor.is_scrypt() {
        return Err(Error::InvalidCiphertext);
    }
    let mut identity = age::scrypt::Identity::new(passphrase);
    identity.set_max_work_factor(limits.max_work_factor);
    let mut decrypted = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|_| Error::InvalidCiphertext)?;
    check_cancel(cancel)?;
    let parent = destination.parent().ok_or(Error::InvalidInput)?;
    let mut output = tempfile::Builder::new()
        .prefix(".resumepro-crypt-")
        .tempfile_in(parent)?;
    // Read to EOF, including age's final authenticated chunk. Limits/cancellation
    // remain distinguishable; authentication IO errors expose no plaintext detail.
    copy_bounded(
        &mut decrypted,
        output.as_file_mut(),
        limits.max_output_bytes,
        cancel,
    )
    .map_err(|error| {
        if error == Error::Io {
            Error::InvalidCiphertext
        } else {
            error
        }
    })?;
    publish(output, destination, cancel)
}

fn publish(
    output: tempfile::NamedTempFile,
    destination: &Path,
    cancel: &impl Fn() -> bool,
) -> Result<u64, Error> {
    check_cancel(cancel)?;
    output.as_file().sync_all()?;
    let size = output.as_file().metadata()?.len();
    output
        .persist_noclobber(destination)
        .map_err(|_| Error::Io)?;
    Ok(size)
}

#[cfg(test)]
mod tests;
