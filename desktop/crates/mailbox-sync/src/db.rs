use crate::{retry_delay, Error, Header, Provider, Result, CHECK_INTERVAL, FAILURE_LIMIT};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub email: String,
    pub provider: Provider,
    pub paused: bool,
    pub failures: u32,
    pub last_error: Option<String>,
    pub last_checked: Option<i64>,
    pub next_check: i64,
}
impl Account {
    pub fn credential_id(&self) -> String {
        format!("mailbox:{}", self.id)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub validity: u32,
    pub uid: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub account_id: String,
    pub email: String,
    pub folder: String,
    pub validity: u32,
    pub uid: u32,
    pub header: Header,
    pub reasons: Vec<String>,
}
pub struct Database(Connection);
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
            CREATE INDEX IF NOT EXISTS candidate_pending ON candidates(archive,state);")?;
        Ok(Self(conn))
    }
    pub fn accounts(&self) -> Result<Vec<Account>> {
        let mut stmt = self.0.prepare("SELECT id,email,paused,failures,last_error,last_checked,next_check FROM accounts ORDER BY email")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })?;
        rows.map(|row| {
            let (id, email, paused, failures, last_error, last_checked, next_check) = row?;
            let (_, provider) = Provider::detect(&email)?;
            Ok(Account {
                id,
                email,
                provider,
                paused,
                failures,
                last_error,
                last_checked,
                next_check,
            })
        })
        .collect()
    }
    pub fn account(&self, id: &str) -> Result<Account> {
        self.accounts()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or(Error::Missing)
    }
    pub fn save_account(&self, id: &str, email: &str) -> Result<Account> {
        let (email, _) = Provider::detect(email)?;
        self.0.execute(
            "INSERT INTO accounts(id,email) VALUES (?1,?2)
            ON CONFLICT(email) DO UPDATE SET paused=0,failures=0,last_error=NULL,next_check=0",
            params![id, email],
        )?;
        self.accounts()?
            .into_iter()
            .find(|a| a.email == email)
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
        let tx = self.0.transaction()?;
        for (uid, header, reasons) in found {
            if reasons.is_empty() {
                continue;
            }
            tx.execute("INSERT INTO candidates(id,archive,account,fingerprint,folder,validity,uid,header,reasons,state)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending')
                ON CONFLICT(archive,account,fingerprint) DO UPDATE SET
                    folder=excluded.folder,validity=excluded.validity,uid=excluded.uid,
                    header=excluded.header,reasons=excluded.reasons",
                params![uuid::Uuid::new_v4().to_string(),archive,account,header.fingerprint(),folder,cursor.validity,uid,
                    serde_json::to_string(header).map_err(|_| Error::Storage)?,serde_json::to_string(reasons).map_err(|_| Error::Storage)?])?;
        }
        tx.execute("INSERT INTO cursors(archive,account,folder,validity,uid) VALUES (?1,?2,?3,?4,?5)
            ON CONFLICT(archive,account,folder) DO UPDATE SET validity=excluded.validity,uid=excluded.uid",
            params![archive,account,folder,cursor.validity,cursor.uid])?;
        tx.commit()?;
        Ok(())
    }
    fn read_candidate(
        r: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<(String, String, String, String, u32, u32, String, String)> {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
            r.get(7)?,
        ))
    }
    pub fn pending(&self, archive: &str, limit: u32) -> Result<Vec<Candidate>> {
        let mut stmt = self.0.prepare("SELECT c.id,c.account,a.email,c.folder,c.validity,c.uid,c.header,c.reasons
            FROM candidates c JOIN accounts a ON a.id=c.account WHERE archive=?1 AND state='pending' ORDER BY c.rowid DESC LIMIT ?2")?;
        let rows = stmt.query_map(params![archive, limit.min(2000)], Self::read_candidate)?;
        rows.map(|row| {
            let (id, account_id, email, folder, validity, uid, header, reasons) = row?;
            Ok(Candidate {
                id,
                account_id,
                email,
                folder,
                validity,
                uid,
                header: serde_json::from_str(&header).map_err(|_| Error::Storage)?,
                reasons: serde_json::from_str(&reasons).map_err(|_| Error::Storage)?,
            })
        })
        .collect()
    }
    pub fn pending_count(&self, archive: &str) -> Result<u32> {
        Ok(self.0.query_row(
            "SELECT COUNT(*) FROM candidates WHERE archive=?1 AND state='pending'",
            [archive],
            |r| r.get(0),
        )?)
    }
    pub fn candidate(&self, archive: &str, id: &str) -> Result<Candidate> {
        let row = self.0.query_row("SELECT c.id,c.account,a.email,c.folder,c.validity,c.uid,c.header,c.reasons
            FROM candidates c JOIN accounts a ON a.id=c.account WHERE archive=?1 AND c.id=?2 AND state='pending'", params![archive,id],Self::read_candidate).optional()?.ok_or(Error::Missing)?;
        let (id, account_id, email, folder, validity, uid, header, reasons) = row;
        Ok(Candidate {
            id,
            account_id,
            email,
            folder,
            validity,
            uid,
            header: serde_json::from_str(&header).map_err(|_| Error::Storage)?,
            reasons: serde_json::from_str(&reasons).map_err(|_| Error::Storage)?,
        })
    }
    pub fn finish(&self, archive: &str, ids: &[String], ignored: bool) -> Result<()> {
        // Atomic batch; never accept arbitrary SQL state from the webview.
        let tx = self.0.unchecked_transaction()?;
        for id in ids {
            tx.execute(
                "UPDATE candidates SET state=?3 WHERE archive=?1 AND id=?2 AND state='pending'",
                params![archive, id, if ignored { "ignored" } else { "imported" }],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
