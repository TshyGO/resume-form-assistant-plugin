use crate::source::{MessageLocator, Metadata, Position, SourceKind};
use crate::{
    retry_delay, ConnectionConfig, Error, Header, Provider, Result, CHECK_INTERVAL, FAILURE_LIMIT,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub email: String,
    pub provider: Provider,
    pub connection: Option<ConnectionConfig>,
    pub source: SourceKind,
    pub source_account_id: Option<String>,
    pub paused: bool,
    pub failures: u32,
    pub last_error: Option<String>,
    pub last_checked: Option<i64>,
    pub next_check: i64,
    pub header_issues: u32,
}
impl Account {
    pub fn credential_id(&self) -> String {
        format!("mailbox:{}", self.id)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub validity: u32,
    pub uid: u32,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeaderRetry {
    pub uid: u32,
    pub attempts: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub account_id: String,
    pub email: String,
    pub locator: MessageLocator,
    pub header: Header,
    pub reasons: Vec<String>,
}
/// Valid candidates and corruption counts from the same read snapshot. Invalid
/// rows are retained for repair; no source locator is guessed on decode failure.
pub struct PendingCandidates {
    pub candidates: Vec<Candidate>,
    pub pending_count: u32,
    pub invalid_count: u32,
}
pub struct Database(Connection, #[cfg(test)] std::cell::Cell<usize>);
impl Database {
    /// Outside archive directories and the backup allowlist. No secrets or bodies.
    pub fn open(data_root: &Path) -> Result<Self> {
        let path = data_root.join("mailboxes.sqlite");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path).map_err(|_| Error::Storage)?;
        let conn = Connection::open(&path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, paused INTEGER NOT NULL DEFAULT 0,
                failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_checked INTEGER,
                next_check INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS cursors (
                archive TEXT NOT NULL, account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                folder TEXT NOT NULL, validity INTEGER NOT NULL, uid INTEGER NOT NULL,
                PRIMARY KEY(archive,account,folder));
            CREATE TABLE IF NOT EXISTS candidates (
                id TEXT PRIMARY KEY, archive TEXT NOT NULL,
                account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                fingerprint TEXT NOT NULL, folder TEXT NOT NULL, validity INTEGER NOT NULL, uid INTEGER NOT NULL,
                header TEXT NOT NULL, reasons TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('pending','ignored','imported')),
                UNIQUE(archive,account,fingerprint));
            CREATE TABLE IF NOT EXISTS header_retries (
                archive TEXT NOT NULL,
                account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                folder TEXT NOT NULL, validity INTEGER NOT NULL, uid INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY(archive,account,folder,validity,uid));
            CREATE INDEX IF NOT EXISTS candidate_pending ON candidates(archive,state);")?;
        let has_connection = conn
            .prepare("PRAGMA table_info(accounts)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .iter()
            .any(|s| s == "connection");
        if !has_connection {
            conn.execute("ALTER TABLE accounts ADD COLUMN connection TEXT", [])?;
        }
        let has_source = conn
            .prepare("PRAGMA table_info(accounts)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .iter()
            .any(|s| s == "source");
        if !has_source {
            // Keep account IDs and every child row intact. Email is a display/login
            // address; an API principal, connector and local account are distinct.
            conn.execute_batch("PRAGMA foreign_keys=OFF;")?;
            let migration = (|| -> Result<()> {
                let tx = conn.unchecked_transaction()?;
                tx.execute_batch("CREATE TABLE accounts_v2 (
                    id TEXT PRIMARY KEY, email TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
                    failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_checked INTEGER,
                    next_check INTEGER NOT NULL DEFAULT 0, connection TEXT,
                    source TEXT NOT NULL DEFAULT 'imap', source_account_id TEXT);
                    INSERT INTO accounts_v2(id,email,paused,failures,last_error,last_checked,next_check,connection)
                    SELECT id,email,paused,failures,last_error,last_checked,next_check,connection FROM accounts;
                    DROP TABLE accounts;
                    ALTER TABLE accounts_v2 RENAME TO accounts;
                    CREATE UNIQUE INDEX imap_email ON accounts(email) WHERE source='imap';
                    CREATE UNIQUE INDEX api_principal ON accounts(source,source_account_id) WHERE source<>'imap';
                    ALTER TABLE candidates ADD COLUMN locator TEXT;")?;
                tx.execute_batch("CREATE TABLE IF NOT EXISTS source_positions (
                    archive TEXT NOT NULL, account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                    scope TEXT NOT NULL, position TEXT NOT NULL,
                    PRIMARY KEY(archive,account,scope));")?;
                tx.commit()?;
                Ok(())
            })();
            conn.execute_batch("PRAGMA foreign_keys=ON;")?;
            migration?;
        }
        // Derived, machine-local validation cache. Increment its version if the
        // candidate decoder/validation contract changes. Triggers invalidate
        // only affected rows, including writes from another connection.
        let tx = conn.unchecked_transaction()?;
        let has_health: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='candidate_health_v1')", [], |r| r.get(0))?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS candidate_health_v1 (
            candidate TEXT PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
            valid INTEGER CHECK(valid IN (0,1)));
            CREATE TRIGGER IF NOT EXISTS candidate_health_insert AFTER INSERT ON candidates BEGIN
                INSERT INTO candidate_health_v1(candidate,valid) VALUES (NEW.id,NULL); END;
            CREATE TRIGGER IF NOT EXISTS candidate_health_update AFTER UPDATE OF id,account,folder,validity,uid,header,reasons,locator ON candidates BEGIN
                DELETE FROM candidate_health_v1 WHERE candidate=OLD.id;
                INSERT INTO candidate_health_v1(candidate,valid) VALUES (NEW.id,NULL); END;
            CREATE TRIGGER IF NOT EXISTS candidate_health_source AFTER UPDATE OF source ON accounts
            WHEN NEW.source IS NOT OLD.source BEGIN
                UPDATE candidate_health_v1 SET valid=NULL WHERE candidate IN (SELECT id FROM candidates WHERE account=NEW.id); END;")?;
        if !has_health {
            tx.execute(
                "INSERT INTO candidate_health_v1(candidate,valid) SELECT id,NULL FROM candidates",
                [],
            )?;
        }
        tx.commit()?;
        #[cfg(test)]
        let db = Self(conn, std::cell::Cell::new(0));
        #[cfg(not(test))]
        let db = Self(conn);
        Ok(db)
    }
    pub fn accounts(&self) -> Result<Vec<Account>> {
        self.query_accounts(None)
    }
    fn query_accounts(&self, id: Option<&str>) -> Result<Vec<Account>> {
        let condition = if id.is_some() {
            "WHERE id=?1"
        } else {
            "WHERE ?1 IS NULL ORDER BY email,id"
        };
        let sql = format!("SELECT id,email,paused,failures,last_error,last_checked,next_check,connection,source,source_account_id FROM accounts {condition}");
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, Option<String>>(9)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                email,
                mut paused,
                failures,
                mut last_error,
                last_checked,
                next_check,
                connection,
                source,
                source_account_id,
            ) = row?;
            let source = SourceKind::from_db(&source).unwrap_or(SourceKind::Unknown);
            if source == SourceKind::Unknown {
                paused = true;
                last_error = Some(Error::UnsupportedSource.to_string());
            }
            let connection = if source == SourceKind::Imap {
                let checked = match connection {
                    Some(json) => serde_json::from_str::<ConnectionConfig>(&json)
                        .map_err(|_| Error::Configuration)
                        .and_then(|config| config.validated(&email)),
                    None => ConnectionConfig::preset(&email),
                };
                match checked {
                    Ok(config) => Some(config),
                    Err(_) => {
                        // Keep this account visible and recoverable, but never
                        // authenticate using a guessed/default destination.
                        paused = true;
                        last_error = Some(Error::Configuration.to_string());
                        None
                    }
                }
            } else {
                None
            };
            let provider = Provider::detect(&email).map_or(Provider::Custom, |(_, p)| p);
            Ok(Account {
                id,
                email,
                provider,
                connection,
                source,
                source_account_id,
                paused,
                failures,
                last_error,
                last_checked,
                next_check,
                header_issues: 0,
            })
        })
        .collect()
    }
    pub fn account(&self, id: &str) -> Result<Account> {
        self.query_accounts(Some(id))?
            .into_iter()
            .next()
            .ok_or(Error::Missing)
    }
    pub fn save_account(&self, id: &str, email: &str) -> Result<Account> {
        self.save_configured_account(id, email, &ConnectionConfig::preset(email)?)
    }
    pub fn save_configured_account(
        &self,
        id: &str,
        email: &str,
        connection: &ConnectionConfig,
    ) -> Result<Account> {
        let email = crate::config::normalize_email(email)?;
        let connection = connection.clone().validated(&email)?;
        let previous = self
            .accounts()?
            .into_iter()
            .find(|a| a.email == email && a.source == SourceKind::Imap);
        let json = serde_json::to_string(&connection).map_err(|_| Error::Storage)?;
        let tx = self.0.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO accounts(id,email,connection) VALUES (?1,?2,?3)
            ON CONFLICT(email) WHERE source='imap' DO UPDATE SET connection=excluded.connection,paused=0,failures=0,last_error=NULL,next_check=0",
            params![id, email, json],
        )?;
        // UID identities belong to an endpoint + login, not just an email address.
        if let Some(old) = previous.filter(|a| {
            !a.connection
                .as_ref()
                .is_some_and(|c| c.same_endpoint(&connection))
        }) {
            tx.execute(
                "UPDATE accounts SET last_checked=NULL WHERE id=?1",
                [&old.id],
            )?;
            tx.execute("DELETE FROM cursors WHERE account=?1", [&old.id])?;
            tx.execute("DELETE FROM candidates WHERE account=?1", [&old.id])?;
            tx.execute("DELETE FROM header_retries WHERE account=?1", [&old.id])?;
        }
        tx.commit()?;
        self.accounts()?
            .into_iter()
            .find(|a| a.email == email && a.source == SourceKind::Imap)
            .ok_or(Error::Storage)
    }
    pub fn delete_account(&self, id: &str) -> Result<()> {
        self.0.execute("DELETE FROM accounts WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn success(&self, id: &str, now: i64) -> Result<()> {
        self.0.execute("UPDATE accounts SET failures=0,last_error=NULL,last_checked=?2,next_check=?3 WHERE id=?1", params![id,now,now+CHECK_INTERVAL])?;
        Ok(())
    }
    pub fn failure(&self, id: &str, error: Error, now: i64) -> Result<()> {
        let failures = self.account(id)?.failures.saturating_add(1);
        self.0.execute(
            "UPDATE accounts SET failures=?2,last_error=?3,paused=?4,next_check=?5 WHERE id=?1",
            params![
                id,
                failures,
                error.to_string(),
                failures >= FAILURE_LIMIT,
                now + retry_delay(failures)
            ],
        )?;
        Ok(())
    }
    pub fn partial_failure(&self, id: &str, error: Error, now: i64) -> Result<()> {
        self.0.execute(
            "UPDATE accounts SET failures=0,last_error=?2,paused=0,next_check=?3 WHERE id=?1",
            params![id, error.to_string(), now + 60],
        )?;
        Ok(())
    }
    pub fn pause(&self, id: &str, paused: bool) -> Result<()> {
        self.0.execute(
            "UPDATE accounts SET paused=?2,failures=0,next_check=0 WHERE id=?1",
            params![id, paused],
        )?;
        Ok(())
    }
    pub fn cursor(&self, archive: &str, account: &str, folder: &str) -> Result<Option<Cursor>> {
        Ok(self
            .0
            .query_row(
                "SELECT validity,uid FROM cursors WHERE archive=?1 AND account=?2 AND folder=?3",
                params![archive, account, folder],
                |r| {
                    Ok(Cursor {
                        validity: r.get(0)?,
                        uid: r.get(1)?,
                    })
                },
            )
            .optional()?)
    }
    pub fn prepare_header_retries(
        &self,
        archive: &str,
        account: &str,
        folder: &str,
        validity: u32,
        limit: u32,
    ) -> Result<Vec<HeaderRetry>> {
        self.0.execute(
            "DELETE FROM header_retries WHERE archive=?1 AND account=?2 AND folder=?3 AND validity<>?4",
            params![archive, account, folder, validity],
        )?;
        let mut stmt = self.0.prepare(
            "SELECT uid,attempts FROM header_retries
             WHERE archive=?1 AND account=?2 AND folder=?3 AND validity=?4 AND attempts<?5
             ORDER BY uid LIMIT ?6",
        )?;
        let rows = stmt.query_map(
            params![
                archive,
                account,
                folder,
                validity,
                FAILURE_LIMIT,
                limit.max(1)
            ],
            |row| {
                Ok(HeaderRetry {
                    uid: row.get(0)?,
                    attempts: row.get(1)?,
                })
            },
        )?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn record_header_failure(
        &self,
        archive: &str,
        account: &str,
        folder: &str,
        validity: u32,
        uid: u32,
    ) -> Result<u32> {
        self.0.execute(
            "INSERT INTO header_retries(archive,account,folder,validity,uid,attempts)
             VALUES (?1,?2,?3,?4,?5,1)
             ON CONFLICT(archive,account,folder,validity,uid)
             DO UPDATE SET attempts=MIN(attempts+1,?6)",
            params![archive, account, folder, validity, uid, FAILURE_LIMIT],
        )?;
        Ok(self.0.query_row(
            "SELECT attempts FROM header_retries
             WHERE archive=?1 AND account=?2 AND folder=?3 AND validity=?4 AND uid=?5",
            params![archive, account, folder, validity, uid],
            |row| row.get(0),
        )?)
    }
    pub fn defer_header_retry(
        &self,
        archive: &str,
        account: &str,
        folder: &str,
        validity: u32,
        uid: u32,
    ) -> Result<()> {
        self.0.execute(
            "INSERT INTO header_retries(archive,account,folder,validity,uid,attempts)
             VALUES (?1,?2,?3,?4,?5,0)
             ON CONFLICT(archive,account,folder,validity,uid) DO NOTHING",
            params![archive, account, folder, validity, uid],
        )?;
        Ok(())
    }
    pub fn mark_header_terminal(
        &self,
        archive: &str,
        account: &str,
        folder: &str,
        validity: u32,
        uid: u32,
    ) -> Result<()> {
        self.0.execute(
            "INSERT INTO header_retries(archive,account,folder,validity,uid,attempts)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(archive,account,folder,validity,uid)
             DO UPDATE SET attempts=?6",
            params![archive, account, folder, validity, uid, FAILURE_LIMIT],
        )?;
        Ok(())
    }
    pub fn clear_header_retry(
        &self,
        archive: &str,
        account: &str,
        folder: &str,
        validity: u32,
        uid: u32,
    ) -> Result<()> {
        self.0.execute(
            "DELETE FROM header_retries
             WHERE archive=?1 AND account=?2 AND folder=?3 AND validity=?4 AND uid=?5",
            params![archive, account, folder, validity, uid],
        )?;
        Ok(())
    }
    pub fn header_issue_count(&self, archive: &str, account: &str) -> Result<u32> {
        Ok(self.0.query_row(
            "SELECT COUNT(*) FROM header_retries WHERE archive=?1 AND account=?2 AND attempts>=?3",
            params![archive, account, FAILURE_LIMIT],
            |row| row.get(0),
        )?)
    }
    pub fn commit_header_retry(
        &mut self,
        archive: &str,
        account: &str,
        folder: &str,
        validity: u32,
        uid: u32,
        found: Option<(Header, Vec<String>)>,
    ) -> Result<()> {
        if self.account(account)?.source != SourceKind::Imap {
            return Err(Error::Changed);
        }
        let tx = self.0.transaction()?;
        if let Some((header, reasons)) = found.filter(|(_, reasons)| !reasons.is_empty()) {
            tx.execute(
                "INSERT INTO candidates(id,archive,account,fingerprint,folder,validity,uid,header,reasons,state)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending')
                 ON CONFLICT(archive,account,fingerprint) DO UPDATE SET
                 folder=excluded.folder,validity=excluded.validity,uid=excluded.uid,
                 header=excluded.header,reasons=excluded.reasons,locator=NULL",
                params![
                    uuid::Uuid::new_v4().to_string(), archive, account, header.fingerprint(), folder,
                    validity, uid, serde_json::to_string(&header).map_err(|_| Error::Storage)?,
                    serde_json::to_string(&reasons).map_err(|_| Error::Storage)?
                ],
            )?;
        }
        tx.execute(
            "DELETE FROM header_retries
             WHERE archive=?1 AND account=?2 AND folder=?3 AND validity=?4 AND uid=?5",
            params![archive, account, folder, validity, uid],
        )?;
        tx.commit()?;
        Ok(())
    }
    /// One transaction: never persist progress before the corresponding candidates.
    /// Only matched headers are provided; unmatched headers never reach SQLite.
    pub fn commit_scan(
        &mut self,
        archive: &str,
        account: &str,
        folder: &str,
        cursor: Cursor,
        found: &[(u32, Header, Vec<String>)],
    ) -> Result<()> {
        let messages: Vec<_> = found
            .iter()
            .map(|(uid, header, reasons)| {
                (
                    Metadata {
                        locator: MessageLocator::Imap {
                            folder: folder.into(),
                            validity: cursor.validity,
                            uid: *uid,
                        },
                        header: header.clone(),
                    },
                    reasons.clone(),
                )
            })
            .collect();
        self.commit_metadata(archive, account, folder, &Position::Imap(cursor), &messages)
    }

    /// Candidates and progress become durable together, including empty pages.
    pub fn commit_metadata(
        &mut self,
        archive: &str,
        account: &str,
        scope: &str,
        position: &Position,
        found: &[(Metadata, Vec<String>)],
    ) -> Result<()> {
        let owner = self.account(account)?;
        position.validate(owner.source)?;
        for (message, _) in found {
            message.locator.validate(owner.source)?;
        }
        let tx = self.0.transaction()?;
        for (message, reasons) in found {
            if reasons.is_empty() {
                continue;
            }
            let (folder, validity, uid) = match &message.locator {
                MessageLocator::Imap {
                    folder,
                    validity,
                    uid,
                } => (folder.as_str(), *validity, *uid),
                MessageLocator::Api { .. } => (scope, 0, 0),
            };
            tx.execute("INSERT INTO candidates(id,archive,account,fingerprint,folder,validity,uid,header,reasons,state,locator)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending',?10)
                ON CONFLICT(archive,account,fingerprint) DO UPDATE SET
                    folder=excluded.folder,validity=excluded.validity,uid=excluded.uid,
                    header=excluded.header,reasons=excluded.reasons,locator=excluded.locator",
                params![uuid::Uuid::new_v4().to_string(),archive,account,message.header.fingerprint(),folder,validity,uid,
                    serde_json::to_string(&message.header).map_err(|_| Error::Storage)?,
                    serde_json::to_string(reasons).map_err(|_| Error::Storage)?,
                    serde_json::to_string(&message.locator).map_err(|_| Error::Storage)?])?;
        }
        match position {
            Position::Imap(cursor) => {
                tx.execute("INSERT INTO cursors(archive,account,folder,validity,uid) VALUES (?1,?2,?3,?4,?5)
                    ON CONFLICT(archive,account,folder) DO UPDATE SET validity=excluded.validity,uid=excluded.uid",
                    params![archive,account,scope,cursor.validity,cursor.uid])?;
            }
            Position::Api { .. } => {
                tx.execute("INSERT INTO source_positions(archive,account,scope,position) VALUES (?1,?2,?3,?4)
                    ON CONFLICT(archive,account,scope) DO UPDATE SET position=excluded.position",
                    params![archive,account,scope,serde_json::to_string(position).map_err(|_| Error::Storage)?])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn source_position(
        &self,
        archive: &str,
        account: &str,
        scope: &str,
    ) -> Result<Option<Position>> {
        let raw: Option<String> = self.0.query_row(
            "SELECT position FROM source_positions WHERE archive=?1 AND account=?2 AND scope=?3",
            params![archive,account,scope], |r| r.get(0)).optional()?;
        raw.map(|json| serde_json::from_str(&json).map_err(|_| Error::Storage))
            .transpose()
    }
    /// Called only after the connector has authenticated. Tokens stay in the OS
    /// credential store under credential_id(), never in this database.
    pub fn save_api_account(
        &self,
        id: &str,
        email: &str,
        source: SourceKind,
        principal: &str,
    ) -> Result<Account> {
        // Stable provider identities are opaque. Reject malformed input instead
        // of silently changing it or registering a whitespace variant as an alias.
        if !source.is_api()
            || principal.is_empty()
            || principal.trim() != principal
            || principal.chars().any(char::is_control)
            || principal.len() > 1024
        {
            return Err(Error::Configuration);
        }
        let email = crate::config::normalize_address(email)?;
        self.0.execute(
            "INSERT INTO accounts(id,email,source,source_account_id) VALUES (?1,?2,?3,?4)
            ON CONFLICT(source,source_account_id) WHERE source<>'imap' DO UPDATE SET
            email=excluded.email,paused=0,failures=0,last_error=NULL,next_check=0",
            params![id, email, source.as_db(), principal],
        )?;
        self.accounts()?
            .into_iter()
            .find(|a| a.source == source && a.source_account_id.as_deref() == Some(principal))
            .ok_or(Error::Storage)
    }
    fn decode_locator(
        json: Option<String>,
        folder: String,
        validity: u32,
        uid: u32,
    ) -> Result<MessageLocator> {
        match json {
            Some(json) => serde_json::from_str(&json).map_err(|_| Error::Storage),
            None => Ok(MessageLocator::Imap {
                folder,
                validity,
                uid,
            }),
        }
    }
    fn read_candidate(
        r: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<(
        String,
        String,
        String,
        String,
        u32,
        u32,
        String,
        String,
        Option<String>,
    )> {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
            r.get(7)?,
            r.get(8)?,
        ))
    }
    fn decode_candidate(&self, row: &rusqlite::Row<'_>) -> Result<Candidate> {
        #[cfg(test)]
        self.1.set(self.1.get() + 1);
        let (id, account_id, email, folder, validity, uid, header, reasons, locator) =
            Self::read_candidate(row)?;
        let source = SourceKind::from_db(&row.get::<_, String>(9)?)?;
        let locator = Self::decode_locator(locator, folder, validity, uid)?;
        locator.validate(source).map_err(|_| Error::Storage)?;
        Ok(Candidate {
            id,
            account_id,
            email,
            locator,
            header: serde_json::from_str(&header).map_err(|_| Error::Storage)?,
            reasons: serde_json::from_str(&reasons).map_err(|_| Error::Storage)?,
        })
    }
    pub fn pending(&self, archive: &str, limit: u32) -> Result<Vec<Candidate>> {
        Ok(self.pending_with_issues(archive, limit)?.candidates)
    }
    #[cfg(test)]
    pub(crate) fn decoded_candidate_count(&self) -> usize {
        self.1.get()
    }

    pub fn pending_with_issues(&self, archive: &str, limit: u32) -> Result<PendingCandidates> {
        let tx = self.0.unchecked_transaction()?;
        // Only unvalidated/changed pending rows require full decoding. Raw IO
        // failures still abort; malformed content is retained and counted.
        {
            let mut stmt = tx.prepare("SELECT c.id,c.account,a.email,c.folder,c.validity,c.uid,c.header,c.reasons,c.locator,a.source
                FROM candidates c JOIN accounts a ON a.id=c.account
                JOIN candidate_health_v1 h ON h.candidate=c.id
                WHERE c.archive=?1 AND c.state='pending' AND h.valid IS NULL")?;
            let mut rows = stmt.query([archive])?;
            let mut health = Vec::new();
            while let Some(row) = rows.next()? {
                health.push((row.get::<_, String>(0)?, self.decode_candidate(row).is_ok()));
            }
            drop(rows);
            drop(stmt);
            for (id, valid) in health {
                tx.execute(
                    "UPDATE candidate_health_v1 SET valid=?2 WHERE candidate=?1",
                    params![id, valid],
                )?;
            }
        }
        let mut page = PendingCandidates {
            candidates: Vec::new(),
            pending_count: 0,
            invalid_count: 0,
        };
        let limit = limit.min(2000) as usize;
        let mut before = i64::MAX;
        // Limit the materialized list in SQL. Recheck its content before
        // returning it; even a stale/damaged cache flag must not hide all rows
        // or permit an invalid locator to be used.
        while page.candidates.len() < limit {
            let mut bad = Vec::new();
            let mut read = 0;
            {
                let mut stmt = tx.prepare("SELECT c.id,c.account,a.email,c.folder,c.validity,c.uid,c.header,c.reasons,c.locator,a.source,c.rowid
                    FROM candidates c JOIN accounts a ON a.id=c.account
                    JOIN candidate_health_v1 h ON h.candidate=c.id
                    WHERE c.archive=?1 AND c.state='pending' AND h.valid=1 AND c.rowid<?3
                    ORDER BY c.rowid DESC LIMIT ?2")?;
                let mut rows = stmt.query(params![
                    archive,
                    (limit - page.candidates.len()) as u32,
                    before
                ])?;
                while let Some(row) = rows.next()? {
                    read += 1;
                    before = row.get(10)?;
                    match self.decode_candidate(row) {
                        Ok(item) => page.candidates.push(item),
                        Err(_) => bad.push(row.get::<_, String>(0)?),
                    }
                }
            }
            for id in bad {
                tx.execute(
                    "UPDATE candidate_health_v1 SET valid=0 WHERE candidate=?1",
                    [id],
                )?;
            }
            if read == 0 {
                break;
            }
        }
        (page.pending_count, page.invalid_count) = tx.query_row(
            "SELECT COALESCE(SUM(h.valid=1),0),COALESCE(SUM(h.valid=0),0)
             FROM candidates c JOIN candidate_health_v1 h ON h.candidate=c.id
             WHERE c.archive=?1 AND c.state='pending'",
            [archive],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        tx.commit()?;
        Ok(page)
    }
    pub fn pending_count(&self, archive: &str) -> Result<u32> {
        Ok(self.0.query_row(
            "SELECT COUNT(*) FROM candidates WHERE archive=?1 AND state='pending'",
            [archive],
            |r| r.get(0),
        )?)
    }
    pub fn candidate(&self, archive: &str, id: &str) -> Result<Candidate> {
        let mut stmt = self.0.prepare("SELECT c.id,c.account,a.email,c.folder,c.validity,c.uid,c.header,c.reasons,c.locator,a.source
            FROM candidates c JOIN accounts a ON a.id=c.account WHERE archive=?1 AND c.id=?2 AND state='pending'")?;
        let mut rows = stmt.query(params![archive, id])?;
        self.decode_candidate(rows.next()?.ok_or(Error::Missing)?)
    }
    pub fn finish(&self, archive: &str, ids: &[String], ignored: bool) -> Result<u32> {
        // Atomic batch; never accept arbitrary SQL state from the webview.
        let tx = self.0.unchecked_transaction()?;
        let mut changed = 0u32;
        for id in ids {
            changed = changed.saturating_add(tx.execute(
                "UPDATE candidates SET state=?3 WHERE archive=?1 AND id=?2 AND state='pending'",
                params![archive, id, if ignored { "ignored" } else { "imported" }],
            )? as u32);
        }
        tx.commit()?;
        Ok(changed)
    }
}
