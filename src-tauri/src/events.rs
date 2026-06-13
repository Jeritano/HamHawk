use crate::model::{AlertHit, AudioChunk, SessionStatus, SpectrumFrame, TelemetryFrame, TranscriptRow};
use tauri::{AppHandle, Emitter};

pub const EVT_TELEMETRY: &str = "telemetry";
pub const EVT_TRANSCRIPT: &str = "transcript";
pub const EVT_SESSION: &str = "session";
pub const EVT_SPECTRUM: &str = "spectrum";
pub const EVT_AUDIO: &str = "audio";
pub const EVT_ALERT: &str = "alert";
#[allow(dead_code)]
pub const EVT_MODEL_DL: &str = "model_dl";

pub fn emit_spectrum(app: &AppHandle, frame: SpectrumFrame) {
    let _ = app.emit(EVT_SPECTRUM, frame);
}

pub fn emit_audio(app: &AppHandle, chunk: AudioChunk) {
    let _ = app.emit(EVT_AUDIO, chunk);
}

pub fn emit_alert(app: &AppHandle, hit: AlertHit) {
    let _ = app.emit(EVT_ALERT, hit);
}

pub fn emit_telemetry(app: &AppHandle, frame: TelemetryFrame) {
    let _ = app.emit(EVT_TELEMETRY, frame);
}

pub fn emit_transcript(app: &AppHandle, row: TranscriptRow) {
    let _ = app.emit(EVT_TRANSCRIPT, row);
}

pub fn emit_session(app: &AppHandle, receiver_id: &str, status: SessionStatus, reason: Option<String>) {
    let status_str = match status {
        SessionStatus::Connecting => "connecting",
        SessionStatus::Live => "live",
        SessionStatus::Reconnecting => "reconnecting",
        SessionStatus::Error => "error",
        SessionStatus::Stopped => "stopped",
    };
    let payload = serde_json::json!({
        "receiver_id": receiver_id,
        "status": status_str,
        "reason": reason,
    });
    let _ = app.emit(EVT_SESSION, payload);
}
