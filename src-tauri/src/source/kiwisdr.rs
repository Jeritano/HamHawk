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
use crate::model::{RadioCtl, ReceiverConfig};
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
        let with_scheme = if let Some(rest) = u.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = u.strip_prefix("http://") {
            format!("ws://{rest}")
        } else if u.starts_with("ws://") || u.starts_with("wss://") {
            u.to_string()
        } else {
            format!("ws://{u}")
        };
        // KiwiSDR servers listen on 8073. If the URL omits the port (common with
        // `*.proxy.kiwisdr.com` entries), add it — otherwise the WS dials the
        // scheme default (80/443), the node isn't there, and the session just
        // loops connecting -> reconnecting forever.
        Self::ensure_port(&with_scheme, 8073)
    }

    /// Append `:default` if the URL's authority has no explicit port. Leaves
    /// IPv6 literals and already-ported URLs untouched. Assumes a base URL with
    /// no path component (which is how receiver URLs are stored).
    fn ensure_port(ws_url: &str, default: u16) -> String {
        match ws_url.split_once("://") {
            Some((scheme, authority))
                if !authority.is_empty()
                    && !authority.starts_with('[')
                    && !authority.contains(':') =>
            {
                format!("{scheme}://{authority}:{default}")
            }
            _ => ws_url.to_string(),
        }
    }

    fn passband(mode: &str) -> (f64, f64) {
        match mode {
            "am" | "amn" => (-4000.0, 4000.0),
            "cw" | "cwn" => (300.0, 800.0),
            // Digital decoders (FT8/FT4/PSK/RTTY) run on USB audio and need the
            // full ~0-3 kHz spectrum, not the narrow voice passband.
            "ft8" | "ft4" | "psk31" | "rtty" => (100.0, 3000.0),
            _ => (300.0, 2700.0), // usb / lsb / ssb voice
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
        ctl_rx: &mut mpsc::Receiver<RadioCtl>,
        // Last user-applied filter/RF-gain to re-apply after handshake (so a
        // reconnect doesn't silently revert the sliders).
        initial_ctl: Option<RadioCtl>,
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
        // These track the LIVE radio state so a retune preserves a custom filter and
        // a filter change preserves the current freq (each `SET mod=...` carries all
        // three: mode, passband, freq).
        let mut cur_freq_khz = cfg.freq_hz as f64 / 1000.0;
        let mode = cfg.mode.to_lowercase();
        // What we send to the SDR (a valid KiwiSDR demod) vs. the HamHawk mode that
        // selects the in-app decoder. Digital modes demod as USB.
        let demod = super::sdr_demod(&mode);
        let (mut low_cut, mut high_cut) = Self::passband(&mode);
        let mut agc_on = true;
        let mut man_gain = 50i32;
        // Seed initial radio state from the snapshot the orchestrator passed in
        // (preserved across reconnects). Only fields the user actually set.
        if let Some(c) = &initial_ctl {
            if let Some(v) = c.low_cut { low_cut = v; }
            if let Some(v) = c.high_cut { high_cut = v; }
            if let Some(v) = c.agc { agc_on = v; }
            if let Some(v) = c.man_gain { man_gain = v.clamp(0, 120); }
        }
        let agc_line = |on: bool, g: i32| {
            format!("SET agc={} hang=0 thresh=-100 slope=6 decay=1000 manGain={g}", on as i32)
        };

        let setup = [
            "SET auth t=kiwi p=".to_string(),
            "SET ident_user=HamHawk".to_string(),
            format!("SET AR OK in={AUDIO_RATE} out=48000"),
            format!(
                "SET mod={demod} low_cut={low_cut} high_cut={high_cut} freq={cur_freq_khz:.2}"
            ),
            agc_line(agc_on, man_gain),
            "SET compression=1".to_string(),
            "SET squelch=0 max=0".to_string(),
        ];
        for cmd in setup {
            write
                .send(Message::Text(cmd))
                .await
                .map_err(|e| SourceError(format!("config send failed: {e}")))?;
        }

        // Live is signaled on the FIRST real audio frame, not here — sending the
        // config doesn't mean the server accepted it. A rejected config (badp=1,
        // too_busy) or a silent node would otherwise show "Live" with no audio.
        let mut live_signaled = false;

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
                        // Live retune on the open socket (no reconnect). Keep the
                        // current (possibly customized) passband, don't reset it.
                        cur_freq_khz = f as f64 / 1000.0;
                        let cmd = format!("SET mod={demod} low_cut={low_cut} high_cut={high_cut} freq={cur_freq_khz:.2}");
                        if write.send(Message::Text(cmd)).await.is_err() {
                            break Err(SourceError("connection closed".into()));
                        }
                    }
                }
                ctl = ctl_rx.recv() => {
                    if let Some(c) = ctl {
                        // Live filter / RF-gain change. Apply only the provided fields,
                        // re-sending the full mod line (carries freq + passband) and the
                        // AGC line so a partial update can't desync the radio.
                        if let Some(v) = c.low_cut { low_cut = v; }
                        if let Some(v) = c.high_cut { high_cut = v; }
                        if let Some(v) = c.agc { agc_on = v; }
                        if let Some(v) = c.man_gain { man_gain = v.clamp(0, 120); }
                        let modcmd = format!("SET mod={demod} low_cut={low_cut} high_cut={high_cut} freq={cur_freq_khz:.2}");
                        let gaincmd = agc_line(agc_on, man_gain);
                        if write.send(Message::Text(modcmd)).await.is_err()
                            || write.send(Message::Text(gaincmd)).await.is_err()
                        {
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
                            // Audio is flowing — definitely Live (if the MSG path
                            // below didn't already mark it).
                            if !live_signaled {
                                on_live();
                                live_signaled = true;
                            }
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
                            // Server accepted the connection and is talking (not a
                            // rejection) — the link is up, so mark Live now rather
                            // than waiting for the first audio frame. Meters/spectrum
                            // still only move on real data, so a silent frequency
                            // shows Live with a flat meter (honest, no fabrication).
                            if !live_signaled {
                                on_live();
                                live_signaled = true;
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
mod tests {
    use super::*;

    fn origin(url: &str) -> String {
        KiwiSDR::new(url).ws_origin()
    }

    #[test]
    fn port_less_url_defaults_to_8073() {
        // The bug: proxy URLs without a port dialed ws default 80 and looped.
        assert_eq!(origin("http://w3ilt.proxy.kiwisdr.com"), "ws://w3ilt.proxy.kiwisdr.com:8073");
        assert_eq!(origin("w3ilt.proxy.kiwisdr.com"), "ws://w3ilt.proxy.kiwisdr.com:8073");
        assert_eq!(origin("https://example.com/"), "wss://example.com:8073");
    }

    #[test]
    fn explicit_port_is_preserved() {
        assert_eq!(origin("http://kphsdr.com:8073"), "ws://kphsdr.com:8073");
        assert_eq!(origin("http://wessex.zapto.org:8074"), "ws://wessex.zapto.org:8074");
        assert_eq!(origin("ws://host:9000"), "ws://host:9000");
    }
}

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
            favorite: false,
            antenna: None,
            region: None,
        };
        let (atx, mut arx) = mpsc::channel::<AudioFrame>(256);
        let (ttx, _trx) = mpsc::channel::<TelemetryFrame>(64);
        let (_tune_tx, mut tune_rx) = mpsc::channel::<u64>(8);
        let (_ctl_tx, mut ctl_rx) = mpsc::channel::<RadioCtl>(8);
        let sdr = KiwiSDR::new(&cfg.url).with_config(cfg);
        let stream = sdr.stream(atx, ttx, || println!("LIVE: configured, audio expected"), &mut tune_rx, &mut ctl_rx, None);
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
