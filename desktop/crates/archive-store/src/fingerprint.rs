//! Versioned logical snapshot hash. SQLite page layout, backup time and OS
//! reminder handles are deliberately absent. Unknown future tables are included.
use crate::StoreError;
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::path::Path;

fn field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}
fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn snapshot(database: &Path) -> Result<String, StoreError> {
    let conn = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut hash = Sha256::new();
    field(&mut hash, b"resume-pro-business-v1");
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    field(&mut hash, &version.to_le_bytes());
    let mut tables = conn.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")?;
    for table in tables.query_map([], |r| r.get::<_, String>(0))? {
        let table = table?;
        if matches!(
            table.as_str(),
            "schema_migrations" | "snapshot_uploads" | "snapshot_chunks" | "snapshot_chunk_bytes"
        ) {
            continue;
        }
        field(&mut hash, table.as_bytes());
        let mut info = conn.prepare(&format!("PRAGMA table_info({})", quote(&table)))?;
        let columns = info
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|c| {
                table != "todos"
                    || !matches!(
                        c.as_str(),
                        "reminder_scheduled_for_utc"
                            | "reminder_handle"
                            | "reminder_state"
                            | "updated_at"
                    )
            })
            .collect::<Vec<_>>();
        for column in &columns {
            field(&mut hash, column.as_bytes());
        }
        let names = columns
            .iter()
            .map(|s| quote(s))
            .collect::<Vec<_>>()
            .join(",");
        // Sort logical rows, never rowid or physical page order. Equal keys have
        // identical selected values and therefore cannot affect the result.
        let mut statement = conn.prepare(&format!(
            "SELECT {names} FROM {} ORDER BY {names}",
            quote(&table)
        ))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            hash.update(b"row");
            for index in 0..columns.len() {
                match row.get_ref(index)? {
                    ValueRef::Null => field(&mut hash, b"n"),
                    ValueRef::Integer(v) => {
                        field(&mut hash, b"i");
                        field(&mut hash, &v.to_le_bytes());
                    }
                    ValueRef::Real(v) => {
                        field(&mut hash, b"r");
                        field(&mut hash, &v.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(v) => {
                        field(&mut hash, b"t");
                        field(&mut hash, v);
                    }
                    ValueRef::Blob(v) => {
                        field(&mut hash, b"b");
                        field(&mut hash, v);
                    }
                }
            }
        }
        hash.update(b"end-table");
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn physical_order_and_reminder_delivery_do_not_change_business_hash() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.db");
        let c = Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE records(id TEXT, value TEXT); CREATE TABLE sqlitex_business(value TEXT); CREATE TABLE todos(id TEXT,title TEXT,reminder_handle TEXT,updated_at TEXT); INSERT INTO records VALUES ('b','two'),('a','one'); INSERT INTO todos VALUES ('t','business title','old','before');").unwrap();
        let original = snapshot(&p).unwrap();
        c.execute_batch("INSERT INTO sqlitex_business VALUES ('included')")
            .unwrap();
        assert_ne!(original, snapshot(&p).unwrap());
        c.execute_batch("DELETE FROM sqlitex_business").unwrap();
        assert_eq!(original, snapshot(&p).unwrap());
        c.execute_batch(
            "UPDATE todos SET reminder_handle='new',updated_at='after reminder delivery'; VACUUM;",
        )
        .unwrap();
        assert_eq!(original, snapshot(&p).unwrap());
        c.execute_batch("UPDATE todos SET title='business edit'")
            .unwrap();
        assert_ne!(original, snapshot(&p).unwrap());
        c.execute_batch("UPDATE todos SET title='business title'")
            .unwrap();
        assert_eq!(original, snapshot(&p).unwrap());
        c.execute_batch("UPDATE records SET value='changed' WHERE id='a'")
            .unwrap();
        assert_ne!(original, snapshot(&p).unwrap());
        c.execute_batch("UPDATE records SET value='one' WHERE id='a'")
            .unwrap();
        assert_eq!(original, snapshot(&p).unwrap());
        c.execute_batch("DELETE FROM records WHERE id='b'").unwrap();
        assert_ne!(original, snapshot(&p).unwrap());
        c.execute_batch("INSERT INTO records VALUES ('b','two')")
            .unwrap();
        assert_eq!(original, snapshot(&p).unwrap());
    }
}
