use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ReceiverKind { Kiwisdr, Openwebrx }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Lane { Voice, Digital }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReceiverConfig {
    pub id: String,
    pub kind: ReceiverKind,
    pub url: String,
    pub label: Option<String>,
    pub freq_hz: u64,
    pub mode: String,
    pub lane: Lane,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus { Connecting, Live, Reconnecting, Error, Stopped }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TranscriptRow {
    pub id: i64,
    pub receiver_id: String,
    pub ts_start: i64,
    pub ts_end: i64,
    pub lane: Lane,
    pub mode: String,
    pub src_lang: Option<String>,
    pub text_en: String,
    pub text_native: Option<String>,
    pub confidence: Option<f32>,
    pub snr_db: Option<f32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TelemetryFrame {
    pub receiver_id: String,
    pub status: SessionStatus,
    pub s_meter_dbm: Option<f32>,
    pub snr_db: Option<f32>,
    pub waterfall_row: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub asr_worker_count: u32,
    pub whisper_model_path: Option<String>,
}

/// One waterfall/spectrum row (log-magnitude bins, 0..255), pushed per receiver.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpectrumFrame {
    pub receiver_id: String,
    pub bins: Vec<u8>,
}

/// A chunk of monitored audio (base64 of little-endian i16 PCM).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioChunk {
    pub receiver_id: String,
    pub sample_rate: u32,
    pub pcm_b64: String,
}

/// A saved frequency/receiver preset.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub label: String,
    pub kind: ReceiverKind,
    pub url: String,
    pub freq_hz: u64,
    pub mode: String,
    pub lane: Lane,
}

/// A keyword/regex-ish alert rule (substring, case-insensitive).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AlertRule {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub enabled: bool,
}

/// An alert that fired (a transcript/decode matched a rule).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AlertHit {
    pub rule_id: String,
    pub rule_name: String,
    pub receiver_id: String,
    pub ts_ms: i64,
    pub text: String,
}
