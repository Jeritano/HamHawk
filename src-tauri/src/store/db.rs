use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Result as SqlResult, ToSql};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// SQLite store. Wraps the connection in a `Mutex` so the whole `Db` is `Sync`
/// and can live in Tauri's shared `State` and be cloned (via `Arc`) into tasks.
pub struct Db {
    conn: Mutex<Connection>,
}

pub fn data_dir() -> PathBuf {
    dirs_next::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".hamhawk")
}

pub fn models_dir() -> PathBuf {
    data_dir().join("models")
}

impl Db {
    pub fn open() -> SqlResult<Self> {
        let dir = data_dir();
        let _ = fs::create_dir_all(&dir);
        let _ = fs::create_dir_all(models_dir());
        let conn = Connection::open(dir.join("db.sqlite"))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(include_str!("schema.sql"))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_receiver(
        &self,
        id: &str,
        kind: &str,
        url: &str,
        label: Option<&str>,
        freq_hz: u64,
        mode: &str,
        lane: &str,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO receiver (id,kind,url,label,freq_hz,mode,lane,enabled,created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8)",
            params![id, kind, url, label, freq_hz, mode, lane, chrono::Utc::now().timestamp_millis()],
        )?;
        Ok(())
    }

    #[allow(clippy::type_complexity)]
    pub fn list_receivers(
        &self,
    ) -> SqlResult<Vec<(String, String, String, Option<String>, u64, String, String, bool)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id,kind,url,label,freq_hz,mode,lane,enabled FROM receiver")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get::<_, i64>(7)? != 0,
                ))
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn remove_receiver(&self, id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM receiver WHERE id = ?1", params![id])?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_transcript(
        &self,
        rid: &str,
        ts_s: i64,
        ts_e: i64,
        lane: &str,
        mode: &str,
        lang: Option<&str>,
        en: &str,
        native: Option<&str>,
        conf: Option<f32>,
        snr: Option<f32>,
    ) -> SqlResult<i64> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO transcript (receiver_id,ts_start,ts_end,lane,mode,src_lang,text_en,text_native,confidence,snr_db) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![rid, ts_s, ts_e, lane, mode, lang, en, native, conf, snr],
        )?;
        // Capture the id AFTER the insert, then mirror into the FTS index.
        let id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO transcript_fts (rowid,text_en,text_native) VALUES (?1,?2,?3)",
            params![id, en, native],
        )?;
        tx.commit()?;
        Ok(id)
    }

    #[allow(clippy::type_complexity)]
    pub fn query_transcripts(
        &self,
        rid: Option<&str>,
        tr: Option<(i64, i64)>,
        txt: Option<&str>,
    ) -> SqlResult<
        Vec<(
            i64,
            String,
            i64,
            i64,
            String,
            String,
            Option<String>,
            String,
            Option<String>,
            Option<f32>,
            Option<f32>,
        )>,
    > {
        let conn = self.conn.lock().unwrap();
        let mut conds: Vec<String> = Vec::new();
        let mut pv: Vec<Box<dyn ToSql>> = Vec::new();

        if let Some(r) = rid {
            conds.push(format!("receiver_id = ?{}", pv.len() + 1));
            pv.push(Box::new(r.to_string()));
        }
        if let Some((s, e)) = tr {
            conds.push(format!("ts_start >= ?{}", pv.len() + 1));
            pv.push(Box::new(s));
            conds.push(format!("ts_end <= ?{}", pv.len() + 1));
            pv.push(Box::new(e));
        }
        if let Some(q) = txt {
            if let Some(match_expr) = build_fts_query(q) {
                conds.push(format!(
                    "id IN (SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH ?{})",
                    pv.len() + 1
                ));
                pv.push(Box::new(match_expr));
            }
        }

        let where_clause = if conds.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conds.join(" AND "))
        };
        let sql = format!(
            "SELECT id,receiver_id,ts_start,ts_end,lane,mode,src_lang,text_en,text_native,confidence,snr_db \
             FROM transcript {where_clause} ORDER BY ts_start DESC LIMIT 1000"
        );

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(pv.iter()), |r| {
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
                    r.get(9)?,
                    r.get(10)?,
                ))
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn insert_telemetry(
        &self,
        rid: &str,
        ts: i64,
        sdbm: Option<f32>,
        snr: Option<f32>,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO telemetry (receiver_id,ts,s_meter_dbm,snr_db) VALUES (?1,?2,?3,?4)",
            params![rid, ts, sdbm, snr],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT value FROM setting WHERE key=?1", params![key], |r| {
            r.get(0)
        })
        .optional()
    }

    pub fn set_setting(&self, key: &str, val: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO setting (key,value) VALUES (?1,?2)",
            params![key, val],
        )?;
        Ok(())
    }
}

/// Turn a free-text query into a safe FTS5 MATCH expression: each whitespace
/// token becomes a quoted prefix term. Returns None for an empty query.
fn build_fts_query(q: &str) -> Option<String> {
    let terms: Vec<String> = q
        .split_whitespace()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}
