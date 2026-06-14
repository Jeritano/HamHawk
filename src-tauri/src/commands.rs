use crate::model::{AlertHit, AlertRule, Bookmark, Lane, ReceiverConfig, ReceiverKind, Settings, TranscriptRow};
use crate::orchestrator::Orchestrator;
use tauri::State;

#[tauri::command]
pub fn add_receiver(
    orchestrator: State<'_, Orchestrator>,
    cfg: ReceiverConfig,
) -> Result<ReceiverConfig, String> {
    // Feeds are internet streams (no SDR mode to validate).
    if matches!(cfg.kind, ReceiverKind::Feed) {
        orchestrator.add_receiver(cfg.clone())?;
        return Ok(cfg);
    }
    // Validate mode based on lane
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
    
    orchestrator.add_receiver(cfg.clone())?;
    Ok(cfg)
}

#[tauri::command]
pub fn update_receiver(
    orchestrator: State<'_, Orchestrator>,
    cfg: ReceiverConfig,
) -> Result<(), String> {
    // INSERT OR REPLACE upserts, so re-adding replaces.
    orchestrator.add_receiver(cfg)
}

#[tauri::command]
pub fn remove_receiver(orchestrator: State<'_, Orchestrator>, id: String) -> Result<(), String> {
    orchestrator.remove_receiver(&id)
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
pub fn download_model(_name: String) -> Result<(), String> {
    // P1 stub: model download not implemented yet.
    Err("model download not implemented in P1; place a ggml model at ~/.hamhawk/models/ggml-base.bin or set its path in Settings".into())
}

// ---- audio monitor + recording ----

#[tauri::command]
pub fn set_monitor(orchestrator: State<'_, Orchestrator>, id: Option<String>) {
    orchestrator.set_monitor(id);
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
