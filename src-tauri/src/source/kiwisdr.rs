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
use crate::model::ReceiverConfig;
use futures::{SinkExt, StreamExt};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
    /// Core connect + stream loop, decoupled from the UI. `on_live` runs once the
    /// connection is configured. `tune_rx` delivers live retune requests (new freq
    /// in Hz) which are applied on the open socket — no reconnect.
    pub async fn stream(
        self,
        audio_tx: mpsc::Sender<AudioFrame>,
        telem_tx: mpsc::Sender<TelemetryFrame>,
        mut on_live: impl FnMut() + Send,
        tune_rx: &mut mpsc::Receiver<u64>,
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

        // Fail fast instead of hanging on an unreachable/slow node.
        let ws = match tokio::time::timeout(Duration::from_secs(10), connect_async(&ws_url)).await {
            Err(_) => return Err(SourceError("connect timed out".into())),
            Ok(Err(e)) => return Err(SourceError(format!("ws connect failed: {e}"))),
            Ok(Ok((ws, _))) => ws,
        };
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

        on_live();

        // Keepalive is interleaved into the read loop (not a detached task) so a
        // session abort tears down both read + write halves immediately — no
        // leaked keepalive task or half-open connection on stop/switch.
        let mut adpcm = ImaAdpcm::new();
        let mut keepalive = tokio::time::interval(Duration::from_secs(5));
        let result = loop {
            tokio::select! {
                _ = keepalive.tick() => {
                    if write.send(Message::Text(String::from("SET keepalive"))).await.is_err() {
                        break Err(SourceError("connection closed".into()));
                    }
                }
                tuned = tune_rx.recv() => {
                    if let Some(f) = tuned {
                        // Live retune on the open socket (no reconnect).
                        let khz = f as f64 / 1000.0;
                        let (lc, hc) = Self::passband(&mode);
                        let cmd = format!("SET mod={mode} low_cut={lc} high_cut={hc} freq={khz:.2}");
                        if write.send(Message::Text(cmd)).await.is_err() {
                            break Err(SourceError("connection closed".into()));
                        }
                    }
                }
                msg = read.next() => match msg {
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
                    }
                    Some(Ok(Message::Close(_))) => break Err(SourceError("connection closed".into())),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break Err(SourceError(format!("ws error: {e}"))),
                    None => break Err(SourceError("connection closed".into())),
                }
            }
        };

        result
    }
}

// Silence unused-type warnings for the WS stream alias on some platforms.
#[allow(dead_code)]
type KiwiWs = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::model::{Lane, ReceiverConfig, ReceiverKind};

    // Connects to a real public KiwiSDR and verifies audio frames actually arrive.
    // Ignored by default (network + hits someone's RX); run manually:
    //   cargo test live_kiwi_audio -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits a live public KiwiSDR"]
    async fn live_kiwi_audio() {
        let cfg = ReceiverConfig {
            id: "t".into(),
            kind: ReceiverKind::Kiwisdr,
            url: "http://kphsdr.com:8073".into(),
            label: None,
            freq_hz: 10_000_000,
            mode: "am".into(),
            lane: Lane::Voice,
            enabled: true,
        };
        let (atx, mut arx) = mpsc::channel::<AudioFrame>(256);
        let (ttx, _trx) = mpsc::channel::<TelemetryFrame>(64);
        let (_tune_tx, mut tune_rx) = mpsc::channel::<u64>(8);
        let sdr = KiwiSDR::new(&cfg.url).with_config(cfg);
        let stream = sdr.stream(atx, ttx, || println!("LIVE: configured, audio expected"), &mut tune_rx);
        tokio::pin!(stream);

        let mut frames = 0usize;
        let mut samples = 0usize;
        let res = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                tokio::select! {
                    r = &mut stream => return format!("stream ended early: {r:?}"),
                    f = arx.recv() => match f {
                        Some(fr) => { frames += 1; samples += fr.samples.len();
                            if frames >= 20 { return "ok".into(); } }
                        None => return "channel closed".into(),
                    }
                }
            }
        }).await;

        println!("LIVE result: {res:?}  frames={frames} samples={samples}");
        assert!(frames > 0, "no audio frames from live KiwiSDR ({res:?})");
    }
}
