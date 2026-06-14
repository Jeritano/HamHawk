//! Internet audio-stream source (e.g. a Broadcastify scanner feed, or any MP3/AAC
//! stream URL). HTTP body → symphonia decode → mono f32 frames into the same
//! pipeline as the SDR sources (so feeds get transcription/recording too).
//!
//! Not an SDR: no frequency, no S-meter, no tuning. The user supplies the stream
//! URL (Broadcastify's catalog API is license-gated, so we don't browse it).

use super::{AudioFrame, SourceError, TelemetryFrame};
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::AppHandle;
use tokio::sync::mpsc;

pub struct FeedSource {
    url: String,
}

impl FeedSource {
    pub fn new(url: &str) -> Self {
        Self { url: url.to_string() }
    }

    pub async fn run(
        self,
        audio_tx: mpsc::Sender<AudioFrame>,
        _telem_tx: mpsc::Sender<TelemetryFrame>,
        app: &AppHandle,
        id: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<(), SourceError> {
        let (tx, mut rx) = mpsc::channel::<AudioFrame>(64);
        let url = self.url.clone();
        let dcancel = cancel.clone();
        let decode = tokio::task::spawn_blocking(move || decode_stream(&url, tx, dcancel));

        let mut live = false;
        while let Some(frame) = rx.recv().await {
            if !live {
                crate::events::emit_session(app, id, crate::model::SessionStatus::Live, None);
                live = true;
            }
            if audio_tx.send(frame).await.is_err() {
                cancel.store(true, Ordering::Relaxed); // stop the detached decoder/HTTP thread
                break; // pipeline gone
            }
        }
        // Decoder ended (EOF/error) — surface an Err so the caller reconnects.
        match decode.await {
            Ok(Ok(())) => Err(SourceError("feed ended".into())),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(SourceError("decode task panicked".into())),
        }
    }
}

/// A `Sync` streaming reader fed by a background HTTP-reader thread (so it can be
/// handed to symphonia, which requires `Read + Seek + Send + Sync`).
struct StreamReader {
    rx: Mutex<std_mpsc::Receiver<Vec<u8>>>,
    buf: Vec<u8>,
    pos: usize,
}

impl Read for StreamReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.buf.len() {
            match self.rx.lock().unwrap().recv() {
                Ok(chunk) => {
                    self.buf = chunk;
                    self.pos = 0;
                }
                Err(_) => return Ok(0), // upstream closed = EOF
            }
        }
        let n = (out.len()).min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

impl io::Seek for StreamReader {
    fn seek(&mut self, _: io::SeekFrom) -> io::Result<u64> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "stream is not seekable"))
    }
}

impl MediaSource for StreamReader {
    fn is_seekable(&self) -> bool {
        false
    }
    fn byte_len(&self) -> Option<u64> {
        None
    }
}

fn decode_stream(url: &str, out: mpsc::Sender<AudioFrame>, cancel: Arc<AtomicBool>) -> Result<(), SourceError> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| SourceError(format!("client: {e}")))?;
    let resp = client
        .get(url)
        .header("User-Agent", "HamHawk/0.1")
        .send()
        .map_err(|e| SourceError(format!("feed connect failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(SourceError(format!("feed HTTP {}", resp.status())));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Background thread pumps HTTP body chunks to the StreamReader.
    let (chunk_tx, chunk_rx) = std_mpsc::channel::<Vec<u8>>();
    let hcancel = cancel.clone();
    std::thread::spawn(move || {
        let mut resp = resp;
        let mut buf = [0u8; 8192];
        loop {
            if hcancel.load(Ordering::Relaxed) {
                break;
            }
            match resp.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if chunk_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let reader = StreamReader { rx: Mutex::new(chunk_rx), buf: Vec::new(), pos: 0 };
    let mss = MediaSourceStream::new(Box::new(reader), Default::default());

    let mut hint = Hint::new();
    if content_type.contains("mpeg") {
        hint.with_extension("mp3");
    } else if content_type.contains("aac") {
        hint.with_extension("aac");
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| SourceError(format!("feed format probe failed: {e}")))?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| SourceError("feed: no audio track".into()))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| SourceError(format!("feed decoder: {e}")))?;

    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut buf_cap = 0u64; // dims the scratch buffer was sized for
    let mut buf_rate = 0u32;
    let mut buf_ch = 0usize;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => return Ok(()), // EOF / read error -> ended
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue, // skip bad frame
            Err(_) => return Ok(()),
        };
        let spec = *decoded.spec();
        let rate = spec.rate;
        let channels = spec.channels.count().max(1);
        let cap = decoded.capacity() as u64;
        // (Re)allocate the scratch buffer when the stream's spec or frame size
        // changes — reusing a buffer sized for a different/smaller spec would
        // panic or corrupt audio (rare, but some streams switch mid-flight).
        if sample_buf.is_none() || cap > buf_cap || buf_rate != rate || buf_ch != channels {
            sample_buf = Some(SampleBuffer::<f32>::new(cap, spec));
            buf_cap = cap;
            buf_rate = rate;
            buf_ch = channels;
        }
        let sb = sample_buf.as_mut().unwrap();
        sb.copy_interleaved_ref(decoded);
        let inter = sb.samples();

        // Downmix to mono.
        let frames = inter.len() / channels;
        let mut mono = Vec::with_capacity(frames);
        for f in 0..frames {
            let mut s = 0.0f32;
            for c in 0..channels {
                s += inter[f * channels + c];
            }
            mono.push(s / channels as f32);
        }
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if out
            .blocking_send(AudioFrame { samples: mono, sample_rate: rate, ts_ms: ts })
            .is_err()
        {
            return Ok(()); // consumer gone
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Decodes a real public MP3 stream to prove the feed path (HTTP -> symphonia ->
    // PCM frames). Ignored by default. Run: cargo test live_feed -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits a public internet audio stream"]
    async fn live_feed_decodes() {
        let (tx, mut rx) = mpsc::channel::<AudioFrame>(64);
        let url = "https://ice1.somafm.com/groovesalad-128-mp3".to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        let h = tokio::task::spawn_blocking(move || decode_stream(&url, tx, cancel));
        let mut frames = 0usize;
        let mut samples = 0usize;
        let mut rate = 0u32;
        let _ = tokio::time::timeout(Duration::from_secs(25), async {
            while let Some(f) = rx.recv().await {
                frames += 1;
                samples += f.samples.len();
                rate = f.sample_rate;
                if frames >= 30 {
                    break;
                }
            }
        })
        .await;
        drop(rx);
        let _ = h.await;
        println!("FEED frames={frames} samples={samples} rate={rate}");
        assert!(frames > 0, "no decoded audio frames from feed");
    }
}
