CREATE TABLE IF NOT EXISTS receiver (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, url TEXT NOT NULL,
  label TEXT, freq_hz INTEGER NOT NULL, mode TEXT NOT NULL,
  lane TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transcript (
  id INTEGER PRIMARY KEY AUTOINCREMENT, receiver_id TEXT NOT NULL REFERENCES receiver(id) ON DELETE CASCADE,
  ts_start INTEGER NOT NULL, ts_end INTEGER NOT NULL, lane TEXT NOT NULL,
  mode TEXT NOT NULL, src_lang TEXT, text_en TEXT NOT NULL,
  text_native TEXT, confidence REAL, snr_db REAL
);

CREATE INDEX IF NOT EXISTS idx_transcript_receiver ON transcript(receiver_id, ts_start);

CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
  text_en, text_native, content='transcript', content_rowid='id', tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS telemetry (
  receiver_id TEXT NOT NULL REFERENCES receiver(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, s_meter_dbm REAL, snr_db REAL,
  PRIMARY KEY (receiver_id, ts)
);

CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
