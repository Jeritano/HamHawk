//! Silence-bounded audio segmentation, driven by the VAD's per-frame decision.
//!
//! Accumulates frames once speech starts; closes a segment after ~700 ms of
//! trailing silence or once it hits the 25 s cap. Segments shorter than 1.2 s are
//! discarded. Frames are 20 ms (320 samples @ 16 kHz), matching the VAD.

/// 700 ms of trailing silence at 20 ms/frame.
const SILENCE_LIMIT_FRAMES: u32 = 35;
/// 25 s cap.
const MAX_SAMPLES: usize = 25 * 16000;
/// 1.2 s minimum.
const MIN_SAMPLES: usize = (1.2 * 16000.0) as usize;

pub struct Segment {
    pub samples: Vec<f32>,
    pub ts_start: i64,
    pub ts_end: i64,
}

pub struct Segmenter {
    buffer: Vec<f32>,
    trailing_silence: u32,
    in_speech: bool,
    start_ts: i64,
    last_ts: i64,
}

impl Segmenter {
    pub fn new() -> Self {
        Self {
            buffer: Vec::new(),
            trailing_silence: 0,
            in_speech: false,
            start_ts: 0,
            last_ts: 0,
        }
    }

    /// Push one VAD frame plus its speaking decision and timestamp.
    pub fn push(&mut self, frame: &[f32], speaking: bool, ts_ms: i64) {
        if speaking {
            if !self.in_speech {
                self.in_speech = true;
                self.start_ts = ts_ms;
                self.buffer.clear();
            }
            self.buffer.extend_from_slice(frame);
            self.trailing_silence = 0;
            self.last_ts = ts_ms;
        } else if self.in_speech {
            // Keep appending through short gaps so words stay joined, but count it.
            self.buffer.extend_from_slice(frame);
            self.trailing_silence += 1;
            self.last_ts = ts_ms;
        }
    }

    /// Emit a finished segment if one is ready.
    pub fn try_emit(&mut self) -> Option<Segment> {
        if !self.in_speech {
            return None;
        }
        let silence_done = self.trailing_silence >= SILENCE_LIMIT_FRAMES;
        let max_reached = self.buffer.len() >= MAX_SAMPLES;
        if !(silence_done || max_reached) {
            return None;
        }

        let long_enough = self.buffer.len() >= MIN_SAMPLES;
        let start_ts = self.start_ts;
        let last_ts = self.last_ts;
        let samples = std::mem::take(&mut self.buffer);
        self.reset();

        if long_enough {
            Some(Segment { samples, ts_start: start_ts, ts_end: last_ts })
        } else {
            log::debug!(
                "segmenter: discarded {} ms segment ({} samples, below {} ms minimum)",
                last_ts.saturating_sub(start_ts),
                samples.len(),
                (MIN_SAMPLES * 1000) / 16000
            );
            None // too short: discarded
        }
    }

    fn reset(&mut self) {
        self.buffer.clear();
        self.trailing_silence = 0;
        self.in_speech = false;
    }
}

impl Default for Segmenter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::vad::FRAME_SAMPLES;

    fn frame() -> Vec<f32> {
        vec![0.1f32; FRAME_SAMPLES]
    }

    #[test]
    fn short_burst_is_discarded() {
        let mut seg = Segmenter::new();
        // ~0.2s of speech (well under the 1.2s minimum), then silence.
        for _ in 0..10 {
            seg.push(&frame(), true, 0);
        }
        for _ in 0..SILENCE_LIMIT_FRAMES {
            seg.push(&frame(), false, 0);
        }
        assert!(seg.try_emit().is_none());
    }

    #[test]
    fn long_speech_then_silence_emits() {
        let mut seg = Segmenter::new();
        // 2s of speech: 100 frames * 320 = 32000 samples > MIN_SAMPLES.
        for i in 0..100 {
            seg.push(&frame(), true, i);
        }
        for _ in 0..SILENCE_LIMIT_FRAMES {
            seg.push(&frame(), false, 100);
        }
        let out = seg.try_emit().expect("segment should emit");
        assert!(out.samples.len() >= MIN_SAMPLES);
        assert_eq!(out.ts_start, 0);
        assert_eq!(out.ts_end, 100);
    }

    #[test]
    fn ts_start_precedes_ts_end() {
        let mut seg = Segmenter::new();
        for i in 0..100 {
            seg.push(&frame(), true, i * 10);
        }
        for _ in 0..SILENCE_LIMIT_FRAMES {
            seg.push(&frame(), false, 2000);
        }
        let out = seg.try_emit().unwrap();
        assert!(out.ts_start < out.ts_end);
    }
}
