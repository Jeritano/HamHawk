use crate::asr::{self, AsrResult};
use crate::audio::{self, AsrJob};
use crate::digital::cw::CwDecoder;
use crate::digital::ft8::{Ft8Decoder, Ft8Mode};
use crate::digital::psk_rtty::{PskRttyDecoder, PskRttyMode};
use crate::digital::Decoder;
use crate::events;
use crate::model::{
    Lane, ReceiverConfig, ReceiverKind, Settings, TelemetryFrame as ModelTelemetry, TranscriptRow,
};
use crate::source::kiwisdr::KiwiSDR;
use crate::source::openwebrx::OpenWebRX;
use crate::source::{AudioFrame, TelemetryFrame as SourceTelemetry};
use crate::store::db::{models_dir, Db};
use crate::model::SessionStatus;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// All tasks belonging to one running receiver session. Dropping/aborting these
/// tears the whole pipeline down (the source task's senders close, cascading).
struct Session {
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        for h in &self.tasks {
            h.abort();
        }
    }
}

pub struct Orchestrator {
    db: Arc<Db>,
    app: AppHandle,
    sessions: Mutex<HashMap<String, Session>>,
}

impl Orchestrator {
    pub fn new(db: Db, app: AppHandle) -> Self {
        Self {
            db: Arc::new(db),
            app,
            sessions: Mutex::new(HashMap::new()),
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
            )
            .map_err(|e| e.to_string())
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
        
        // For P2, we're expanding support to OpenWebRX and digital modes
        if !matches!(cfg.kind, ReceiverKind::Kiwisdr | ReceiverKind::Openwebrx) {
            return Err("only KiwiSDR and OpenWebRX are supported".into());
        }

        // Clean restart if already running.
        self.stop_receiver(id);

        let (audio_tx, audio_rx) = mpsc::channel::<AudioFrame>(256);
        let (telem_tx, telem_rx) = mpsc::channel::<SourceTelemetry>(64);
        let (asr_tx, asr_rx) = mpsc::channel::<AsrJob>(64);
        let (result_tx, result_rx) = mpsc::channel::<AsrResult>(64);
        let (digital_tx, digital_rx) = mpsc::channel::<Vec<crate::digital::DigitalMsg>>(64);

        let mut tasks: Vec<JoinHandle<()>> = Vec::new();

        // 1. Source (connect + reconnect/backoff loop).
        {
            let app = self.app.clone();
            let cfg = cfg.clone();
            let id = id.to_string();
            tasks.push(tokio::spawn(source_loop(cfg, id, app, audio_tx, telem_tx)));
        }

        match cfg.lane {
            Lane::Voice => {
                // Voice processing pipeline
                // 2. Audio pipeline -> ASR jobs.
                {
                    let id = id.to_string();
                    tasks.push(tokio::spawn(audio::audio_pipeline(id, audio_rx, asr_tx)));
                }

                // 3. ASR worker pool (or a drain if no model is available).
                match self.resolve_model_path() {
                    Some(model_path) => {
                        let workers = self.settings().asr_worker_count.clamp(1, 8);
                        tasks.push(tokio::spawn(asr::run_worker_pool(
                            asr_rx, result_tx, workers, model_path,
                        )));
                    }
                    None => {
                        log::warn!("no whisper model found; transcription disabled (audio + telemetry still run)");
                        drop(result_tx);
                        tasks.push(tokio::spawn(async move {
                            let mut asr_rx = asr_rx;
                            while asr_rx.recv().await.is_some() {}
                        }));
                    }
                }

                // 4. ASR results -> DB + transcript events.
                {
                    let db = self.db.clone();
                    let app = self.app.clone();
                    let id = id.to_string();
                    let mode = cfg.mode.clone();
                    tasks.push(tokio::spawn(result_consumer(result_rx, db, app, id, mode)));
                }
            }
            Lane::Digital => {
                // Digital processing pipeline
                // 2. Digital decoder -> DB + transcript events.
                {
                    let db = self.db.clone();
                    let app = self.app.clone();
                    let id = id.to_string();
                    let mode = cfg.mode.clone();
                    tasks.push(tokio::spawn(digital_consumer(digital_rx, db, app, id, mode)));
                }
                
                // 3. Audio to digital decoder
                {
                    let id = id.to_string();
                    let mode = cfg.mode.clone();
                    tasks.push(tokio::spawn(digital_pipeline(id, audio_rx, digital_tx, mode)));
                }
            }
        }

        // 5. Telemetry -> throttled events + periodic DB snapshots.
        {
            let db = self.db.clone();
            let app = self.app.clone();
            let id = id.to_string();
            tasks.push(tokio::spawn(telemetry_consumer(telem_rx, db, app, id)));
        }

        self.sessions
            .lock()
            .unwrap()
            .insert(id.to_string(), Session { tasks });
        Ok(())
    }

    pub fn stop_receiver(&self, id: &str) {
        let removed = self.sessions.lock().unwrap().remove(id);
        if removed.is_some() {
            // Session's Drop aborts the tasks.
            events::emit_session(&self.app, id, SessionStatus::Stopped, None);
        }
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

    // ---- settings ----

    pub fn settings(&self) -> Settings {
        let count = self
            .db
            .get_setting("asr_worker_count")
            .ok()
            .flatten()
            .and_then(|s| s.parse().ok())
            .unwrap_or(2);
        let model_path = self.db.get_setting("whisper_model_path").ok().flatten();
        Settings {
            asr_worker_count: count,
            whisper_model_path: model_path,
        }
    }

    pub fn set_settings(&self, settings: &Settings) -> Result<(), String> {
        self.db
            .set_setting("asr_worker_count", &settings.asr_worker_count.to_string())
            .map_err(|e| e.to_string())?;
        if let Some(ref path) = settings.whisper_model_path {
            self.db
                .set_setting("whisper_model_path", path)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Resolve a usable Whisper model file: configured path first, then the
    /// default `~/.hamhawk/models/ggml-base.bin`.
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

// ---- background tasks (free functions; no &self borrow held across .await) ----

async fn source_loop(
    cfg: ReceiverConfig,
    id: String,
    app: AppHandle,
    audio_tx: mpsc::Sender<AudioFrame>,
    telem_tx: mpsc::Sender<SourceTelemetry>,
) {
    let mut backoff = 1u64;
    loop {
        events::emit_session(&app, &id, SessionStatus::Connecting, None);
        let result = match cfg.kind {
            ReceiverKind::Kiwisdr => {
                let sdr = KiwiSDR::new(&cfg.url).with_config(cfg.clone());
                sdr.run(audio_tx.clone(), telem_tx.clone(), &app, &id).await
            }
            ReceiverKind::Openwebrx => {
                let sdr = OpenWebRX::new(&cfg.url).with_config(cfg.clone());
                sdr.run(audio_tx.clone(), telem_tx.clone(), &app, &id).await
            }
        };
        
        match result {
            Ok(()) => {
                // Pipeline closed downstream: nothing more to do.
                events::emit_session(&app, &id, SessionStatus::Stopped, None);
                return;
            }
            Err(e) => {
                events::emit_session(
                    &app,
                    &id,
                    SessionStatus::Reconnecting,
                    Some(e.to_string()),
                );
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(30);
            }
        }
    }
}

async fn digital_pipeline(
    _receiver_id: String,
    mut audio_rx: mpsc::Receiver<AudioFrame>,
    digital_tx: mpsc::Sender<Vec<crate::digital::DigitalMsg>>,
    mode: String,
) {
    // Create appropriate decoder based on mode
    let mut decoder: Box<dyn Decoder> = match mode.as_str() {
        "ft8" => Box::new(Ft8Decoder::new(Ft8Mode::Ft8, 12000)),
        "ft4" => Box::new(Ft8Decoder::new(Ft8Mode::Ft4, 12000)),
        "cw" => Box::new(CwDecoder::new(12000)),
        "psk31" => Box::new(PskRttyDecoder::new(PskRttyMode::Psk31, 12000)),
        "rtty" => Box::new(PskRttyDecoder::new(PskRttyMode::Rtty, 12000)),
        _ => {
            // Default to CW decoder for unknown modes
            Box::new(CwDecoder::new(12000))
        }
    };

    while let Some(frame) = audio_rx.recv().await {
        let messages = decoder.push(&frame);
        if !messages.is_empty() && digital_tx.send(messages).await.is_err() {
            return; // Consumer gone
        }
    }
}

async fn digital_consumer(
    mut rx: mpsc::Receiver<Vec<crate::digital::DigitalMsg>>,
    db: Arc<Db>,
    app: AppHandle,
    id: String,
    mode: String,
) {
    while let Some(msgs) = rx.recv().await {
        for msg in msgs {
            let new_id = db
                .insert_transcript(
                    &id,
                    msg.ts_ms,
                    msg.ts_ms + 1000, // Approximate end time
                    "digital",
                    &mode,
                    None, // No source language for digital modes
                    &msg.text,
                    None,
                    None, // No confidence for digital modes
                    msg.snr_db,
                )
                .unwrap_or(0);

            events::emit_transcript(
                &app,
                TranscriptRow {
                    id: new_id,
                    receiver_id: id.clone(),
                    ts_start: msg.ts_ms,
                    ts_end: msg.ts_ms + 1000,
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

async fn result_consumer(
    mut rx: mpsc::Receiver<AsrResult>,
    db: Arc<Db>,
    app: AppHandle,
    id: String,
    mode: String,
) {
    while let Some(r) = rx.recv().await {
        if r.text_en.is_empty() {
            continue;
        }
        let new_id = db
            .insert_transcript(
                &id,
                r.ts_start,
                r.ts_end,
                "voice",
                &mode,
                r.src_lang.as_deref(),
                &r.text_en,
                None,
                r.confidence,
                None,
            )
            .unwrap_or(0);

        events::emit_transcript(
            &app,
            TranscriptRow {
                id: new_id,
                receiver_id: id.clone(),
                ts_start: r.ts_start,
                ts_end: r.ts_end,
                lane: Lane::Voice,
                mode: mode.clone(),
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
    while let Some(t) = rx.recv().await {
        let now = Instant::now();
        // Emit to UI at <= 4 Hz.
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
        // Persist a snapshot every ~5 s.
        if now.duration_since(last_db) >= Duration::from_secs(5) {
            last_db = now;
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let _ = db.insert_telemetry(&id, ts, t.s_meter_dbm, t.snr_db);
        }
    }
}

// ---- row <-> model mapping helpers ----

fn kind_str(k: &ReceiverKind) -> &'static str {
    match k {
        ReceiverKind::Kiwisdr => "kiwisdr",
        ReceiverKind::Openwebrx => "openwebrx",
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
        _ => ReceiverKind::Openwebrx,
    }
}

fn parse_lane(s: &str) -> Lane {
    match s {
        "digital" => Lane::Digital,
        _ => Lane::Voice,
    }
}

type ReceiverRow = (String, String, String, Option<String>, u64, String, String, bool);

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
