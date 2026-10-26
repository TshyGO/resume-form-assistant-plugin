//! The transport exposes only discovery and PEEK reads, never mailbox mutations.
use crate::{
    Account, Candidate, ConnectionConfig, Cursor, Encryption, Error, Header, Provider, Result,
};
use async_imap::{types::NameAttribute, Session};
use futures_util::TryStreamExt;
use std::{collections::HashSet, fmt::Debug, future::Future, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
};

pub type LiveSession = Session<tokio_native_tls::TlsStream<TcpStream>>;
const HEADER_QUERY: &str = "(UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]<0.65536>)";
const DOWNLOAD_CHUNK_SIZE: usize = 1024 * 1024;
pub const HEADER_RETRY_BUDGET: usize = 8;
pub const BATCH_SIZE: usize = 100;

pub async fn bounded<T>(future: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .map_err(|_| Error::Network)?
}
fn network(error: async_imap::error::Error) -> Error {
    match error {
        async_imap::error::Error::Io(_) | async_imap::error::Error::ConnectionLost => {
            Error::Network
        }
        _ => Error::Protocol,
    }
}
fn login_error(error: async_imap::error::Error) -> Error {
    match &error {
        async_imap::error::Error::No(message) => {
            let lower = message.to_ascii_lowercase();
            if lower.contains("disabled")
                || lower.contains("not enabled")
                || lower.contains("未开启")
                || lower.contains("未开通")
            {
                Error::ImapDisabled
            } else {
                Error::Auth
            }
        }
        _ => network(error),
    }
}
pub async fn connect(email: &str, secret: &str) -> Result<LiveSession> {
    connect_configured(email, secret, &ConnectionConfig::preset(email)?).await
}
pub async fn connect_configured(
    email: &str,
    secret: &str,
    configuration: &ConnectionConfig,
) -> Result<LiveSession> {
    let config = configuration.clone().validated(email)?;
    if secret.trim().is_empty() || secret.contains(['\r', '\n', '\0']) {
        return Err(Error::Auth);
    }
    bounded(async {
        let socket = TcpStream::connect((config.host.as_str(), config.port))
            .await
            .map_err(|_| Error::Network)?;
        let starttls = config.encryption == Encryption::Starttls;
        let socket = if starttls {
            let mut client = async_imap::Client::new(socket);
            client
                .read_response()
                .await
                .map_err(|_| Error::Network)?
                .ok_or(Error::Network)?;
            // Never authenticate before the upgrade; failure has no plaintext fallback.
            upgrade_transport(client).await?
        } else {
            socket
        };
        let connector = tokio_native_tls::native_tls::TlsConnector::builder()
            .min_protocol_version(Some(tokio_native_tls::native_tls::Protocol::Tlsv12))
            .build()
            .map_err(|_| Error::Tls)?;
        let tls = tokio_native_tls::TlsConnector::from(connector)
            .connect(&config.host, socket)
            .await
            .map_err(|_| Error::Tls)?;
        let mut client = async_imap::Client::new(tls);
        if !starttls {
            client
                .read_response()
                .await
                .map_err(|_| Error::Network)?
                .ok_or(Error::Network)?;
        }
        let mut session = client
            .login(&config.username, secret.trim())
            .await
            .map_err(|(e, _)| login_error(e))?;
        if config.send_id {
            identify(&mut session, Provider::N163).await?;
        }
        Ok(session)
    })
    .await
}
/// Authentication is deliberately unavailable on the plaintext client path.
async fn upgrade_transport<S: AsyncRead + AsyncWrite + Unpin + Debug + Send>(
    mut client: async_imap::Client<S>,
) -> Result<S> {
    client
        .run_command_and_check_ok("STARTTLS", None)
        .await
        .map_err(|_| Error::Tls)?;
    Ok(client.into_inner())
}
pub async fn identify<S: AsyncRead + AsyncWrite + Unpin + Debug + Send>(
    session: &mut Session<S>,
    provider: Provider,
) -> Result<()> {
    if provider.needs_id() {
        session
            .id([("name", Some("ResumePro")), ("version", Some("0.4"))])
            .await
            .map_err(network)?;
    }
    Ok(())
}
fn junk_name(name: &str, delimiter: Option<&str>) -> bool {
    use base64::Engine;
    let leaf = delimiter
        .filter(|value| !value.is_empty())
        .and_then(|value| name.rsplit(value).next())
        .unwrap_or(name);
    let lower = leaf.trim().to_ascii_lowercase();
    ["junk", "junk e-mail", "junk email", "spam", "bulk mail"].contains(&lower.as_str())
        || ["垃圾邮件", "垃圾箱"].iter().any(|s| {
            let bytes: Vec<u8> = s.encode_utf16().flat_map(u16::to_be_bytes).collect();
            let encoded = base64::engine::general_purpose::STANDARD_NO_PAD
                .encode(bytes)
                .replace('/', ",");
            leaf.trim() == *s || leaf.trim() == format!("&{encoded}-")
        })
}
pub async fn folders<S: AsyncRead + AsyncWrite + Unpin + Debug + Send>(
    session: &mut Session<S>,
) -> Result<Vec<String>> {
    bounded(async {
        let mut result = vec!["INBOX".to_string()];
        let mut names = session.list(Some(""), Some("*")).await.map_err(network)?;
        while let Some(name) = names.try_next().await.map_err(network)? {
            if name.attributes().contains(&NameAttribute::NoSelect) {
                continue;
            }
            if (name.attributes().contains(&NameAttribute::Junk)
                || junk_name(name.name(), name.delimiter()))
                && !result.iter().any(|n| n.eq_ignore_ascii_case(name.name()))
            {
                result.push(name.name().to_string());
            }
        }
        Ok(result)
    })
    .await
}

pub struct Scan {
    pub validity: u32,
    pub high_uid: u32,
    pub uids: Vec<u32>,
}
/// Snapshot the upper UID before searching. Never use an inverted `n:*` range:
/// IMAP treats ranges symmetrically, which can re-read the newest old message.
pub async fn plan<S: AsyncRead + AsyncWrite + Unpin + Debug + Send>(
    session: &mut Session<S>,
    folder: &str,
    cursor: Option<Cursor>,
    now: i64,
) -> Result<Scan> {
    bounded(async {
        let mailbox = session.examine(folder).await.map_err(network)?;
        let validity = mailbox
            .uid_validity
            .filter(|v| *v > 0)
            .ok_or(Error::Protocol)?;
        let high_uid = match mailbox.uid_next.filter(|value| *value > 0) {
            Some(next) => next.saturating_sub(1),
            None => {
                // Coremail (including 163/126) can omit UIDNEXT even though it
                // otherwise supports UID commands. Snapshot the upper bound
                // with UID SEARCH ALL before constructing a bounded range.
                session
                    .uid_search("ALL")
                    .await
                    .map_err(network)?
                    .into_iter()
                    .max()
                    .unwrap_or(0)
            }
        };
        let old = cursor.filter(|c| c.validity == validity);
        let start = old.map_or(1, |c| c.uid.saturating_add(1));
        if start > high_uid || old.is_some_and(|c| c.uid == u32::MAX) {
            return Ok(Scan {
                validity,
                high_uid: old.map_or(high_uid, |c| c.uid.max(high_uid)),
                uids: vec![],
            });
        }
        let query = if old.is_some() {
            format!("UID {start}:{high_uid}")
        } else {
            let date = time::OffsetDateTime::from_unix_timestamp(now.saturating_sub(30 * 86400))
                .map_err(|_| Error::Protocol)?;
            let months = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ];
            format!(
                "SINCE {}-{}-{} UID 1:{high_uid}",
                date.day(),
                months[date.month() as usize - 1],
                date.year()
            )
        };
        let mut uids: Vec<u32> = session
            .uid_search(query)
            .await
            .map_err(network)?
            .into_iter()
            .filter(|u| *u >= start && *u <= high_uid)
            .collect();
        uids.sort_unstable();
        Ok(Scan {
            validity,
            high_uid,
            uids,
        })
    })
    .await
}
pub async fn headers<S: AsyncRead + AsyncWrite + Unpin + Debug + Send>(
    session: &mut Session<S>,
    uids: &[u32],
) -> Result<Vec<(u32, Header)>> {
    if uids.is_empty() {
        return Ok(vec![]);
    }
    if uids.len() > BATCH_SIZE {
        return Err(Error::Protocol);
    }
    bounded(async {
        let set = uids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let mut stream = session
            .uid_fetch(set, HEADER_QUERY)
            .await
            .map_err(network)?;
        let mut result = Vec::new();
        let mut skipped = HashSet::new();
        while let Some(fetch) = stream.try_next().await.map_err(network)? {
            // Unsolicited flag updates can appear in a FETCH stream.
            let Some(uid) = fetch.uid.filter(|uid| uids.contains(uid)) else {
                continue;
            };
            let Some(raw) = fetch.header() else {
                continue;
            };
            if raw.len() >= 65536 {
                // Consume the rest of the FETCH stream and let the caller
                // advance past this one malformed message. Returning here
                // would desynchronise the session and poison every later scan.
                skipped.insert(uid);
                continue;
            }
            result.push((uid, Header::parse(raw)));
        }
        drop(stream);
        let missing: Vec<_> = uids
            .iter()
            .filter(|uid| !skipped.contains(uid) && !result.iter().any(|(found, _)| found == *uid))
            .map(u32::to_string)
            .collect();
        if !missing.is_empty() {
            // Missing FETCH data is only skippable when that UID was expunged.
            let live = session
                .uid_search(format!("UID {}", missing.join(",")))
                .await
                .map_err(network)?;
            if !live.is_empty() {
                return Err(Error::Protocol);
            }
        }
        if !skipped.is_empty() {
            return Err(Error::TooLarge);
        }
        Ok(result)
    })
    .await
}

pub struct HeaderBatch {
    pub headers: Vec<(u32, Header)>,
    /// Live messages whose header may be temporarily unavailable.
    pub retry_uids: Vec<u32>,
    /// Live messages left for a later scan because this batch exhausted the
    /// immediate recovery budget. These have not failed an individual fetch.
    pub deferred_uids: Vec<u32>,
    /// Permanently unsupported headers, currently only the explicit size cap.
    pub terminal_uids: Vec<u32>,
}

/// Recover useful headers without forgetting live messages that need a later
/// retry. Connection failures still abort the entire batch.
pub async fn headers_resilient<S: AsyncRead + AsyncWrite + Unpin + Debug + Send>(
    session: &mut Session<S>,
    uids: &[u32],
) -> Result<HeaderBatch> {
    match headers(session, uids).await {
        Ok(headers) => Ok(HeaderBatch {
            headers,
            retry_uids: Vec::new(),
            deferred_uids: Vec::new(),
            terminal_uids: Vec::new(),
        }),
        Err(Error::Protocol | Error::TooLarge) if uids.len() > 1 => {
            let mut batch = HeaderBatch {
                headers: Vec::new(),
                retry_uids: Vec::new(),
                deferred_uids: Vec::new(),
                terminal_uids: Vec::new(),
            };
            for uid in uids.iter().take(HEADER_RETRY_BUDGET) {
                match headers(session, &[*uid]).await {
                    Ok(mut one) => batch.headers.append(&mut one),
                    Err(Error::Protocol) => batch.retry_uids.push(*uid),
                    Err(Error::TooLarge) => batch.terminal_uids.push(*uid),
                    Err(error) => return Err(error),
                }
            }
            batch
                .deferred_uids
                .extend_from_slice(&uids[uids.len().min(HEADER_RETRY_BUDGET)..]);
            Ok(batch)
        }
        Err(Error::Protocol) => Ok(HeaderBatch {
            headers: Vec::new(),
            retry_uids: uids.to_vec(),
            deferred_uids: Vec::new(),
            terminal_uids: Vec::new(),
        }),
        Err(Error::TooLarge) => Ok(HeaderBatch {
            headers: Vec::new(),
            retry_uids: Vec::new(),
            deferred_uids: Vec::new(),
            terminal_uids: uids.to_vec(),
        }),
        Err(error) => Err(error),
    }
}
pub async fn download<S: AsyncRead + AsyncWrite + Unpin + Debug + Send>(
    session: &mut Session<S>,
    item: &Candidate,
) -> Result<Vec<u8>> {
    bounded(async {
        let mailbox = session.examine(&item.folder).await.map_err(network)?;
        if mailbox.uid_validity != Some(item.validity) {
            return Err(Error::Changed);
        }
        Ok(())
    })
    .await?;
    let size = bounded(async {
        let mut stream = session
            .uid_fetch(item.uid.to_string(), "(UID RFC822.SIZE)")
            .await
            .map_err(network)?;
        let mut size = None;
        while let Some(fetch) = stream.try_next().await.map_err(network)? {
            if fetch.uid == Some(item.uid) {
                size = fetch.size.map(|value| value as usize);
            }
        }
        size.ok_or(Error::Missing)
    })
    .await?;
    let limit = evidence_import::MAX_ATTACHMENT_BYTES as usize;
    if size > limit {
        return Err(Error::TooLarge);
    }
    let mut raw = Vec::with_capacity(size);
    while raw.len() < size {
        let offset = raw.len();
        let count = (size - offset).min(DOWNLOAD_CHUNK_SIZE);
        let request_count = if offset + count == size {
            count.saturating_add(1)
        } else {
            count
        };
        // Each chunk has its own idle deadline. A slow but progressing 25 MiB
        // download can take longer than 30 seconds without becoming unbounded.
        let part = bounded(async {
            let query = format!("(UID BODY.PEEK[]<{offset}.{request_count}>)");
            let mut stream = session
                .uid_fetch(item.uid.to_string(), query)
                .await
                .map_err(network)?;
            let mut part = None;
            while let Some(fetch) = stream.try_next().await.map_err(network)? {
                if fetch.uid == Some(item.uid) {
                    part = fetch.body().map(ToOwned::to_owned);
                }
            }
            part.ok_or(Error::Missing)
        })
        .await?;
        if part.len() > count && offset.saturating_add(part.len()) > limit {
            return Err(Error::TooLarge);
        }
        if part.len() != count {
            return Err(Error::Protocol);
        }
        raw.extend_from_slice(&part);
    }
    if Header::parse(&raw).fingerprint() != item.header.fingerprint() {
        return Err(Error::Changed);
    }
    Ok(raw)
}
pub async fn test_connection(email: &str, secret: &str, config: &ConnectionConfig) -> Result<()> {
    let mut session = connect_configured(email, secret, config).await?;
    validate_connection(&mut session).await?;
    let _ = bounded(async { session.logout().await.map_err(network) }).await;
    Ok(())
}

async fn validate_connection<S: AsyncRead + AsyncWrite + Unpin + Debug + Send>(
    session: &mut Session<S>,
) -> Result<()> {
    // LIST still proves the account can enumerate server folders, but only the
    // required INBOX must open. Optional junk folders are isolated during scans.
    let _ = folders(session).await?;
    bounded(async {
        session.examine("INBOX").await.map_err(network)?;
        Ok(())
    })
    .await
}

/// Network credentials never reside in Account or persistence structures.
pub async fn login_account(account: &Account, secret: &str) -> Result<LiveSession> {
    connect_configured(&account.email, secret, &account.connection).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
    type Script = Vec<(String, String)>;
    async fn session(mut steps: Script) -> (Session<DuplexStream>, tokio::task::JoinHandle<()>) {
        let (client, server) = tokio::io::duplex(1024 * 1024);
        steps.insert(
            0,
            (
                "LOGIN \"test\" \"secret\"".into(),
                "{tag} OK login\r\n".into(),
            ),
        );
        let task = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            server.get_mut().write_all(b"* OK mock\r\n").await.unwrap();
            for (expected, reply) in steps {
                let mut line = String::new();
                server.read_line(&mut line).await.unwrap();
                let (tag, command) = line.trim_end().split_once(' ').unwrap();
                assert_eq!(command, expected);
                server
                    .get_mut()
                    .write_all(reply.replace("{tag}", tag).as_bytes())
                    .await
                    .unwrap();
            }
        });
        let mut client = async_imap::Client::new(client);
        client.read_response().await.unwrap().unwrap();
        let session = client
            .login("test", "secret")
            .await
            .map_err(|(error, _)| error)
            .unwrap();
        (session, task)
    }
    fn examined(validity: u32, next: u32) -> String {
        format!("* 1 EXISTS\r\n* OK [UIDVALIDITY {validity}] valid\r\n* OK [UIDNEXT {next}] next\r\n{{tag}} OK [READ-ONLY] done\r\n")
    }
    fn examined_without_uidnext(validity: u32) -> String {
        format!(
            "* 1 EXISTS\r\n* OK [UIDVALIDITY {validity}] valid\r\n{{tag}} OK [READ-ONLY] done\r\n"
        )
    }
    fn header() -> Vec<u8> {
        b"From: hr@example.com\r\nSubject: Interview\r\nDate: Sat, 24 Oct 2026 12:00:00 +0800\r\nMessage-ID: <a@b>\r\n\r\n".to_vec()
    }
    fn candidate() -> Candidate {
        Candidate {
            id: "candidate".into(),
            account_id: "a".into(),
            email: "test@qq.com".into(),
            folder: "INBOX".into(),
            validity: 4,
            uid: 9,
            header: Header::parse(&header()),
            reasons: vec!["Interview".into()],
        }
    }

    #[tokio::test]
    async fn starttls_refusal_never_sends_login_or_credentials() {
        use tokio::io::AsyncReadExt;
        let (stream, mut server) = tokio::io::duplex(2048);
        let task = tokio::spawn(async move {
            server.write_all(b"* OK ready\r\n").await.unwrap();
            let mut reader = BufReader::new(server);
            let mut command = String::new();
            reader.read_line(&mut command).await.unwrap();
            let tag = command.split_whitespace().next().unwrap().to_string();
            assert_eq!(command.trim_end(), format!("{tag} STARTTLS"));
            reader
                .get_mut()
                .write_all(format!("{tag} NO encryption unavailable\r\n").as_bytes())
                .await
                .unwrap();
            let mut remaining = String::new();
            reader.read_to_string(&mut remaining).await.unwrap();
            assert!(remaining.is_empty());
        });
        let mut client = async_imap::Client::new(stream);
        client.read_response().await.unwrap().unwrap();
        assert!(matches!(upgrade_transport(client).await, Err(Error::Tls)));
        task.await.unwrap();
    }
    #[tokio::test]
    async fn netease_identifies_before_opening_mailboxes() {
        let (mut s, task) = session(vec![(
            "ID (\"name\" \"ResumePro\" \"version\" \"0.4\")".into(),
            "* ID NIL\r\n{tag} OK id\r\n".into(),
        )])
        .await;
        identify(&mut s, Provider::N163).await.unwrap();
        task.await.unwrap();
        let (mut s, task) = session(vec![]).await;
        identify(&mut s, Provider::Qq).await.unwrap();
        task.await.unwrap();
    }
    #[tokio::test]
    async fn discovers_special_use_and_chinese_junk_but_not_sent_or_noselect() {
        let (mut s,task) = session(vec![("LIST \"\" *".into(),"* LIST (\\Junk) \"/\" \"Bulk\"\r\n* LIST () \"/\" \"&V4NXPpCuTvY-\"\r\n* LIST () \"/\" \"INBOX/&V4NXPpCuTvY-\"\r\n* LIST (\\Sent) \"/\" \"Sent\"\r\n* LIST (\\Junk \\Noselect) \"/\" \"Hidden\"\r\n{tag} OK list\r\n".into())]).await;
        assert_eq!(
            folders(&mut s).await.unwrap(),
            vec!["INBOX", "Bulk", "&V4NXPpCuTvY-", "INBOX/&V4NXPpCuTvY-"]
        );
        task.await.unwrap();
    }
    #[tokio::test]
    async fn connection_requires_inbox_but_does_not_open_optional_junk() {
        let (mut s, task) = session(vec![
            (
                "LIST \"\" *".into(),
                "* LIST (\\Junk) \"/\" \"Junk\"\r\n{tag} OK list\r\n".into(),
            ),
            ("EXAMINE \"INBOX\"".into(), examined(4, 11)),
        ])
        .await;
        validate_connection(&mut s).await.unwrap();
        task.await.unwrap();
    }
    #[tokio::test]
    async fn first_scan_uses_thirty_day_receive_window_and_uid_snapshot() {
        let (mut s, task) = session(vec![
            ("EXAMINE \"INBOX\"".into(), examined(4, 11)),
            (
                "UID SEARCH SINCE 24-Sep-2026 UID 1:10".into(),
                "* SEARCH 9 2\r\n{tag} OK search\r\n".into(),
            ),
        ])
        .await;
        let scan = plan(&mut s, "INBOX", None, 1790208000 + 30 * 86400)
            .await
            .unwrap();
        assert_eq!(scan.uids, vec![2, 9]);
        assert_eq!(scan.high_uid, 10);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn coremail_without_uidnext_snapshots_the_high_uid_with_search_all() {
        let (mut s, task) = session(vec![
            ("EXAMINE \"INBOX\"".into(), examined_without_uidnext(4)),
            (
                "UID SEARCH ALL".into(),
                "* SEARCH 2 9\r\n{tag} OK all\r\n".into(),
            ),
            (
                "UID SEARCH SINCE 24-Sep-2026 UID 1:9".into(),
                "* SEARCH 9 2\r\n{tag} OK search\r\n".into(),
            ),
        ])
        .await;
        let scan = plan(&mut s, "INBOX", None, 1790208000 + 30 * 86400)
            .await
            .unwrap();
        assert_eq!(scan.high_uid, 9);
        assert_eq!(scan.uids, vec![2, 9]);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn increment_is_uid_based_not_unseen_and_never_reverses_empty_ranges() {
        let (mut s, task) = session(vec![
            ("EXAMINE \"INBOX\"".into(), examined(4, 11)),
            (
                "UID SEARCH UID 9:10".into(),
                "* SEARCH 10\r\n{tag} OK search\r\n".into(),
            ),
        ])
        .await;
        let scan = plan(
            &mut s,
            "INBOX",
            Some(Cursor {
                validity: 4,
                uid: 8,
            }),
            0,
        )
        .await
        .unwrap();
        assert_eq!(scan.uids, vec![10]);
        task.await.unwrap();
        let (mut s, task) = session(vec![("EXAMINE \"INBOX\"".into(), examined(4, 11))]).await;
        assert!(plan(
            &mut s,
            "INBOX",
            Some(Cursor {
                validity: 4,
                uid: 10
            }),
            0
        )
        .await
        .unwrap()
        .uids
        .is_empty());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn changed_uidvalidity_rescans_recent_window() {
        let (mut s, task) = session(vec![
            ("EXAMINE \"INBOX\"".into(), examined(5, 11)),
            (
                "UID SEARCH SINCE 24-Sep-2026 UID 1:10".into(),
                "* SEARCH 1\r\n{tag} OK search\r\n".into(),
            ),
        ])
        .await;
        let scan = plan(
            &mut s,
            "INBOX",
            Some(Cursor {
                validity: 4,
                uid: 900,
            }),
            1790208000 + 30 * 86400,
        )
        .await
        .unwrap();
        assert_eq!(scan.validity, 5);
        assert_eq!(scan.uids, vec![1]);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn discovery_requests_only_selected_headers_with_peek() {
        let raw = header();
        let reply = format!("* 1 FETCH (UID 9 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]<0> {{{}}}\r\n{})\r\n{{tag}} OK fetched\r\n",raw.len(),String::from_utf8_lossy(&raw));
        let (mut s, task) = session(vec![(format!("UID FETCH 9 {HEADER_QUERY}"), reply)]).await;
        let found = headers(&mut s, &[9]).await.unwrap();
        assert_eq!(found[0].1.message_id.as_deref(), Some("a@b"));
        task.await.unwrap();
    }
    #[tokio::test]
    async fn oversized_header_is_skipped_without_hiding_later_uids() {
        let huge = vec![b'x'; 65536];
        let normal = header();
        let reply = format!(
            "* 1 FETCH (UID 9 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]<0> {{{}}}\r\n{})\r\n* 2 FETCH (UID 10 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]<0> {{{}}}\r\n{})\r\n{{tag}} OK fetched\r\n",
            huge.len(), String::from_utf8_lossy(&huge), normal.len(), String::from_utf8_lossy(&normal)
        );
        let huge_reply = format!(
            "* 1 FETCH (UID 9 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]<0> {{{}}}\r\n{})\r\n{{tag}} OK fetched\r\n",
            huge.len(), String::from_utf8_lossy(&huge)
        );
        let normal_reply = format!(
            "* 1 FETCH (UID 10 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]<0> {{{}}}\r\n{})\r\n{{tag}} OK fetched\r\n",
            normal.len(), String::from_utf8_lossy(&normal)
        );
        let (mut s, task) = session(vec![
            (format!("UID FETCH 9,10 {HEADER_QUERY}"), reply),
            (format!("UID FETCH 9 {HEADER_QUERY}"), huge_reply),
            (format!("UID FETCH 10 {HEADER_QUERY}"), normal_reply),
        ])
        .await;
        let found = headers_resilient(&mut s, &[9, 10]).await.unwrap();
        assert_eq!(found.headers.len(), 1);
        assert_eq!(found.headers[0].0, 10);
        assert_eq!(found.terminal_uids, vec![9]);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn one_live_uid_without_a_header_does_not_hide_the_rest_of_the_batch() {
        let normal = header();
        let normal_reply = format!("* 1 FETCH (UID 10 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]<0> {{{}}}\r\n{})\r\n{{tag}} OK fetched\r\n", normal.len(), String::from_utf8_lossy(&normal));
        let (mut s, task) = session(vec![
            (
                format!("UID FETCH 9,10 {HEADER_QUERY}"),
                normal_reply.clone(),
            ),
            (
                "UID SEARCH UID 9".into(),
                "* SEARCH 9\r\n{tag} OK search\r\n".into(),
            ),
            (
                format!("UID FETCH 9 {HEADER_QUERY}"),
                "{tag} OK fetched\r\n".into(),
            ),
            (
                "UID SEARCH UID 9".into(),
                "* SEARCH 9\r\n{tag} OK search\r\n".into(),
            ),
            (format!("UID FETCH 10 {HEADER_QUERY}"), normal_reply),
        ])
        .await;
        let found = headers_resilient(&mut s, &[9, 10]).await.unwrap();
        assert_eq!(
            found
                .headers
                .iter()
                .map(|(uid, _)| *uid)
                .collect::<Vec<_>>(),
            vec![10]
        );
        assert_eq!(found.retry_uids, vec![9]);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn batch_protocol_fallback_is_bounded_and_defers_the_rest() {
        let uids: Vec<u32> = (1..=10).collect();
        let set = uids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let search = uids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(" ");
        let mut script = vec![
            (
                format!("UID FETCH {set} {HEADER_QUERY}"),
                "{tag} OK fetched\r\n".into(),
            ),
            (
                format!("UID SEARCH UID {set}"),
                format!("* SEARCH {search}\r\n{{tag}} OK search\r\n"),
            ),
        ];
        for uid in uids.iter().take(HEADER_RETRY_BUDGET) {
            script.push((
                format!("UID FETCH {uid} {HEADER_QUERY}"),
                "{tag} OK fetched\r\n".into(),
            ));
            script.push((
                format!("UID SEARCH UID {uid}"),
                format!("* SEARCH {uid}\r\n{{tag}} OK search\r\n"),
            ));
        }
        let (mut s, task) = session(script).await;
        let batch = headers_resilient(&mut s, &uids).await.unwrap();
        assert!(batch.headers.is_empty());
        assert_eq!(batch.retry_uids, uids[..HEADER_RETRY_BUDGET]);
        assert_eq!(batch.deferred_uids, uids[HEADER_RETRY_BUDGET..]);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn a_fetch_without_header_cannot_advance_a_live_uid() {
        let (mut s, task) = session(vec![
            (
                format!("UID FETCH 9 {HEADER_QUERY}"),
                "{tag} OK fetched\r\n".into(),
            ),
            (
                "UID SEARCH UID 9".into(),
                "* SEARCH 9\r\n{tag} OK search\r\n".into(),
            ),
        ])
        .await;
        assert_eq!(headers(&mut s, &[9]).await.unwrap_err(), Error::Protocol);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn a_message_expunged_mid_scan_is_safe_to_skip() {
        let (mut s, task) = session(vec![
            (
                format!("UID FETCH 9 {HEADER_QUERY}"),
                "{tag} OK fetched\r\n".into(),
            ),
            (
                "UID SEARCH UID 9".into(),
                "* SEARCH\r\n{tag} OK search\r\n".into(),
            ),
        ])
        .await;
        assert!(headers(&mut s, &[9]).await.unwrap().is_empty());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn confirmation_peeks_the_bounded_original_and_validates_identity() {
        let mut raw = header();
        raw.extend_from_slice(b"Interview details.");
        let size_reply = format!(
            "* 1 FETCH (UID 9 RFC822.SIZE {})\r\n{{tag}} OK size\r\n",
            raw.len()
        );
        let body_reply = format!(
            "* 1 FETCH (UID 9 BODY[]<0> {{{}}}\r\n{})\r\n{{tag}} OK fetched\r\n",
            raw.len(),
            String::from_utf8_lossy(&raw)
        );
        let (mut s, task) = session(vec![
            ("EXAMINE \"INBOX\"".into(), examined(4, 11)),
            ("UID FETCH 9 (UID RFC822.SIZE)".into(), size_reply),
            (
                format!("UID FETCH 9 (UID BODY.PEEK[]<0.{}>)", raw.len() + 1),
                body_reply,
            ),
        ])
        .await;
        assert_eq!(download(&mut s, &candidate()).await.unwrap(), raw);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn confirmation_downloads_large_mail_in_progress_bounded_chunks() {
        let mut raw = header();
        raw.resize(DOWNLOAD_CHUNK_SIZE + 17, b'x');
        let first = &raw[..DOWNLOAD_CHUNK_SIZE];
        let second = &raw[DOWNLOAD_CHUNK_SIZE..];
        let size_reply = format!(
            "* 1 FETCH (UID 9 RFC822.SIZE {})\r\n{{tag}} OK size\r\n",
            raw.len()
        );
        let first_reply = format!(
            "* 1 FETCH (UID 9 BODY[]<0> {{{}}}\r\n{})\r\n{{tag}} OK first\r\n",
            first.len(),
            String::from_utf8_lossy(first)
        );
        let second_reply = format!(
            "* 1 FETCH (UID 9 BODY[]<{}> {{{}}}\r\n{})\r\n{{tag}} OK second\r\n",
            DOWNLOAD_CHUNK_SIZE,
            second.len(),
            String::from_utf8_lossy(second)
        );
        let (mut s, task) = session(vec![
            ("EXAMINE \"INBOX\"".into(), examined(4, 11)),
            ("UID FETCH 9 (UID RFC822.SIZE)".into(), size_reply),
            (
                format!("UID FETCH 9 (UID BODY.PEEK[]<0.{DOWNLOAD_CHUNK_SIZE}>)"),
                first_reply,
            ),
            (
                format!("UID FETCH 9 (UID BODY.PEEK[]<{DOWNLOAD_CHUNK_SIZE}.18>)"),
                second_reply,
            ),
        ])
        .await;
        assert_eq!(download(&mut s, &candidate()).await.unwrap(), raw);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn confirmation_never_downloads_a_reused_uid_after_rebuild() {
        let (mut s, task) = session(vec![("EXAMINE \"INBOX\"".into(), examined(5, 11))]).await;
        assert_eq!(
            download(&mut s, &candidate()).await.unwrap_err(),
            Error::Changed
        );
        task.await.unwrap();
    }
    #[tokio::test]
    async fn disconnected_literal_is_a_failure_not_a_successful_empty_scan() {
        let (mut s, task) = session(vec![(
            format!("UID FETCH 9 {HEADER_QUERY}"),
            "* 1 FETCH (UID 9 BODY[HEADER] {100}\r\npartial".into(),
        )])
        .await;
        assert!(headers(&mut s, &[9]).await.is_err());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn confirmation_rejects_oversize_metadata_without_saving_a_truncated_mail() {
        let (mut s, task) = session(vec![
            ("EXAMINE \"INBOX\"".into(), examined(4, 11)),
            (
                "UID FETCH 9 (UID RFC822.SIZE)".into(),
                "* 1 FETCH (UID 9 RFC822.SIZE 26214402)\r\n{tag} OK size\r\n".into(),
            ),
        ])
        .await;
        assert_eq!(
            download(&mut s, &candidate()).await.unwrap_err(),
            Error::TooLarge
        );
        task.await.unwrap();
    }
    #[tokio::test]
    async fn confirmation_rejects_size_metadata_that_would_truncate_the_message() {
        let mut raw = header();
        raw.extend_from_slice(b"x");
        let declared = raw.len() - 1;
        let size_reply = format!("* 1 FETCH (UID 9 RFC822.SIZE {declared})\r\n{{tag}} OK size\r\n");
        let body_reply = format!(
            "* 1 FETCH (UID 9 BODY[]<0> {{{}}}\r\n{})\r\n{{tag}} OK body\r\n",
            raw.len(),
            String::from_utf8_lossy(&raw)
        );
        let (mut s, task) = session(vec![
            ("EXAMINE \"INBOX\"".into(), examined(4, 11)),
            ("UID FETCH 9 (UID RFC822.SIZE)".into(), size_reply),
            (
                format!("UID FETCH 9 (UID BODY.PEEK[]<0.{}>)", raw.len()),
                body_reply,
            ),
        ])
        .await;
        assert_eq!(
            download(&mut s, &candidate()).await.unwrap_err(),
            Error::Protocol
        );
        task.await.unwrap();
    }
    #[tokio::test]
    async fn confirmation_rejects_a_different_message_even_if_the_server_reuses_its_uid() {
        let raw = String::from_utf8(header())
            .unwrap()
            .replace("a@b", "wrong@message");
        let size_reply = format!(
            "* 1 FETCH (UID 9 RFC822.SIZE {})\r\n{{tag}} OK size\r\n",
            raw.len()
        );
        let body_reply = format!(
            "* 1 FETCH (UID 9 BODY[]<0> {{{}}}\r\n{})\r\n{{tag}} OK fetched\r\n",
            raw.len(),
            raw
        );
        let (mut s, task) = session(vec![
            ("EXAMINE \"INBOX\"".into(), examined(4, 11)),
            ("UID FETCH 9 (UID RFC822.SIZE)".into(), size_reply),
            (
                format!("UID FETCH 9 (UID BODY.PEEK[]<0.{}>)", raw.len() + 1),
                body_reply,
            ),
        ])
        .await;
        assert_eq!(
            download(&mut s, &candidate()).await.unwrap_err(),
            Error::Changed
        );
        task.await.unwrap();
    }
}
