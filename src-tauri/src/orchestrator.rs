use crate::asr::{self, AsrResult};
use crate::audio::spectrum::Spectrogram;
use crate::audio::{self, AsrJob};
use crate::digital::cw::CwDecoder;
use crate::digital::ft8::{Ft8Decoder, Ft8Mode};
use crate::digital::psk_rtty::{PskRttyDecoder, PskRttyMode};
use crate::digital::Decoder;
use crate::events;
use crate::model::SessionStatus;
use crate::model::{
    AlertHit, AlertRule, AudioChunk, Bookmark, Lane, ReceiverConfig, ReceiverKind, Settings,
    SpectrumFrame, TelemetryFrame as ModelTelemetry, TranscriptRow,
};
use crate::source::feed::FeedSource;
use crate::source::kiwisdr::KiwiSDR;
use crate::source::openwebrx::OpenWebRX;
use crate::source::{AudioFrame, TelemetryFrame as SourceTelemetry};
use crate::store::db::{data_dir, models_dir, Db};
use base64::Engine as _;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::async_runtime::{spawn, JoinHandle};
use tauri::AppHandle;
use tokio::sync::mpsc;

struct Session {
    tasks: Vec<JoinHandle<()>>,
    /// Live retune channel into the running source (no reconnect).
    tune_tx: mpsc::Sender<u64>,
    /// Live filter / RF-gain control channel (KiwiSDR; no reconnect).
    ctl_tx: mpsc::Sender<crate::model::RadioCtl>,
    /// Cancels detached work (feed HTTP thread + decoder) that abort can't reach.
    cancel: Arc<AtomicBool>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        for h in &self.tasks {
            h.abort();
        }
        // The audio tap is intentionally NOT in `tasks`: it's detached, so when the
        // aborted source drops its sender the tap drains, finalizes the WAV, and
        // exits cleanly. Aborting it would corrupt in-progress recordings.
    }
}

type Alerts = Arc<Mutex<Vec<AlertRule>>>;
type Modes = Arc<Mutex<HashMap<String, String>>>;

/// The single shared ASR pool: the job sender plus the worker-pool + result-
/// consumer task handles (so a settings change can tear the old pool down).
struct AsrPool {
    job_tx: mpsc::Sender<AsrJob>,
    handles: Vec<JoinHandle<()>>,
}

/// Max concurrent running receiver sessions (bounds WS connections + DSP load).
const MAX_SESSIONS: usize = 8;

pub struct Orchestrator {
    db: Arc<Db>,
    app: AppHandle,
    sessions: Mutex<HashMap<String, Session>>,
    /// Which receiver's audio is streamed to the UI as the MAIN (left) channel.
    monitored: Arc<Mutex<Option<String>>>,
    /// Optional second receiver streamed as the SUB (right) channel — true dual
    /// receive (IC-7760 style). Both emit `audio` events tagged with receiver_id;
    /// the UI pans MAIN left / SUB right.
    monitored_sub: Arc<Mutex<Option<String>>>,
    /// Receiver ids whose waterfall the UI is showing — only these compute/emit
    /// spectrum (skips the FFT for off-screen receivers).
    watched: Arc<Mutex<HashSet<String>>>,
    /// Receiver ids currently being recorded to WAV.
    record_ids: Arc<Mutex<HashSet<String>>>,
    /// Cached, enabled alert rules (kept in sync with the DB).
    alerts: Alerts,
    /// Single shared ASR pool job sender (one Whisper model for ALL receivers).
    /// `None` until first built; rebuilt after a settings change.
    asr: Mutex<Option<AsrPool>>,
    /// receiver_id -> mode, so the shared ASR result consumer can label transcripts.
    modes: Modes,
}

impl Orchestrator {
    pub fn new(db: Db, app: AppHandle) -> Self {
        let db = Arc::new(db);
        let alerts = Arc::new(Mutex::new(load_alert_rules(&db)));
        Self {
            db,
            app,
            sessions: Mutex::new(HashMap::new()),
            monitored: Arc::new(Mutex::new(None)),
            monitored_sub: Arc::new(Mutex::new(None)),
            watched: Arc::new(Mutex::new(HashSet::new())),
            record_ids: Arc::new(Mutex::new(HashSet::new())),
            alerts,
            asr: Mutex::new(None),
            modes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Get (building once) the shared ASR pool's job sender. One `WhisperContext`
    /// is loaded for the whole app — not one per receiver. Returns `None` if no
    /// model is available (transcription disabled).
    fn ensure_asr(&self) -> Option<mpsc::Sender<AsrJob>> {
        let mut guard = self.asr.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pool) = guard.as_ref() {
            return Some(pool.job_tx.clone());
        }
        let model = self.resolve_model_path()?;
        let workers = self.settings().asr_worker_count.clamp(1, 8);
        let (job_tx, job_rx) = mpsc::channel::<AsrJob>(128);
        let (res_tx, res_rx) = mpsc::channel::<AsrResult>(128);
        let h1 = spawn(asr::run_worker_pool(job_rx, res_tx, workers, model));
        let h2 = spawn(global_result_consumer(
            res_rx,
            self.db.clone(),
            self.app.clone(),
            self.alerts.clone(),
            self.modes.clone(),
        ));
        *guard = Some(AsrPool { job_tx: job_tx.clone(), handles: vec![h1, h2] });
        log::info!("shared ASR pool started ({workers} workers, one shared model)");
        Some(job_tx)
    }

    /// Tear down the shared ASR pool (aborts workers + consumer, frees the model).
    fn clear_asr(&self) {
        if let Some(pool) = self.asr.lock().unwrap_or_else(|e| e.into_inner()).take() {
            for h in pool.handles {
                h.abort();
            }
        }
    }

    // ---- receiver CRUD ----

    pub fn add_receiver(&self, cfg: ReceiverConfig) -> Result<(), String> {
        self.db
            .add_receiver(
                &cfg.id,
                kind_str(&cfg.kind),
                &cfg.url,
                cfg.label.as_deref(),
                cfg.freq_hz,
                &cfg.mode,
                lane_str(&cfg.lane),
                cfg.antenna.as_deref(),
                cfg.region.as_deref(),
            )
            .map_err(|e| e.to_string())
    }

    pub fn set_favorite(&self, id: &str, favorite: bool) -> Result<(), String> {
        self.db.set_favorite(id, favorite).map_err(|e| e.to_string())
    }

    pub fn list_receivers(&self) -> Result<Vec<ReceiverConfig>, String> {
        let rows = self.db.list_receivers().map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(row_to_config).collect())
    }

    pub fn remove_receiver(&self, id: &str) -> Result<(), String> {
        self.stop_receiver(id);
        self.db.remove_receiver(id).map_err(|e| e.to_string())
    }

    fn get_config(&self, id: &str) -> Result<ReceiverConfig, String> {
        self.list_receivers()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| format!("receiver {id} not found"))
    }

    // ---- session lifecycle ----

    pub fn start_receiver(&self, id: &str) -> Result<(), String> {
        let cfg = self.get_config(id)?;
        if !matches!(
            cfg.kind,
            ReceiverKind::Kiwisdr | ReceiverKind::Openwebrx | ReceiverKind::Feed
        ) {
            return Err("unsupported source".into());
        }
        // Concurrency cap (restarting an already-running one is always allowed).
        {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if !sessions.contains_key(id) && sessions.len() >= MAX_SESSIONS {
                return Err(format!(
                    "at the {MAX_SESSIONS}-receiver limit — stop one before starting another"
                ));
            }
        }
        self.stop_receiver(id);
        self.modes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string(), cfg.mode.clone());

        // source -> tap -> lane
        let (raw_tx, raw_rx) = mpsc::channel::<AudioFrame>(256);
        let (pipe_tx, pipe_rx) = mpsc::channel::<AudioFrame>(256);
        let (telem_tx, telem_rx) = mpsc::channel::<SourceTelemetry>(64);
        let (digital_tx, digital_rx) = mpsc::channel::<Vec<crate::digital::DigitalMsg>>(64);
        let (tune_tx, tune_rx) = mpsc::channel::<u64>(8);
        let (ctl_tx, ctl_rx) = mpsc::channel::<crate::model::RadioCtl>(8);
        let cancel = Arc::new(AtomicBool::new(false));

        let mut tasks: Vec<JoinHandle<()>> = Vec::new();

        // 1. Source (connect + reconnect/backoff + live retune).
        {
            let app = self.app.clone();
            let cfg = cfg.clone();
            let id = id.to_string();
            let db = self.db.clone();
            let cancel = cancel.clone();
            tasks.push(spawn(source_loop(cfg, id, app, raw_tx, telem_tx, tune_rx, ctl_rx, db, cancel)));
        }

        // 2. Tap: spectrum (waterfall) + monitored audio + recording, then forward.
        //    Kept out of `tasks` so it self-terminates (and finalizes the WAV).
        let tap = {
            let app = self.app.clone();
            let id = id.to_string();
            let rec_dir = self.recordings_dir();
            let name = cfg.label.clone().unwrap_or_else(|| cfg.url.clone());
            spawn(audio_tap(
                id,
                app,
                raw_rx,
                pipe_tx,
                self.monitored.clone(),
                self.monitored_sub.clone(),
                self.watched.clone(),
                self.record_ids.clone(),
                rec_dir,
                name,
            ))
        };

        match cfg.lane {
            Lane::Voice => {
                // Feed the ONE shared ASR pool. If no model, drain locally so the
                // audio/waterfall pipeline never stalls.
                let asr_tx = match self.ensure_asr() {
                    Some(tx) => tx,
                    None => {
                        log::warn!("no whisper model found; transcription disabled (audio + telemetry still run)");
                        let (tx, mut rx) = mpsc::channel::<AsrJob>(64);
                        tasks.push(spawn(async move { while rx.recv().await.is_some() {} }));
                        tx
                    }
                };
                let id = id.to_string();
                tasks.push(spawn(audio::audio_pipeline(id, pipe_rx, asr_tx)));
            }
            Lane::Digital => {
                {
                    let db = self.db.clone();
                    let app = self.app.clone();
                    let id = id.to_string();
                    let mode = cfg.mode.clone();
                    let alerts = self.alerts.clone();
                    tasks.push(spawn(digital_consumer(digital_rx, db, app, id, mode, alerts)));
                }
                {
                    let id = id.to_string();
                    let mode = cfg.mode.clone();
                    tasks.push(spawn(digital_pipeline(id, pipe_rx, digital_tx, mode)));
                }
            }
        }

        // 3. Telemetry.
        {
            let db = self.db.clone();
            let app = self.app.clone();
            let id = id.to_string();
            tasks.push(spawn(telemetry_consumer(telem_rx, db, app, id)));
        }

        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        // Re-check the cap under the lock (guards against concurrent starts racing
        // past the earlier check).
        if !sessions.contains_key(id) && sessions.len() >= MAX_SESSIONS {
            cancel.store(true, Ordering::Relaxed);
            for h in &tasks {
                h.abort();
            }
            tap.abort();
            return Err(format!("at the {MAX_SESSIONS}-receiver limit — stop one first"));
        }
        // `tap` is dropped here (not stored) → detached; it self-terminates when
        // the source closes.
        sessions.insert(id.to_string(), Session { tasks, tune_tx, ctl_tx, cancel });
        Ok(())
    }

    /// Re-tune a receiver. Persists the freq and, if running, applies it live on
    /// the open socket (no reconnect) via the session's tune channel.
    pub fn tune(&self, id: &str, freq_hz: u64) -> Result<(), String> {
        self.db
            .update_receiver_freq(id, freq_hz)
            .map_err(|e| e.to_string())?;
        if let Some(sess) = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            let _ = sess.tune_tx.try_send(freq_hz); // best-effort live retune
        }
        Ok(())
    }

    /// Live filter / RF-gain change on a running receiver (KiwiSDR). Best-effort —
    /// no-op if the receiver isn't running or the source ignores control messages.
    pub fn set_radio_ctl(&self, id: &str, ctl: crate::model::RadioCtl) -> Result<(), String> {
        if let Some(sess) = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            let _ = sess.ctl_tx.try_send(ctl);
        }
        Ok(())
    }

    pub fn stop_receiver(&self, id: &str) {
        let removed = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        if removed.is_some() {
            events::emit_session(&self.app, id, SessionStatus::Stopped, None);
        }
    }

    pub fn running_ids(&self) -> Vec<String> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect()
    }

    // ---- audio monitor + recording ----

    pub fn set_monitor(&self, id: Option<String>) {
        // Never point the monitor at a receiver that isn't running — otherwise the
        // UI would show it ON AIR while no tap ever emits audio (phantom monitor).
        if let Some(ref s) = id {
            if !self.sessions.lock().unwrap_or_else(|e| e.into_inner()).contains_key(s) {
                return;
            }
        }
        *self.monitored.lock().unwrap_or_else(|e| e.into_inner()) = id;
    }

    /// Set (or clear) the SUB receiver streamed as the right channel.
    pub fn set_monitor_sub(&self, id: Option<String>) {
        if let Some(ref s) = id {
            if !self.sessions.lock().unwrap_or_else(|e| e.into_inner()).contains_key(s) {
                return;
            }
        }
        *self.monitored_sub.lock().unwrap_or_else(|e| e.into_inner()) = id;
    }

    /// Set which receivers' waterfalls are on screen (only these emit spectrum).
    pub fn set_watched(&self, ids: Vec<String>) {
        *self.watched.lock().unwrap_or_else(|e| e.into_inner()) = ids.into_iter().collect();
    }

    pub fn start_recording(&self, id: &str) {
        self.record_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string());
    }

    pub fn stop_recording(&self, id: &str) {
        self.record_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    pub fn recording_ids(&self) -> Vec<String> {
        self.record_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    // ---- transcripts ----

    pub fn query_transcripts(
        &self,
        receiver_id: Option<&str>,
        time_range: Option<(i64, i64)>,
        text_query: Option<&str>,
    ) -> Result<Vec<TranscriptRow>, String> {
        let rows = self
            .db
            .query_transcripts(receiver_id, time_range, text_query)
            .map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(row_to_transcript).collect())
    }

    // ---- logbook export ----

    /// Export decoded/transcribed traffic to an ADIF (.adi) or CSV (.csv) file in
    /// ~/.hamhawk/exports and return the path. `digital_only` limits it to the
    /// digital lane (FT8/CW/RTTY) — the rows that carry callsigns/grids.
    pub fn export_log(&self, format: &str, digital_only: bool) -> Result<String, String> {
        let rows = self
            .db
            .query_transcripts(None, None, None)
            .map_err(|e| e.to_string())?;
        // Map receiver_id -> (current freq_hz, label) for FREQ/station columns. The
        // freq is the receiver's CURRENT freq (best-effort; decodes don't store it).
        let meta: HashMap<String, (u64, String)> = self
            .list_receivers()
            .unwrap_or_default()
            .into_iter()
            .map(|c| (c.id.clone(), (c.freq_hz, c.label.unwrap_or(c.url))))
            .collect();

        let mut rows: Vec<_> = rows
            .into_iter()
            .map(row_to_transcript)
            .filter(|t| !digital_only || matches!(t.lane, Lane::Digital))
            .collect();
        rows.sort_by_key(|t| t.ts_start); // chronological for a logbook

        let ext = if format.eq_ignore_ascii_case("adif") || format.eq_ignore_ascii_case("adi") {
            "adi"
        } else {
            "csv"
        };
        let body = if ext == "adi" {
            export_adif(&rows, &meta)
        } else {
            export_csv(&rows, &meta)
        };

        let dir = data_dir().join("exports");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let path = dir.join(format!("hamhawk-log-{ts}.{ext}"));
        std::fs::write(&path, body).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().to_string())
    }

    // ---- bookmarks ----

    pub fn add_bookmark(&self, bm: Bookmark) -> Result<(), String> {
        self.db
            .add_bookmark(
                &bm.id,
                &bm.label,
                kind_str(&bm.kind),
                &bm.url,
                bm.freq_hz,
                &bm.mode,
                lane_str(&bm.lane),
            )
            .map_err(|e| e.to_string())
    }

    pub fn list_bookmarks(&self) -> Result<Vec<Bookmark>, String> {
        let rows = self.db.list_bookmarks().map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|(id, label, kind, url, freq_hz, mode, lane)| Bookmark {
                id,
                label,
                kind: parse_kind(&kind),
                url,
                freq_hz,
                mode,
                lane: parse_lane(&lane),
            })
            .collect())
    }

    pub fn remove_bookmark(&self, id: &str) -> Result<(), String> {
        self.db.remove_bookmark(id).map_err(|e| e.to_string())
    }

    // ---- alerts ----

    pub fn add_alert_rule(&self, rule: AlertRule) -> Result<(), String> {
        self.db
            .add_alert_rule(&rule.id, &rule.name, &rule.pattern, rule.enabled)
            .map_err(|e| e.to_string())?;
        *self.alerts.lock().unwrap_or_else(|e| e.into_inner()) = load_alert_rules(&self.db);
        Ok(())
    }

    pub fn list_alert_rules(&self) -> Result<Vec<AlertRule>, String> {
        let rows = self.db.list_alert_rules().map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|(id, name, pattern, enabled)| AlertRule { id, name, pattern, enabled })
            .collect())
    }

    pub fn remove_alert_rule(&self, id: &str) -> Result<(), String> {
        self.db.remove_alert_rule(id).map_err(|e| e.to_string())?;
        *self.alerts.lock().unwrap_or_else(|e| e.into_inner()) = load_alert_rules(&self.db);
        Ok(())
    }

    pub fn list_alert_hits(&self, limit: i64) -> Result<Vec<AlertHit>, String> {
        let rows = self.db.list_alert_hits(limit).map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|(rule_id, rule_name, receiver_id, ts_ms, text)| AlertHit {
                rule_id,
                rule_name,
                receiver_id,
                ts_ms,
                text,
            })
            .collect())
    }

    // ---- settings ----

    pub fn settings(&self) -> Settings {
        let count = self
            .db
            .get_setting("asr_worker_count")
            .ok()
            .flatten()
            .and_then(|s| s.parse().ok())
            .unwrap_or(2);
        // Treat a blank stored value as unset so a cleared field reads back as None.
        let model_path = self
            .db
            .get_setting("whisper_model_path")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty());
        let recording_dir = self
            .db
            .get_setting("recording_dir")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty());
        Settings { asr_worker_count: count, whisper_model_path: model_path, recording_dir }
    }

    /// Effective recordings folder: the configured one, else ~/.hamhawk/recordings.
    pub fn recordings_dir(&self) -> String {
        if let Some(d) = self.db.get_setting("recording_dir").ok().flatten() {
            if !d.trim().is_empty() {
                return d;
            }
        }
        data_dir().join("recordings").to_string_lossy().to_string()
    }

    pub fn set_settings(&self, settings: &Settings) -> Result<(), String> {
        self.db
            .set_setting("asr_worker_count", &settings.asr_worker_count.to_string())
            .map_err(|e| e.to_string())?;
        // Always write both keys (empty string when None) so clearing a field
        // actually persists instead of leaving the old value in the DB.
        self.db
            .set_setting("whisper_model_path", settings.whisper_model_path.as_deref().unwrap_or(""))
            .map_err(|e| e.to_string())?;
        self.db
            .set_setting("recording_dir", settings.recording_dir.as_deref().unwrap_or(""))
            .map_err(|e| e.to_string())?;
        // Drop the shared ASR pool so it rebuilds with the new model/worker count
        // next time a voice receiver starts.
        self.clear_asr();
        Ok(())
    }

    fn resolve_model_path(&self) -> Option<String> {
        if let Some(p) = self.settings().whisper_model_path {
            if Path::new(&p).is_file() {
                return Some(p);
            }
        }
        let default = models_dir().join("ggml-base.bin");
        if default.is_file() {
            return Some(default.to_string_lossy().to_string());
        }
        None
    }
}

// ---- logbook formatting ----

/// Best-effort callsign extraction: a token like K1ABC / W3ILT / DL1XYZ / VK2DEF —
/// 1-2 leading letters, a digit, then 1-3 trailing letters. Honest heuristic, not a
/// validator; returns the first match (uppercased) or None.
fn find_callsign(text: &str) -> Option<String> {
    for raw in text.split(|c: char| !c.is_ascii_alphanumeric() && c != '/') {
        let tok = raw.trim_matches('/');
        if tok.len() < 3 || tok.len() > 7 {
            continue;
        }
        let bytes = tok.as_bytes();
        let mut letters_pre = 0usize;
        let mut i = 0usize;
        while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
            letters_pre += 1;
            i += 1;
        }
        if !(1..=2).contains(&letters_pre) || i >= bytes.len() || !bytes[i].is_ascii_digit() {
            continue;
        }
        i += 1;
        let mut letters_post = 0usize;
        while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
            letters_post += 1;
            i += 1;
        }
        if i == bytes.len() && (1..=4).contains(&letters_post) {
            return Some(tok.to_ascii_uppercase());
        }
    }
    None
}

/// Best-effort Maidenhead grid: 2 letters A-R, 2 digits, optional 2 letters a-x.
fn find_grid(text: &str) -> Option<String> {
    for raw in text.split(|c: char| !c.is_ascii_alphanumeric()) {
        let t = raw;
        if !(t.len() == 4 || t.len() == 6) {
            continue;
        }
        let b = t.as_bytes();
        let f1 = b[0].to_ascii_uppercase();
        let f2 = b[1].to_ascii_uppercase();
        if !(b'A'..=b'R').contains(&f1) || !(b'A'..=b'R').contains(&f2) {
            continue;
        }
        if !b[2].is_ascii_digit() || !b[3].is_ascii_digit() {
            continue;
        }
        if t.len() == 6 {
            let s1 = b[4].to_ascii_lowercase();
            let s2 = b[5].to_ascii_lowercase();
            if !(b'a'..=b'x').contains(&s1) || !(b'a'..=b'x').contains(&s2) {
                continue;
            }
        }
        let mut g = String::new();
        g.push(f1 as char);
        g.push(f2 as char);
        g.push_str(&t[2..]);
        return Some(g);
    }
    None
}

fn adif_band(freq_hz: u64) -> &'static str {
    let m = freq_hz as f64 / 1e6;
    match m {
        x if (0.135..0.138).contains(&x) => "2190m",
        x if (1.8..2.0).contains(&x) => "160m",
        x if (3.5..4.0).contains(&x) => "80m",
        x if (5.0..5.5).contains(&x) => "60m",
        x if (7.0..7.3).contains(&x) => "40m",
        x if (10.1..10.15).contains(&x) => "30m",
        x if (14.0..14.35).contains(&x) => "20m",
        x if (18.0..18.2).contains(&x) => "17m",
        x if (21.0..21.45).contains(&x) => "15m",
        x if (24.8..25.0).contains(&x) => "12m",
        x if (28.0..29.7).contains(&x) => "10m",
        x if (50.0..54.0).contains(&x) => "6m",
        x if (144.0..148.0).contains(&x) => "2m",
        _ => "",
    }
}

fn adif_field(name: &str, val: &str) -> String {
    if val.is_empty() {
        String::new()
    } else {
        format!("<{}:{}>{}", name, val.len(), val)
    }
}

fn export_adif(rows: &[TranscriptRow], meta: &HashMap<String, (u64, String)>) -> String {
    let mut out = String::from(
        "ADIF export from HamHawk — received/decoded traffic (monitoring log, not 2-way QSOs).\n\
         <ADIF_VER:5>3.1.4<PROGRAMID:7>HamHawk<EOH>\n",
    );
    for t in rows {
        let freq_hz = meta.get(&t.receiver_id).map(|(f, _)| *f).unwrap_or(0);
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(t.ts_start)
            .unwrap_or_default();
        let date = dt.format("%Y%m%d").to_string();
        let time = dt.format("%H%M%S").to_string();
        let call = find_callsign(&t.text_en).unwrap_or_default();
        let grid = find_grid(&t.text_en).unwrap_or_default();
        let freq_mhz = if freq_hz > 0 { format!("{:.6}", freq_hz as f64 / 1e6) } else { String::new() };
        let snr = t.snr_db.map(|s| format!("{:.0}", s)).unwrap_or_default();
        let mode = t.mode.to_uppercase();
        let mut rec = String::new();
        rec.push_str(&adif_field("QSO_DATE", &date));
        rec.push_str(&adif_field("TIME_ON", &time));
        rec.push_str(&adif_field("CALL", &call));
        rec.push_str(&adif_field("GRIDSQUARE", &grid));
        rec.push_str(&adif_field("MODE", &mode));
        rec.push_str(&adif_field("FREQ", &freq_mhz));
        rec.push_str(&adif_field("BAND", adif_band(freq_hz)));
        if !snr.is_empty() {
            rec.push_str(&adif_field("APP_HAMHAWK_SNR", &snr));
        }
        rec.push_str(&adif_field("COMMENT", t.text_en.trim()));
        rec.push_str("<EOR>\n");
        out.push_str(&rec);
    }
    out
}

fn csv_escape(s: &str) -> String {
    if s.contains(['"', ',', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn export_csv(rows: &[TranscriptRow], meta: &HashMap<String, (u64, String)>) -> String {
    let mut out =
        String::from("timestamp_utc,station,freq_mhz,mode,lane,snr_db,callsign,grid,text\n");
    for t in rows {
        let (freq_hz, label) = meta.get(&t.receiver_id).cloned().unwrap_or((0, t.receiver_id.clone()));
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(t.ts_start)
            .unwrap_or_default();
        let lane = match t.lane {
            Lane::Voice => "voice",
            Lane::Digital => "digital",
        };
        let cols = [
            dt.format("%Y-%m-%d %H:%M:%S").to_string(),
            label,
            if freq_hz > 0 { format!("{:.6}", freq_hz as f64 / 1e6) } else { String::new() },
            t.mode.clone(),
            lane.to_string(),
            t.snr_db.map(|s| format!("{:.0}", s)).unwrap_or_default(),
            find_callsign(&t.text_en).unwrap_or_default(),
            find_grid(&t.text_en).unwrap_or_default(),
            t.text_en.trim().to_string(),
        ];
        out.push_str(&cols.iter().map(|c| csv_escape(c)).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    out
}

fn load_alert_rules(db: &Arc<Db>) -> Vec<AlertRule> {
    db.list_alert_rules()
        .unwrap_or_default()
        .into_iter()
        .map(|(id, name, pattern, enabled)| AlertRule { id, name, pattern, enabled })
        .collect()
}

// ---- background tasks ----

#[allow(clippy::too_many_arguments)]
async fn source_loop(
    mut cfg: ReceiverConfig,
    id: String,
    app: AppHandle,
    audio_tx: mpsc::Sender<AudioFrame>,
    telem_tx: mpsc::Sender<SourceTelemetry>,
    mut tune_rx: mpsc::Receiver<u64>,
    mut ctl_rx: mpsc::Receiver<crate::model::RadioCtl>,
    db: Arc<Db>,
    cancel: Arc<AtomicBool>,
) {
    let mut backoff = 1u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        // Pick up any retune that happened while disconnected so reconnects use it.
        if let Some(f) = db.get_receiver_freq(&id) {
            cfg.freq_hz = f;
        }
        events::emit_session(&app, &id, SessionStatus::Connecting, None);
        let result = match cfg.kind {
            ReceiverKind::Kiwisdr => {
                let app2 = app.clone();
                let id2 = id.clone();
                KiwiSDR::new(&cfg.url)
                    .with_config(cfg.clone())
                    .stream(
                        audio_tx.clone(),
                        telem_tx.clone(),
                        move || events::emit_session(&app2, &id2, SessionStatus::Live, None),
                        &mut tune_rx,
                        &mut ctl_rx,
                    )
                    .await
            }
            ReceiverKind::Openwebrx => {
                OpenWebRX::new(&cfg.url)
                    .with_config(cfg.clone())
                    .run(audio_tx.clone(), telem_tx.clone(), &app, &id, &mut tune_rx)
                    .await
            }
            ReceiverKind::Feed => {
                FeedSource::new(&cfg.url)
                    .run(audio_tx.clone(), telem_tx.clone(), &app, &id, cancel.clone())
                    .await
            }
        };
        match result {
            Ok(()) => {
                events::emit_session(&app, &id, SessionStatus::Stopped, None);
                return;
            }
            Err(e) => {
                events::emit_session(&app, &id, SessionStatus::Reconnecting, Some(e.to_string()));
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(30);
            }
        }
    }
}

/// Tap between source and lane: emit waterfall rows, stream monitored audio,
/// record to WAV, then forward the frame downstream.
#[allow(clippy::too_many_arguments)]
async fn audio_tap(
    id: String,
    app: AppHandle,
    mut raw_rx: mpsc::Receiver<AudioFrame>,
    pipe_tx: mpsc::Sender<AudioFrame>,
    monitored: Arc<Mutex<Option<String>>>,
    monitored_sub: Arc<Mutex<Option<String>>>,
    watched: Arc<Mutex<HashSet<String>>>,
    record_ids: Arc<Mutex<HashSet<String>>>,
    rec_dir: String,
    name: String,
) {
    let mut sg = Spectrogram::new(1024, 128);
    let mut writer: Option<hound::WavWriter<BufWriter<File>>> = None;

    while let Some(frame) = raw_rx.recv().await {
        // Snapshot the per-frame routing flags with one lock each (poison-tolerant
        // so an upstream panic can't cascade here).
        let want_spectrum = watched
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&id);
        let is_monitored = {
            let main = monitored.lock().unwrap_or_else(|e| e.into_inner());
            let sub = monitored_sub.lock().unwrap_or_else(|e| e.into_inner());
            main.as_deref() == Some(id.as_str()) || sub.as_deref() == Some(id.as_str())
        };
        let want_record = record_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&id);

        // Only the on-screen receivers compute + emit a waterfall (skip the FFT
        // entirely for off-screen ones).
        if want_spectrum {
            if let Some(bins) = sg.push(&frame.samples) {
                events::emit_spectrum(&app, SpectrumFrame { receiver_id: id.clone(), bins });
            }
        }

        if is_monitored {
            let bytes: Vec<u8> = frame
                .samples
                .iter()
                .flat_map(|&s| ((s * 32767.0).clamp(-32768.0, 32767.0) as i16).to_le_bytes())
                .collect();
            let pcm_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            events::emit_audio(
                &app,
                AudioChunk { receiver_id: id.clone(), sample_rate: frame.sample_rate, pcm_b64 },
            );
        }

        if want_record {
            if writer.is_none() {
                match open_wav(&rec_dir, &name, frame.sample_rate) {
                    Some(w) => {
                        writer = Some(w);
                        events::emit_recording(&app, &id, true, None);
                    }
                    None => {
                        // Couldn't open the file — clear the flag and tell the UI
                        // rather than leaving REC lit while nothing is written.
                        record_ids.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                        events::emit_recording(
                            &app,
                            &id,
                            false,
                            Some(format!("recording failed — can't write to {rec_dir}")),
                        );
                    }
                }
            }
            if let Some(w) = writer.as_mut() {
                for &s in &frame.samples {
                    let _ = w.write_sample((s * 32767.0).clamp(-32768.0, 32767.0) as i16);
                }
            }
        } else if let Some(w) = writer.take() {
            let _ = w.finalize();
            events::emit_recording(&app, &id, false, None);
        }

        if pipe_tx.send(frame).await.is_err() {
            break;
        }
    }
    // Session ended (stopped/dropped) while recording: finalize + tell the UI so
    // the REC indicator clears instead of sticking on.
    if let Some(w) = writer.take() {
        let _ = w.finalize();
        record_ids.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        events::emit_recording(&app, &id, false, None);
    }
}

fn sanitize_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
        .collect();
    let s = s.trim_matches('_').to_string();
    let s = if s.is_empty() { "rx".to_string() } else { s };
    s.chars().take(48).collect()
}

fn open_wav(dir: &str, name: &str, sample_rate: u32) -> Option<hound::WavWriter<BufWriter<File>>> {
    let dir = std::path::Path::new(dir);
    // Only write to an absolute, traversal-free directory. Legit user-picked dirs
    // are absolute; reject relative paths or any `..` component so a tampered
    // setting can't redirect recordings outside the intended location.
    if !dir.is_absolute()
        || dir
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        log::error!("refusing unsafe recordings dir: {}", dir.display());
        return None;
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        log::error!("failed to create recordings dir {}: {e}", dir.display());
        return None;
    }
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("{}-{ts}.wav", sanitize_name(name)));
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    match hound::WavWriter::create(&path, spec) {
        Ok(w) => {
            log::info!("recording -> {}", path.display());
            Some(w)
        }
        Err(e) => {
            log::error!("failed to open recording: {e}");
            None
        }
    }
}

fn check_alerts(text: &str, id: &str, ts: i64, alerts: &Alerts, db: &Arc<Db>, app: &AppHandle) {
    let lc = text.to_lowercase();
    let rules = alerts.lock().unwrap_or_else(|e| e.into_inner()).clone();
    for r in rules.iter().filter(|r| r.enabled && !r.pattern.is_empty()) {
        if lc.contains(&r.pattern.to_lowercase()) {
            let _ = db.insert_alert_hit(&r.id, &r.name, id, ts, text);
            events::emit_alert(
                app,
                AlertHit {
                    rule_id: r.id.clone(),
                    rule_name: r.name.clone(),
                    receiver_id: id.to_string(),
                    ts_ms: ts,
                    text: text.to_string(),
                },
            );
        }
    }
}

async fn digital_pipeline(
    _receiver_id: String,
    mut audio_rx: mpsc::Receiver<AudioFrame>,
    digital_tx: mpsc::Sender<Vec<crate::digital::DigitalMsg>>,
    mode: String,
) {
    let mut decoder: Box<dyn Decoder> = match mode.as_str() {
        "ft8" => Box::new(Ft8Decoder::new(Ft8Mode::Ft8, 12000)),
        "ft4" => Box::new(Ft8Decoder::new(Ft8Mode::Ft4, 12000)),
        "cw" => Box::new(CwDecoder::new(12000)),
        "psk31" => Box::new(PskRttyDecoder::new(PskRttyMode::Psk31, 12000)),
        "rtty" => Box::new(PskRttyDecoder::new(PskRttyMode::Rtty, 12000)),
        _ => Box::new(CwDecoder::new(12000)),
    };

    while let Some(frame) = audio_rx.recv().await {
        let messages = decoder.push(&frame);
        if !messages.is_empty() && digital_tx.send(messages).await.is_err() {
            return;
        }
    }
}

async fn digital_consumer(
    mut rx: mpsc::Receiver<Vec<crate::digital::DigitalMsg>>,
    db: Arc<Db>,
    app: AppHandle,
    id: String,
    mode: String,
    alerts: Alerts,
) {
    while let Some(msgs) = rx.recv().await {
        for msg in msgs {
            let new_id = match db.insert_transcript(
                &id, msg.ts_ms, msg.ts_ms, "digital", &mode, None, &msg.text, None, None,
                msg.snr_db,
            ) {
                Ok(new_id) => new_id,
                Err(e) => {
                    // DB write failed: don't emit a transcript the DB never stored
                    // (an id=0 row would desync the UI from the database).
                    log::error!("digital transcript insert failed for {id}: {e}");
                    continue;
                }
            };
            check_alerts(&msg.text, &id, msg.ts_ms, &alerts, &db, &app);
            events::emit_transcript(
                &app,
                TranscriptRow {
                    id: new_id,
                    receiver_id: id.clone(),
                    ts_start: msg.ts_ms,
                    ts_end: msg.ts_ms,
                    lane: Lane::Digital,
                    mode: mode.clone(),
                    src_lang: None,
                    text_en: msg.text.clone(),
                    text_native: None,
                    confidence: None,
                    snr_db: msg.snr_db,
                },
            );
        }
    }
}

/// Single consumer for the shared ASR pool: routes each result to its receiver
/// (by id) and labels it with that receiver's mode.
async fn global_result_consumer(
    mut rx: mpsc::Receiver<AsrResult>,
    db: Arc<Db>,
    app: AppHandle,
    alerts: Alerts,
    modes: Modes,
) {
    while let Some(r) = rx.recv().await {
        if r.text_en.is_empty() {
            continue;
        }
        let id = r.receiver_id.clone();
        let mode = modes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
            .unwrap_or_default();
        let new_id = match db.insert_transcript(
            &id, r.ts_start, r.ts_end, "voice", &mode, r.src_lang.as_deref(), &r.text_en, None,
            r.confidence, None,
        ) {
            Ok(new_id) => new_id,
            Err(e) => {
                // DB write failed: don't emit a transcript the DB never stored
                // (an id=0 row would desync the UI from the database).
                log::error!("voice transcript insert failed for {id}: {e}");
                continue;
            }
        };
        check_alerts(&r.text_en, &id, r.ts_start, &alerts, &db, &app);
        events::emit_transcript(
            &app,
            TranscriptRow {
                id: new_id,
                receiver_id: id,
                ts_start: r.ts_start,
                ts_end: r.ts_end,
                lane: Lane::Voice,
                mode,
                src_lang: r.src_lang,
                text_en: r.text_en,
                text_native: None,
                confidence: r.confidence,
                snr_db: None,
            },
        );
    }
}

async fn telemetry_consumer(
    mut rx: mpsc::Receiver<SourceTelemetry>,
    db: Arc<Db>,
    app: AppHandle,
    id: String,
) {
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut last_db = Instant::now() - Duration::from_secs(10);
    // Last persisted (s_meter_dbm, snr_db) — skip the INSERT when unchanged so a
    // stable signal doesn't write an identical row every interval.
    let mut last_stored: Option<(Option<f32>, Option<f32>)> = None;
    while let Some(t) = rx.recv().await {
        let now = Instant::now();
        if now.duration_since(last_emit) >= Duration::from_millis(250) {
            last_emit = now;
            events::emit_telemetry(
                &app,
                ModelTelemetry {
                    receiver_id: id.clone(),
                    status: SessionStatus::Live,
                    s_meter_dbm: t.s_meter_dbm,
                    snr_db: t.snr_db,
                    waterfall_row: None,
                },
            );
        }
        if now.duration_since(last_db) >= Duration::from_secs(5)
            && last_stored != Some((t.s_meter_dbm, t.snr_db))
        {
            last_db = now;
            last_stored = Some((t.s_meter_dbm, t.snr_db));
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let _ = db.insert_telemetry(&id, ts, t.s_meter_dbm, t.snr_db);
        }
    }
}

// ---- row <-> model mapping ----

fn kind_str(k: &ReceiverKind) -> &'static str {
    match k {
        ReceiverKind::Kiwisdr => "kiwisdr",
        ReceiverKind::Openwebrx => "openwebrx",
        ReceiverKind::Feed => "feed",
    }
}

fn lane_str(l: &Lane) -> &'static str {
    match l {
        Lane::Voice => "voice",
        Lane::Digital => "digital",
    }
}

fn parse_kind(s: &str) -> ReceiverKind {
    match s {
        "kiwisdr" => ReceiverKind::Kiwisdr,
        "feed" => ReceiverKind::Feed,
        _ => ReceiverKind::Openwebrx,
    }
}

fn parse_lane(s: &str) -> Lane {
    match s {
        "digital" => Lane::Digital,
        _ => Lane::Voice,
    }
}

type ReceiverRow = (
    String,
    String,
    String,
    Option<String>,
    u64,
    String,
    String,
    bool,
    bool,
    Option<String>,
    Option<String>,
);

fn row_to_config(r: ReceiverRow) -> ReceiverConfig {
    ReceiverConfig {
        id: r.0,
        kind: parse_kind(&r.1),
        url: r.2,
        label: r.3,
        freq_hz: r.4,
        mode: r.5,
        lane: parse_lane(&r.6),
        enabled: r.7,
        favorite: r.8,
        antenna: r.9,
        region: r.10,
    }
}

type TranscriptRowTuple = (
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
);

fn row_to_transcript(r: TranscriptRowTuple) -> TranscriptRow {
    TranscriptRow {
        id: r.0,
        receiver_id: r.1,
        ts_start: r.2,
        ts_end: r.3,
        lane: parse_lane(&r.4),
        mode: r.5,
        src_lang: r.6,
        text_en: r.7,
        text_native: r.8,
        confidence: r.9,
        snr_db: r.10,
    }
}
