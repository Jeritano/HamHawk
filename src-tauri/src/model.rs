use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ReceiverKind { Kiwisdr, Openwebrx, Feed }

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
    /// Quick-connect star (RHR-style). Preserved across edits.
    #[serde(default)]
    pub favorite: bool,
    /// Free-text antenna description (from the KiwiSDR catalog or user-entered).
    #[serde(default)]
    pub antenna: Option<String>,
    /// Coarse region label (Europe / North America / …) for filtering.
    #[serde(default)]
    pub region: Option<String>,
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

/// Live receiver-control message (applied on the open socket, no reconnect).
/// All fields optional so the UI can change just the filter or just the gain.
/// KiwiSDR only for now (OpenWebRX/feeds ignore it). Not persisted: the SDR
/// resets the passband to the mode default on reconnect anyway.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RadioCtl {
    /// Passband low edge in Hz (relative to the tuned freq; negative for AM).
    pub low_cut: Option<f64>,
    /// Passband high edge in Hz.
    pub high_cut: Option<f64>,
    /// AGC on (automatic gain) vs off (manual gain via `man_gain`).
    pub agc: Option<bool>,
    /// Manual RF gain (KiwiSDR `manGain`, ~0..120) — used when AGC is off.
    pub man_gain: Option<i32>,
}

/// Whether a usable Whisper model is available, and where (for the Settings UI).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelStatus {
    pub present: bool,
    pub path: Option<String>,
    pub source: String, // "default" | "custom" | "none"
    pub default_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub asr_worker_count: u32,
    pub whisper_model_path: Option<String>,
    pub recording_dir: Option<String>,
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
