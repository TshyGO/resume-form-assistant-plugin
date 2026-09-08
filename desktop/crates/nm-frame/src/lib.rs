//! Native Messaging stdio framing.
//!
//! Chrome frames each message as a 4-byte native-endian length prefix followed by
//! UTF-8 JSON. This crate moves bytes only; it never parses the body.

use std::io::{Read, Write};

/// Matches `resume_pro_protocol::MAX_ENVELOPE_BYTES`. A larger frame would be refused by
/// the contract layer anyway, so refusing it here avoids the allocation entirely.
pub const MAX_FRAME_BYTES: usize = 65536;

#[derive(Debug)]
pub enum FrameError {
    Io(std::io::Error),
    /// The length prefix claimed more than `MAX_FRAME_BYTES`. Nothing was allocated and
    /// the body was not read; the stream can no longer be trusted.
    TooLarge { declared: u32 },
    /// The stream ended part-way through a prefix or a body. A length-prefixed stream
    /// cannot resynchronise, so the caller must close the connection.
    Truncated,
}

impl From<std::io::Error> for FrameError {
    fn from(value: std::io::Error) -> Self {
        FrameError::Io(value)
    }
}

/// Read one frame. `Ok(None)` means the peer closed the port cleanly, which is a normal
/// end of session rather than an error.
pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<Vec<u8>>, FrameError> {
    let mut prefix = [0u8; 4];
    let read = fill(reader, &mut prefix)?;
    if read == 0 {
        return Ok(None);
    }
    if read < prefix.len() {
        return Err(FrameError::Truncated);
    }
    let declared = u32::from_ne_bytes(prefix);
    if declared as usize > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge { declared });
    }
    let mut body = vec![0u8; declared as usize];
    let read = fill(reader, &mut body)?;
    if read < body.len() {
        return Err(FrameError::Truncated);
    }
    Ok(Some(body))
}

/// Write one frame. Refuses an oversized body without writing anything: a half-written
/// frame would desynchronise the stream permanently.
pub fn write_frame<W: Write>(writer: &mut W, body: &[u8]) -> Result<(), FrameError> {
    if body.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge {
            declared: body.len() as u32,
        });
    }
    writer.write_all(&(body.len() as u32).to_ne_bytes())?;
    writer.write_all(body)?;
    writer.flush()?;
    Ok(())
}

/// Read until `buf` is full or the stream ends. Returns how many bytes were read.
fn fill<R: Read>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(len: u32, body: &[u8]) -> Vec<u8> {
        let mut out = len.to_ne_bytes().to_vec();
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn reads_a_frame_written_with_a_native_endian_prefix() {
        let body = br#"{"messageType":"health"}"#;
        let mut cursor = std::io::Cursor::new(wire(body.len() as u32, body));
        assert_eq!(read_frame(&mut cursor).unwrap().as_deref(), Some(&body[..]));
    }

    #[test]
    fn a_zero_length_frame_is_an_empty_body_not_an_end_of_stream() {
        let mut cursor = std::io::Cursor::new(wire(0, b""));
        assert_eq!(read_frame(&mut cursor).unwrap(), Some(Vec::new()));
    }

    #[test]
    fn a_closed_port_is_a_clean_end_of_session() {
        let mut cursor = std::io::Cursor::new(Vec::new());
        assert_eq!(read_frame(&mut cursor).unwrap(), None);
    }

    #[test]
    fn a_partial_prefix_cannot_resynchronise() {
        let mut cursor = std::io::Cursor::new(vec![1u8, 0, 0]);
        assert!(matches!(read_frame(&mut cursor), Err(FrameError::Truncated)));
    }

    #[test]
    fn a_body_shorter_than_its_prefix_is_truncated() {
        let mut cursor = std::io::Cursor::new(wire(10, b"only4"));
        assert!(matches!(read_frame(&mut cursor), Err(FrameError::Truncated)));
    }

    #[test]
    fn an_oversized_prefix_is_refused_without_reading_or_allocating_the_body() {
        // The prefix claims 4 GiB. Nothing may be allocated, and the body must still be
        // unread so the refusal is provably about the prefix alone.
        let mut cursor = std::io::Cursor::new(wire(u32::MAX, b"body-must-stay-unread"));
        assert!(matches!(
            read_frame(&mut cursor),
            Err(FrameError::TooLarge { declared: u32::MAX })
        ));
        assert_eq!(cursor.position(), 4);
    }

    #[test]
    fn the_largest_accepted_frame_is_the_protocol_envelope_limit() {
        let body = vec![b'x'; MAX_FRAME_BYTES];
        let mut cursor = std::io::Cursor::new(wire(body.len() as u32, &body));
        assert_eq!(read_frame(&mut cursor).unwrap(), Some(body));

        let over = vec![b'x'; MAX_FRAME_BYTES + 1];
        let mut cursor = std::io::Cursor::new(wire(over.len() as u32, &over));
        assert!(matches!(read_frame(&mut cursor), Err(FrameError::TooLarge { .. })));
    }

    #[test]
    fn writes_a_frame_that_reads_back_identically() {
        let body = br#"{"ok":true}"#;
        let mut out = Vec::new();
        write_frame(&mut out, body).unwrap();
        assert_eq!(out.len(), 4 + body.len());
        let mut cursor = std::io::Cursor::new(out);
        assert_eq!(read_frame(&mut cursor).unwrap().as_deref(), Some(&body[..]));
    }

    #[test]
    fn a_body_containing_newline_bytes_round_trips_unchanged() {
        // Text-mode translation would turn 0x0A into 0x0D 0x0A, corrupting the body and
        // desynchronising it from its length prefix. ADR 3.7 requires binary stdout.
        let body = b"{\n\"a\":1\n}";
        let mut out = Vec::new();
        write_frame(&mut out, body).unwrap();
        assert_eq!(&out[4..], body);
        let mut cursor = std::io::Cursor::new(out);
        assert_eq!(read_frame(&mut cursor).unwrap().as_deref(), Some(&body[..]));
    }

    #[test]
    fn refuses_to_write_beyond_the_envelope_limit() {
        let body = vec![b'x'; MAX_FRAME_BYTES + 1];
        let mut out = Vec::new();
        assert!(matches!(write_frame(&mut out, &body), Err(FrameError::TooLarge { .. })));
        assert!(out.is_empty(), "nothing may be written for a refused frame");
    }
}
