use crate::model::{AlertHit, AlertRule, Bookmark, Lane, ReceiverConfig, ReceiverKind, Settings, TranscriptRow};
use crate::orchestrator::Orchestrator;
use tauri::State;

// Reject URL schemes that don't belong to a given receiver kind so a
// compromised frontend can't point a source at file://, gopher://, etc.
// Private IPs / localhost are intentionally allowed (legit local SDRs).
fn validate_url_scheme(cfg: &ReceiverConfig) -> Result<(), String> {
    let scheme = match cfg.url.split_once("://") {
        Some((s, _)) => s.to_ascii_lowercase(),
        None => return Err("URL must include a scheme (e.g. http://, ws://)".into()),
    };
    let ok = match cfg.kind {
        ReceiverKind::Feed => matches!(scheme.as_str(), "http" | "https"),
        ReceiverKind::Kiwisdr | ReceiverKind::Openwebrx => {
            matches!(scheme.as_str(), "http" | "https" | "ws" | "wss")
        }
    };
    if ok {
        Ok(())
    } else {
        Err(format!("Unsupported URL scheme '{scheme}' for this receiver"))
    }
}

// Validate URL scheme + (for SDRs) the mode↔lane combo. Feeds are raw streams
// with no SDR mode to validate. Used by both add_receiver and update_receiver so
// an edit can't bypass the checks an add enforces.
fn validate_receiver(cfg: &ReceiverConfig) -> Result<(), String> {
    validate_url_scheme(cfg)?;
    if matches!(cfg.kind, ReceiverKind::Feed) {
        return Ok(());
    }
    match (&cfg.lane, cfg.mode.as_str()) {
        (Lane::Voice, mode) => {
            // CW is intentionally NOT a voice mode: Morse fed to Whisper is garbage.
            // Use the digital lane with mode "cw" instead.
            if !["usb", "lsb", "am"].contains(&mode) {
                return Err("Invalid mode for voice lane (use usb/lsb/am; cw belongs to the digital lane)".into());
            }
        }
        (Lane::Digital, mode) => {
            if !["ft8", "ft4", "cw", "psk31", "rtty"].contains(&mode) {
                return Err("Invalid mode for digital lane".into());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn add_receiver(
    orchestrator: State<'_, Orchestrator>,
    cfg: ReceiverConfig,
) -> Result<ReceiverConfig, String> {
    validate_receiver(&cfg)?;
    orchestrator.add_receiver(cfg.clone())?;
    Ok(cfg)
}

#[tauri::command]
pub fn update_receiver(
    orchestrator: State<'_, Orchestrator>,
    cfg: ReceiverConfig,
) -> Result<(), String> {
    // URL scheme only — NOT the mode/lane check. In-app flows (selectBand applies
    // a band's mode to the active VFO without changing its lane) legitimately
    // produce transient mode/lane combos; rejecting them breaks band selection.
    validate_url_scheme(&cfg)?;
    // INSERT OR REPLACE upserts, so re-adding replaces.
    orchestrator.add_receiver(cfg)
}

#[tauri::command]
pub fn remove_receiver(orchestrator: State<'_, Orchestrator>, id: String) -> Result<(), String> {
    orchestrator.remove_receiver(&id)
}

#[tauri::command]
pub fn set_favorite(
    orchestrator: State<'_, Orchestrator>,
    id: String,
    favorite: bool,
) -> Result<(), String> {
    orchestrator.set_favorite(&id, favorite)
}

#[tauri::command]
pub fn list_receivers(
    orchestrator: State<'_, Orchestrator>,
) -> Result<Vec<ReceiverConfig>, String> {
    orchestrator.list_receivers()
}

#[tauri::command]
pub fn start_receiver(orchestrator: State<'_, Orchestrator>, id: String) -> Result<(), String> {
    orchestrator.start_receiver(&id)
}

#[tauri::command]
pub fn stop_receiver(orchestrator: State<'_, Orchestrator>, id: String) -> Result<(), String> {
    orchestrator.stop_receiver(&id);
    Ok(())
}

#[tauri::command]
pub fn tune(orchestrator: State<'_, Orchestrator>, id: String, freq_hz: u64) -> Result<(), String> {
    orchestrator.tune(&id, freq_hz)
}

#[tauri::command]
pub fn set_radio_ctl(
    orchestrator: State<'_, Orchestrator>,
    id: String,
    ctl: crate::model::RadioCtl,
) -> Result<(), String> {
    orchestrator.set_radio_ctl(&id, ctl)
}

#[tauri::command]
pub fn export_log(
    orchestrator: State<'_, Orchestrator>,
    format: String,
    digital_only: bool,
) -> Result<String, String> {
    orchestrator.export_log(&format, digital_only)
}

#[tauri::command]
pub fn query_transcripts(
    orchestrator: State<'_, Orchestrator>,
    receiver_id: Option<String>,
    time_range_start: Option<i64>,
    time_range_end: Option<i64>,
    text_query: Option<String>,
) -> Result<Vec<TranscriptRow>, String> {
    let tr = match (time_range_start, time_range_end) {
        (Some(s), Some(e)) => Some((s, e)),
        _ => None,
    };
    orchestrator.query_transcripts(receiver_id.as_deref(), tr, text_query.as_deref())
}

#[tauri::command]
pub fn get_settings(orchestrator: State<'_, Orchestrator>) -> Settings {
    orchestrator.settings()
}

#[tauri::command]
pub fn set_settings(
    orchestrator: State<'_, Orchestrator>,
    settings: Settings,
) -> Result<(), String> {
    orchestrator.set_settings(&settings)
}

#[derive(Clone, serde::Serialize)]
pub struct ModelInfo {
    pub name: String,
    pub size_mb: u32,
    pub available: bool,
}

#[tauri::command]
pub fn list_model_options() -> Vec<ModelInfo> {
    // P1: static catalog. Availability is not yet probed on disk.
    vec![
        ModelInfo { name: "base".into(), size_mb: 140, available: false },
        ModelInfo { name: "small".into(), size_mb: 480, available: false },
        ModelInfo { name: "medium".into(), size_mb: 1500, available: false },
    ]
}

#[tauri::command]
pub fn model_status(orchestrator: State<'_, Orchestrator>) -> crate::model::ModelStatus {
    orchestrator.model_status()
}

#[tauri::command]
pub fn partial_recordings(orchestrator: State<'_, Orchestrator>) -> Vec<String> {
    orchestrator.partial_recordings()
}

/// Download the default Whisper model (ggml-base.en) into ~/.hamhawk/models in the
/// background, emitting `model_dl` progress events. Atomic: writes to a .part file
/// and renames on success so a partial download can't masquerade as a real model.
#[tauri::command]
pub fn download_model(app: tauri::AppHandle) -> Result<(), String> {
    use crate::store::db::models_dir;
    let dir = models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join("ggml-base.bin");
    if dest.is_file() {
        return Err("a model is already installed".into());
    }
    std::thread::spawn(move || {
        use std::io::{Read, Write};
        let emit = |recv: u64, total: u64, done: bool, err: Option<String>| {
            crate::events::emit_model_download(&app, recv, total, done, err);
        };
        let url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
        let resp = match reqwest::blocking::Client::builder()
            .build()
            .and_then(|c| c.get(url).send())
        {
            Ok(r) => r,
            Err(e) => return emit(0, 0, true, Some(format!("connect failed: {e}"))),
        };
        if !resp.status().is_success() {
            return emit(0, 0, true, Some(format!("HTTP {}", resp.status())));
        }
        let total = resp.content_length().unwrap_or(0);
        let tmp = dir.join("ggml-base.bin.part");
        let mut file = match std::fs::File::create(&tmp) {
            Ok(f) => f,
            Err(e) => return emit(0, total, true, Some(format!("create failed: {e}"))),
        };
        let mut resp = resp;
        let mut buf = [0u8; 65536];
        let mut received = 0u64;
        let mut last = 0u64;
        loop {
            match resp.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if file.write_all(&buf[..n]).is_err() {
                        let _ = std::fs::remove_file(&tmp);
                        return emit(received, total, true, Some("write failed (disk full?)".into()));
                    }
                    received += n as u64;
                    if received - last > 2_000_000 {
                        last = received;
                        emit(received, total, false, None);
                    }
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp);
                    return emit(received, total, true, Some(format!("download error: {e}")));
                }
            }
        }
        if std::fs::rename(&tmp, &dest).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return emit(received, total, true, Some("could not finalize model file".into()));
        }
        emit(received, total, true, None);
    });
    Ok(())
}

// ---- audio monitor + recording ----

#[tauri::command]
pub fn set_monitor(orchestrator: State<'_, Orchestrator>, id: Option<String>) {
    orchestrator.set_monitor(id);
}

#[tauri::command]
pub fn set_monitor_sub(orchestrator: State<'_, Orchestrator>, id: Option<String>) {
    orchestrator.set_monitor_sub(id);
}

#[tauri::command]
pub fn set_watched(orchestrator: State<'_, Orchestrator>, ids: Vec<String>) {
    orchestrator.set_watched(ids);
}

#[tauri::command]
pub fn start_recording(orchestrator: State<'_, Orchestrator>, id: String) {
    orchestrator.start_recording(&id);
}

#[tauri::command]
pub fn stop_recording(orchestrator: State<'_, Orchestrator>, id: String) {
    orchestrator.stop_recording(&id);
}

#[tauri::command]
pub fn recording_ids(orchestrator: State<'_, Orchestrator>) -> Vec<String> {
    orchestrator.recording_ids()
}

#[tauri::command]
pub fn recordings_dir(orchestrator: State<'_, Orchestrator>) -> String {
    orchestrator.recordings_dir()
}

#[tauri::command]
pub fn running_ids(orchestrator: State<'_, Orchestrator>) -> Vec<String> {
    orchestrator.running_ids()
}

// ---- bookmarks ----

#[tauri::command]
pub fn add_bookmark(orchestrator: State<'_, Orchestrator>, bookmark: Bookmark) -> Result<(), String> {
    orchestrator.add_bookmark(bookmark)
}

#[tauri::command]
pub fn list_bookmarks(orchestrator: State<'_, Orchestrator>) -> Result<Vec<Bookmark>, String> {
    orchestrator.list_bookmarks()
}

#[tauri::command]
pub fn remove_bookmark(orchestrator: State<'_, Orchestrator>, id: String) -> Result<(), String> {
    orchestrator.remove_bookmark(&id)
}

// ---- alerts ----

#[tauri::command]
pub fn add_alert_rule(orchestrator: State<'_, Orchestrator>, rule: AlertRule) -> Result<(), String> {
    orchestrator.add_alert_rule(rule)
}

#[tauri::command]
pub fn list_alert_rules(orchestrator: State<'_, Orchestrator>) -> Result<Vec<AlertRule>, String> {
    orchestrator.list_alert_rules()
}

#[tauri::command]
pub fn remove_alert_rule(orchestrator: State<'_, Orchestrator>, id: String) -> Result<(), String> {
    orchestrator.remove_alert_rule(&id)
}

#[tauri::command]
pub fn list_alert_hits(orchestrator: State<'_, Orchestrator>, limit: i64) -> Result<Vec<AlertHit>, String> {
    orchestrator.list_alert_hits(limit)
}
