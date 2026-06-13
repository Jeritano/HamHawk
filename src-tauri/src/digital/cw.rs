//! CW / Morse decoder — real DSP.
//!
//! Pipeline: detect the dominant CW tone in the passband (Goertzel bank) →
//! measure tone-power envelope in short hops → adaptive threshold (noise floor +
//! hysteresis) → key-up/key-down run lengths → adaptive dot-length tracking →
//! classify dot/dash and element/char/word gaps → Morse table → text.
//!
//! Emits a `DigitalMsg` only when real characters are decoded (on word/idle
//! boundaries). Never fabricates output.

use super::{Decoder, DigitalMsg};
use crate::source::AudioFrame;

/// Analysis hop length in seconds (envelope time resolution).
const HOP_SECS: f32 = 0.005;
/// Idle gap (seconds) after which a pending word is flushed.
const FLUSH_IDLE_SECS: f32 = 1.2;

pub struct CwDecoder {
    sample_rate: u32,
    hop: usize,
    sample_buf: Vec<f32>,
    tone_freq: f32,
    // Envelope / threshold tracking.
    noise_floor: f32,
    peak: f32,
    keyed: bool,
    run_hops: u32,    // length of current mark/space run in hops
    // Morse assembly.
    dot_hops: f32,    // adaptive dot length in hops
    symbol: String,   // dots/dashes for the current character
    word: String,     // decoded text not yet emitted
    last_ts_ms: i64,
}

impl CwDecoder {
    pub fn new(sample_rate: u32) -> Self {
        let hop = ((sample_rate as f32) * HOP_SECS).max(1.0) as usize;
        // 20 WPM default: dot = 1.2/wpm s.
        let dot_secs = 1.2 / 20.0;
        let dot_hops = (dot_secs / HOP_SECS).max(1.0);
        Self {
            sample_rate,
            hop,
            sample_buf: Vec::new(),
            tone_freq: 0.0,
            noise_floor: 1e-6,
            peak: 1e-6,
            keyed: false,
            run_hops: 0,
            dot_hops,
            symbol: String::new(),
            word: String::new(),
            last_ts_ms: 0,
        }
    }

    /// Goertzel power for `freq` over a window.
    fn goertzel(samples: &[f32], sample_rate: u32, freq: f32) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        let w = 2.0 * std::f32::consts::PI * freq / sample_rate as f32;
        let coeff = 2.0 * w.cos();
        let (mut s1, mut s2) = (0.0f32, 0.0f32);
        for &x in samples {
            let s0 = x + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        let power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
        power / samples.len() as f32
    }

    /// Pick the dominant tone in 350–950 Hz over a window (coarse search).
    fn detect_tone(&self, window: &[f32]) -> f32 {
        let mut best_f = 600.0;
        let mut best_p = 0.0;
        let mut f = 350.0;
        while f <= 950.0 {
            let p = Self::goertzel(window, self.sample_rate, f);
            if p > best_p {
                best_p = p;
                best_f = f;
            }
            f += 25.0;
        }
        best_f
    }

    /// Classify a finished mark (key-down) run and append to the symbol.
    fn on_mark(&mut self, hops: u32) {
        let l = hops as f32;
        let is_dash = l > 2.0 * self.dot_hops;
        if is_dash {
            self.symbol.push('-');
            // A dash is ~3 dots; fold its implied dot length into the estimate.
            self.dot_hops = self.dot_hops * 0.8 + (l / 3.0) * 0.2;
        } else {
            self.symbol.push('.');
            self.dot_hops = self.dot_hops * 0.8 + l * 0.2;
        }
        self.dot_hops = self.dot_hops.clamp(1.0, 400.0);
    }

    /// Classify a finished space (key-up) run; may close a character/word.
    fn on_space(&mut self, hops: u32) {
        let l = hops as f32;
        if l < 2.0 * self.dot_hops {
            // intra-character gap: nothing to do
            return;
        }
        // char or word boundary: decode the pending symbol
        self.flush_symbol();
        if l >= 5.0 * self.dot_hops && !self.word.ends_with(' ') && !self.word.is_empty() {
            self.word.push(' ');
        }
    }

    fn flush_symbol(&mut self) {
        if self.symbol.is_empty() {
            return;
        }
        if let Some(c) = morse_to_char(&self.symbol) {
            self.word.push(c);
        }
        self.symbol.clear();
    }

    /// Emit and clear the accumulated word, if any non-space content exists.
    fn take_word(&mut self) -> Option<DigitalMsg> {
        self.flush_symbol();
        let text = self.word.trim().to_string();
        self.word.clear();
        if text.is_empty() {
            None
        } else {
            Some(DigitalMsg {
                text,
                ts_ms: self.last_ts_ms,
                snr_db: None,
                meta: serde_json::json!({ "mode": "CW", "tone_hz": self.tone_freq }),
            })
        }
    }
}

impl Decoder for CwDecoder {
    fn push(&mut self, frame: &AudioFrame) -> Vec<DigitalMsg> {
        self.last_ts_ms = frame.ts_ms;
        self.sample_buf.extend_from_slice(&frame.samples);

        let mut out = Vec::new();
        let mut consumed = 0;
        while self.sample_buf.len() - consumed >= self.hop {
            let window = &self.sample_buf[consumed..consumed + self.hop];
            consumed += self.hop;

            // Re-detect tone occasionally (cheap) using the first keyed energy.
            if self.tone_freq == 0.0 {
                self.tone_freq = self.detect_tone(window);
            }
            let power = Self::goertzel(window, self.sample_rate, self.tone_freq).sqrt();

            // Adaptive threshold with hysteresis between noise floor and peak.
            self.peak = (self.peak * 0.99).max(power);
            if !self.keyed {
                self.noise_floor = self.noise_floor * 0.95 + power * 0.05;
            }
            let hi = self.noise_floor + 0.45 * (self.peak - self.noise_floor);
            let lo = self.noise_floor + 0.25 * (self.peak - self.noise_floor);

            let now_keyed = if self.keyed { power > lo } else { power > hi };

            if now_keyed == self.keyed {
                self.run_hops += 1;
            } else {
                // transition: classify the run that just ended
                if self.keyed {
                    self.on_mark(self.run_hops);
                } else {
                    self.on_space(self.run_hops);
                }
                self.keyed = now_keyed;
                self.run_hops = 1;
            }

            // Long idle while un-keyed → flush a pending word.
            let idle_hops = (FLUSH_IDLE_SECS / HOP_SECS) as u32;
            if !self.keyed && self.run_hops == idle_hops {
                if let Some(msg) = self.take_word() {
                    out.push(msg);
                }
            }
        }
        // Drop consumed samples.
        if consumed > 0 {
            self.sample_buf.drain(..consumed);
        }
        out
    }
}

/// Standard international Morse → character.
fn morse_to_char(code: &str) -> Option<char> {
    Some(match code {
        ".-" => 'A', "-..." => 'B', "-.-." => 'C', "-.." => 'D', "." => 'E',
        "..-." => 'F', "--." => 'G', "...." => 'H', ".." => 'I', ".---" => 'J',
        "-.-" => 'K', ".-.." => 'L', "--" => 'M', "-." => 'N', "---" => 'O',
        ".--." => 'P', "--.-" => 'Q', ".-." => 'R', "..." => 'S', "-" => 'T',
        "..-" => 'U', "...-" => 'V', ".--" => 'W', "-..-" => 'X', "-.--" => 'Y',
        "--.." => 'Z',
        "-----" => '0', ".----" => '1', "..---" => '2', "...--" => '3', "....-" => '4',
        "....." => '5', "-...." => '6', "--..." => '7', "---.." => '8', "----." => '9',
        ".-.-.-" => '.', "--..--" => ',', "..--.." => '?', "-..-." => '/',
        "-...-" => '=', ".-.-." => '+', "-....-" => '-', "---..." => ':',
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthesize CW audio for the given text at `wpm` and feed it through the decoder.
    fn synth_and_decode(text: &str, wpm: f32, sr: u32, tone: f32) -> String {
        let dot = 1.2 / wpm; // seconds
        let mut samples: Vec<f32> = Vec::new();
        let push_tone = |secs: f32, on: bool, samples: &mut Vec<f32>| {
            let n = (secs * sr as f32) as usize;
            for i in 0..n {
                let t = i as f32 / sr as f32;
                samples.push(if on { (2.0 * std::f32::consts::PI * tone * t).sin() * 0.6 } else { 0.0 });
            }
        };
        // lead-in silence to settle the noise floor
        push_tone(0.3, false, &mut samples);
        for ch in text.chars() {
            if ch == ' ' {
                push_tone(dot * 7.0, false, &mut samples);
                continue;
            }
            let code = char_to_morse(ch).unwrap();
            for (i, el) in code.chars().enumerate() {
                if i > 0 {
                    push_tone(dot, false, &mut samples); // intra-char gap
                }
                push_tone(if el == '-' { dot * 3.0 } else { dot }, true, &mut samples);
            }
            push_tone(dot * 3.0, false, &mut samples); // char gap
        }
        // trailing idle to force a flush
        push_tone(2.0, false, &mut samples);

        let mut dec = CwDecoder::new(sr);
        let mut decoded = String::new();
        // feed in chunks to exercise streaming
        for chunk in samples.chunks(1024) {
            let frame = AudioFrame { samples: chunk.to_vec(), sample_rate: sr, ts_ms: 0 };
            for m in dec.push(&frame) {
                decoded.push_str(&m.text);
                decoded.push(' ');
            }
        }
        decoded.trim().to_string()
    }

    fn char_to_morse(c: char) -> Option<&'static str> {
        Some(match c.to_ascii_uppercase() {
            'A' => ".-", 'B' => "-...", 'C' => "-.-.", 'D' => "-..", 'E' => ".",
            'F' => "..-.", 'G' => "--.", 'H' => "....", 'I' => "..", 'J' => ".---",
            'K' => "-.-", 'L' => ".-..", 'M' => "--", 'N' => "-.", 'O' => "---",
            'P' => ".--.", 'Q' => "--.-", 'R' => ".-.", 'S' => "...", 'T' => "-",
            'U' => "..-", 'V' => "...-", 'W' => ".--", 'X' => "-..-", 'Y' => "-.--",
            'Z' => "--..",
            '0' => "-----", '1' => ".----", '2' => "..---", '3' => "...--", '4' => "....-",
            '5' => ".....", '6' => "-....", '7' => "--...", '8' => "---..", '9' => "----.",
            _ => return None,
        })
    }

    #[test]
    fn decodes_paris() {
        let out = synth_and_decode("PARIS", 20.0, 12000, 600.0);
        assert!(out.contains("PARIS"), "decoded: {out:?}");
    }

    #[test]
    fn decodes_callsign_with_space() {
        let out = synth_and_decode("CQ DL7", 18.0, 12000, 700.0);
        assert!(out.contains("CQ") && out.contains("DL7"), "decoded: {out:?}");
    }
}
