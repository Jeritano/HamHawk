//! OpenWebRX source adapter.
//!
//! Protocol **ported from the real client** (jketterl/openwebrx `htdocs/openwebrx.js`
//! + `lib/AudioEngine.js`), not guessed:
//!   1. Send `SERVER DE CLIENT client=hamhawk type=receiver`.
//!   2. Send `{"type":"connectionproperties","params":{"output_rate":N,...}}`.
//!   3. Server replies with `CLIENT DE SERVER ...` and `{"type":"config",...}` JSON
//!      carrying `center_freq` and `audio_compression`.
//!   4. Once we know `center_freq`, send `{"type":"dspcontrol","action":"start"}`
//!      then the demod params (`offset_freq`, `mod`, passband, squelch).
//!   5. Binary frames are type-tagged by the first byte: 1=FFT, 2=audio, 3=2nd FFT,
//!      4=HD audio. Audio is raw S16LE or IMA-ADPCM-with-SYNC depending on
//!      `audio_compression`.
//!
//! NOTE: not yet validated against a live OpenWebRX server in CI; assumes the
//! server's default profile. It never fabricates audio — unknown/unsupported
//! payloads are skipped, never invented.

use super::{AudioFrame, SourceError, TelemetryFrame};
use crate::model::{ReceiverConfig, SessionStatus};
use futures::{SinkExt, StreamExt};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

/// Audio output rate we request (server resamples to it). 12 kHz matches the
/// KiwiSDR path, the whisper resampler input, and the digital decoders.
const OUTPUT_RATE: u32 = 12000;

pub struct OpenWebRX {
    url: String,
    config: Option<ReceiverConfig>,
}

impl OpenWebRX {
    pub fn new(url: &str) -> Self {
        Self { url: url.to_string(), config: None }
    }

    pub fn with_config(mut self, cfg: ReceiverConfig) -> Self {
        self.config = Some(cfg);
        self
    }

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

    fn passband(mode: &str) -> (i64, i64) {
        match mode {
            "am" | "amn" => (-4000, 4000),
            "lsb" => (-2700, -300),
            "cw" | "cwn" => (-400, 400),
            _ => (300, 2700), // usb / ssb
        }
    }

    pub async fn run(
        self,
        audio_tx: mpsc::Sender<AudioFrame>,
        _telem_tx: mpsc::Sender<TelemetryFrame>,
        app: &AppHandle,
        id: &str,
    ) -> Result<(), SourceError> {
        let cfg = self
            .config
            .as_ref()
            .ok_or_else(|| SourceError("no receiver config".into()))?;

        let ws_url = format!("{}/ws/", self.ws_origin());
        let (ws, _) = connect_async(&ws_url)
            .await
            .map_err(|e| SourceError(format!("ws connect failed: {e}")))?;
        let (mut write, mut read) = ws.split();

        // Handshake.
        write
            .send(Message::Text("SERVER DE CLIENT client=hamhawk type=receiver".to_string()))
            .await
            .map_err(|e| SourceError(format!("handshake send failed: {e}")))?;
        let props = serde_json::json!({
            "type": "connectionproperties",
            "params": { "output_rate": OUTPUT_RATE, "hd_output_rate": 48000 }
        });
        write
            .send(Message::Text(props.to_string()))
            .await
            .map_err(|e| SourceError(format!("connectionproperties send failed: {e}")))?;

        crate::events::emit_session(app, id, SessionStatus::Live, None);

        let mode = cfg.mode.to_lowercase();
        let (low_cut, high_cut) = Self::passband(&mode);
        let mut started = false;
        let mut compression = String::from("adpcm"); // OWRX default
        let mut adpcm = OwrxAdpcm::new();

        let result = loop {
            match read.next().await {
                Some(Ok(Message::Text(text))) => {
                    let t = text.trim();
                    if t.starts_with("CLIENT DE SERVER") {
                        continue;
                    }
                    let Ok(json) = serde_json::from_str::<serde_json::Value>(t) else {
                        continue;
                    };
                    if json.get("type").and_then(|v| v.as_str()) == Some("config") {
                        let value = &json["value"];
                        if let Some(c) = value.get("audio_compression").and_then(|v| v.as_str()) {
                            compression = c.to_string();
                        }
                        if !started {
                            if let Some(center) = value.get("center_freq").and_then(|v| v.as_i64()) {
                                let offset = cfg.freq_hz as i64 - center;
                                // Start DSP and send demod params.
                                let start = serde_json::json!({"type":"dspcontrol","action":"start"});
                                let params = serde_json::json!({
                                    "type": "dspcontrol",
                                    "params": {
                                        "low_cut": low_cut,
                                        "high_cut": high_cut,
                                        "offset_freq": offset,
                                        "mod": mode,
                                        "squelch_level": -150
                                    }
                                });
                                if write.send(Message::Text(start.to_string())).await.is_err()
                                    || write.send(Message::Text(params.to_string())).await.is_err()
                                {
                                    break Err(SourceError("dspcontrol send failed".into()));
                                }
                                started = true;
                            }
                        }
                    }
                }
                Some(Ok(Message::Binary(buf))) => {
                    if buf.is_empty() {
                        continue;
                    }
                    let msg_type = buf[0];
                    let payload = &buf[1..];
                    if msg_type != 2 {
                        continue; // 1=FFT, 3=2nd FFT, 4=HD audio — ignored
                    }
                    let pcm_i16: Vec<i16> = if compression == "adpcm" {
                        adpcm.decode_with_sync(payload)
                    } else {
                        // raw S16LE
                        payload
                            .chunks_exact(2)
                            .map(|c| i16::from_le_bytes([c[0], c[1]]))
                            .collect()
                    };
                    if pcm_i16.is_empty() {
                        continue;
                    }
                    let samples: Vec<f32> = pcm_i16.iter().map(|&s| s as f32 / 32768.0).collect();
                    let ts_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    if audio_tx
                        .send(AudioFrame { samples, sample_rate: OUTPUT_RATE, ts_ms })
                        .await
                        .is_err()
                    {
                        break Ok(()); // pipeline gone
                    }
                }
                Some(Ok(Message::Close(_))) => break Err(SourceError("connection closed".into())),
                Some(Ok(_)) => continue,
                Some(Err(e)) => break Err(SourceError(format!("ws error: {e}"))),
                None => break Err(SourceError("connection closed".into())),
            }
        };

        let _ = write.send(Message::Close(None)).await;
        result
    }
}

/// OpenWebRX IMA-ADPCM-with-SYNC codec, ported bit-for-bit from
/// `lib/AudioEngine.js` `ImaAdpcmCodec.decodeWithSync`. The stream is periodically
/// re-synchronized via a "SYNC" marker followed by 4 bytes of (stepIndex, predictor).
struct OwrxAdpcm {
    step_index: i32,
    predictor: i32,
    step: i32,
    synchronized: usize,
    phase: u8,
    sync_buf: [u8; 4],
    sync_idx: usize,
    sync_counter: i32,
}

const IMA_INDEX: [i32; 16] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const IMA_STEP: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
    494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272,
    2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const SYNC_WORD: [u8; 4] = *b"SYNC";

impl OwrxAdpcm {
    fn new() -> Self {
        Self {
            step_index: 0,
            predictor: 0,
            step: 0,
            synchronized: 0,
            phase: 0,
            sync_buf: [0; 4],
            sync_idx: 0,
            sync_counter: 0,
        }
    }

    fn decode_nibble(&mut self, nibble: u8) -> i16 {
        self.step_index = (self.step_index + IMA_INDEX[(nibble & 0x0F) as usize]).clamp(0, 88);
        let mut diff = self.step >> 3;
        if nibble & 1 != 0 {
            diff += self.step >> 2;
        }
        if nibble & 2 != 0 {
            diff += self.step >> 1;
        }
        if nibble & 4 != 0 {
            diff += self.step;
        }
        if nibble & 8 != 0 {
            diff = -diff;
        }
        self.predictor = (self.predictor + diff).clamp(-32768, 32767);
        self.step = IMA_STEP[self.step_index as usize];
        self.predictor as i16
    }

    fn decode_with_sync(&mut self, data: &[u8]) -> Vec<i16> {
        let mut out = Vec::with_capacity(data.len() * 2);
        for &b in data {
            match self.phase {
                0 => {
                    // Search for the "SYNC" marker (compare-then-advance).
                    let matched = b == SYNC_WORD[self.synchronized];
                    self.synchronized += 1;
                    if !matched {
                        self.synchronized = 0;
                    }
                    if self.synchronized == 4 {
                        self.sync_idx = 0;
                        self.phase = 1;
                    }
                }
                1 => {
                    // Read 4 bytes = (stepIndex: i16le, predictor: i16le).
                    self.sync_buf[self.sync_idx] = b;
                    self.sync_idx += 1;
                    if self.sync_idx == 4 {
                        self.step_index =
                            i16::from_le_bytes([self.sync_buf[0], self.sync_buf[1]]) as i32;
                        self.predictor =
                            i16::from_le_bytes([self.sync_buf[2], self.sync_buf[3]]) as i32;
                        self.step_index = self.step_index.clamp(0, 88);
                        self.sync_counter = 1000;
                        self.phase = 2;
                    }
                }
                _ => {
                    out.push(self.decode_nibble(b & 0x0F));
                    out.push(self.decode_nibble(b >> 4));
                    let c = self.sync_counter;
                    self.sync_counter -= 1;
                    if c == 0 {
                        self.synchronized = 0;
                        self.phase = 0;
                    }
                }
            }
        }
        out
    }
}

// Silence an unused-type warning for the WS stream alias on some platforms.
#[allow(dead_code)]
type OpenWebRXWs = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adpcm_sync_framing_decodes_after_marker() {
        // Build a stream: "SYNC" + (stepIndex=0, predictor=0) + a few data bytes.
        let mut data = Vec::new();
        data.extend_from_slice(b"SYNC");
        data.extend_from_slice(&0i16.to_le_bytes()); // stepIndex
        data.extend_from_slice(&0i16.to_le_bytes()); // predictor
        data.extend_from_slice(&[0x00, 0x11, 0x22]); // 6 nibbles of audio
        let mut codec = OwrxAdpcm::new();
        let out = codec.decode_with_sync(&data);
        assert_eq!(out.len(), 6, "expected 2 samples per data byte after sync");
    }

    #[test]
    fn adpcm_ignores_bytes_before_sync() {
        let mut data = vec![0xAA, 0xBB, 0xCC]; // junk, no SYNC
        data.extend_from_slice(&[0x00, 0x11]);
        let mut codec = OwrxAdpcm::new();
        assert!(codec.decode_with_sync(&data).is_empty());
    }
}
