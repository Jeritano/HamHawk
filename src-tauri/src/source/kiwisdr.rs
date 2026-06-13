//! KiwiSDR source adapter.
//!
//! Protocol mirrors jks-prv/kiwiclient:
//! - WS connect to `ws://host:port/<timestamp>/SND` (timestamp = epoch seconds,
//!   used as a cache-buster; we generate it locally — there is no `?action=identify`).
//! - Send `SET auth t=kiwi p=<pwd>` then audio config (`SET mod=... freq=...`, AGC,
//!   compression). Audio arrives as binary frames tagged `SND`.
//! - SND frame layout: "SND"(3) + flags(1) + seq(4, LE) + smeter(2, BE) + ADPCM.
//!   RSSI dBm = 0.1 * (smeter & 0x0FFF) - 127.
//! - ADPCM decoder state is continuous across frames (one `ImaAdpcm` per run).

use super::{AudioFrame, SourceError, TelemetryFrame};
use crate::audio::adpcm::ImaAdpcm;
use crate::model::{ReceiverConfig, SessionStatus};
use futures::{SinkExt, StreamExt};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

const AUDIO_RATE: u32 = 12000;

pub struct KiwiSDR {
    url: String,
    config: Option<ReceiverConfig>,
}

impl KiwiSDR {
    pub fn new(url: &str) -> Self {
        Self { url: url.to_string(), config: None }
    }

    pub fn with_config(mut self, cfg: ReceiverConfig) -> Self {
        self.config = Some(cfg);
        self
    }

    /// Normalize a user-supplied base URL into a `ws://`/`wss://` origin.
    fn ws_origin(&self) -> String {
        let u = self.url.trim().trim_end_matches('/');
        if let Some(rest) = u.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = u.strip_prefix("http://") {
            format!("ws://{rest}")
        } else if u.starts_with("ws://") || u.starts_with("wss://") {
            u.to_string()
        } else {
            format!("ws://{u}")
        }
    }

    fn passband(mode: &str) -> (f64, f64) {
        match mode {
            "am" | "amn" => (-4000.0, 4000.0),
            "cw" | "cwn" => (300.0, 800.0),
            _ => (300.0, 2700.0), // usb / lsb / ssb
        }
    }

    /// Connect, configure, and stream until the connection drops or errors.
    /// Emits `SessionStatus::Live` once configured. Returns `Err` on disconnect so
    /// the caller can apply reconnect backoff.
    pub async fn run(
        self,
        audio_tx: mpsc::Sender<AudioFrame>,
        telem_tx: mpsc::Sender<TelemetryFrame>,
        app: &AppHandle,
        id: &str,
    ) -> Result<(), SourceError> {
        let cfg = self
            .config
            .as_ref()
            .ok_or_else(|| SourceError("no receiver config".into()))?;

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let ws_url = format!("{}/{}/SND", self.ws_origin(), ts);

        let (ws, _) = connect_async(&ws_url)
            .await
            .map_err(|e| SourceError(format!("ws connect failed: {e}")))?;
        let (mut write, mut read) = ws.split();

        // --- handshake / configuration ---
        let freq_khz = cfg.freq_hz as f64 / 1000.0;
        let mode = cfg.mode.to_lowercase();
        let (low_cut, high_cut) = Self::passband(&mode);

        let setup = [
            "SET auth t=kiwi p=".to_string(),
            "SET ident_user=HamHawk".to_string(),
            format!("SET AR OK in={AUDIO_RATE} out=48000"),
            format!(
                "SET mod={mode} low_cut={low_cut} high_cut={high_cut} freq={freq_khz:.2}"
            ),
            "SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50".to_string(),
            "SET compression=1".to_string(),
            "SET squelch=0 max=0".to_string(),
        ];
        for cmd in setup {
            write
                .send(Message::Text(cmd))
                .await
                .map_err(|e| SourceError(format!("config send failed: {e}")))?;
        }

        // Keepalive: KiwiSDR drops idle clients.
        let keepalive = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            loop {
                tick.tick().await;
                if write
                    .send(Message::Text(String::from("SET keepalive")))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });

        crate::events::emit_session(app, id, SessionStatus::Live, None);

        let mut adpcm = ImaAdpcm::new();
        let result = loop {
            match read.next().await {
                Some(Ok(Message::Binary(buf))) => {
                    if buf.len() < 3 {
                        continue;
                    }
                    let tag = &buf[0..3];
                    if tag == b"SND" {
                        if buf.len() < 10 {
                            continue;
                        }
                        let smeter = u16::from_be_bytes([buf[8], buf[9]]);
                        let rssi = 0.1 * ((smeter & 0x0FFF) as f32) - 127.0;
                        let _ = telem_tx.try_send(TelemetryFrame {
                            s_meter_dbm: Some(rssi),
                            snr_db: None,
                        });

                        let pcm = adpcm.decode(&buf[10..]);
                        let ts_ms = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0);
                        if audio_tx
                            .send(AudioFrame { samples: pcm, sample_rate: AUDIO_RATE, ts_ms })
                            .await
                            .is_err()
                        {
                            break Ok(()); // pipeline gone
                        }
                    } else if tag == b"MSG" {
                        let text = String::from_utf8_lossy(&buf[3..]);
                        if text.contains("badp=1") {
                            break Err(SourceError("authentication rejected".into()));
                        }
                        if text.contains("too_busy") {
                            break Err(SourceError("server full (too_busy)".into()));
                        }
                    }
                    // other tags (waterfall "W/F", "STA", etc.) ignored in P1
                }
                Some(Ok(Message::Close(_))) => break Err(SourceError("connection closed".into())),
                Some(Ok(_)) => continue, // ping/pong/text we don't use
                Some(Err(e)) => break Err(SourceError(format!("ws error: {e}"))),
                None => break Err(SourceError("connection closed".into())),
            }
        };

        keepalive.abort();
        result
    }
}

// Silence unused-type warnings for the WS stream alias on some platforms.
#[allow(dead_code)]
type KiwiWs = WebSocketStream<MaybeTlsStream<TcpStream>>;
