//! PSK31 (BPSK + varicode) and RTTY (Baudot/ITA2 FSK) decoders — real DSP.
//!
//! Both are pure-Rust. They decode cleanly-synced signals correctly (verified by
//! the round-trip tests below); off-air robustness is limited by the simple
//! carrier/symbol sync and is the documented area for future hardening. Neither
//! ever fabricates output — no decode, no message.

use super::{Decoder, DigitalMsg};
use crate::source::AudioFrame;
use std::f32::consts::PI;

// ===================== RTTY =====================

const RTTY_BAUD: f32 = 45.45;
const RTTY_MARK: f32 = 2125.0;
const RTTY_SPACE: f32 = 2295.0; // mark + 170 Hz shift

#[derive(Clone, Copy)]
pub enum PskRttyMode {
    Psk31,
    Rtty,
}

pub struct PskRttyDecoder {
    inner: Inner,
}

enum Inner {
    Rtty(RttyState),
    Psk(PskState),
}

impl PskRttyDecoder {
    pub fn new(mode: PskRttyMode, sample_rate: u32) -> Self {
        let inner = match mode {
            PskRttyMode::Rtty => Inner::Rtty(RttyState::new(sample_rate)),
            PskRttyMode::Psk31 => Inner::Psk(PskState::new(sample_rate)),
        };
        Self { inner }
    }
}

impl Decoder for PskRttyDecoder {
    fn push(&mut self, frame: &AudioFrame) -> Vec<DigitalMsg> {
        match &mut self.inner {
            Inner::Rtty(s) => s.push(frame),
            Inner::Psk(s) => s.push(frame),
        }
    }
}

/// Sliding Goertzel power at `freq` over `window`.
fn goertzel(window: &[f32], sample_rate: u32, freq: f32) -> f32 {
    if window.is_empty() {
        return 0.0;
    }
    let w = 2.0 * PI * freq / sample_rate as f32;
    let coeff = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f32, 0.0f32);
    for &x in window {
        let s0 = x + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    s1 * s1 + s2 * s2 - coeff * s1 * s2
}

struct RttyState {
    sample_rate: u32,
    buf: Vec<f32>,
    samples_per_bit: f32,
    figs: bool,
    word: String,
    last_ts_ms: i64,
}

impl RttyState {
    fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            buf: Vec::new(),
            samples_per_bit: sample_rate as f32 / RTTY_BAUD,
            figs: false,
            word: String::new(),
            last_ts_ms: 0,
        }
    }

    /// Instantaneous bit value (true = mark = 1) over a one-bit window centered at `pos`.
    fn bit_at(&self, pos: f32) -> bool {
        let half = (self.samples_per_bit * 0.5) as isize;
        let center = pos as isize;
        let start = (center - half).max(0) as usize;
        let end = ((center + half) as usize).min(self.buf.len());
        if start >= end {
            return true;
        }
        let win = &self.buf[start..end];
        goertzel(win, self.sample_rate, RTTY_MARK) >= goertzel(win, self.sample_rate, RTTY_SPACE)
    }

    fn push(&mut self, frame: &AudioFrame) -> Vec<DigitalMsg> {
        self.last_ts_ms = frame.ts_ms;
        self.buf.extend_from_slice(&frame.samples);
        let bit = self.samples_per_bit;
        let mut out = Vec::new();

        // Need room for a full frame (start + 5 data + 1.5 stop) plus lookahead.
        let frame_len = (bit * 7.5).ceil() as usize;
        let mut pos = 0f32;
        while (pos as usize) + frame_len + 1 < self.buf.len() {
            // Look for a start bit: mark(1) -> space(0) transition.
            let here = self.bit_at(pos);
            let next = self.bit_at(pos + bit * 0.5);
            if here && !next {
                // Candidate start edge near pos + 0.25 bit. Sample data bit centers.
                let edge = pos + bit * 0.25;
                // Confirm start bit is space at its center.
                if self.bit_at(edge + bit * 0.5) {
                    pos += bit * 0.5;
                    continue;
                }
                let mut code = 0u8;
                for i in 0..5 {
                    let c = edge + bit * (1.5 + i as f32);
                    if self.bit_at(c) {
                        code |= 1 << i; // LSB first
                    }
                }
                // Verify stop bit is mark(1).
                let stop = self.bit_at(edge + bit * 6.5);
                if stop {
                    self.decode_baudot(code);
                    pos = edge + bit * 7.0;
                    continue;
                }
            }
            pos += bit * 0.25;
        }

        // Drop fully-consumed samples, keep a tail.
        let keep_from = (pos as usize).min(self.buf.len());
        if keep_from > 0 {
            self.buf.drain(..keep_from);
        }

        // Emit on a reasonable word boundary.
        if self.word.len() >= 8 || self.word.ends_with(' ') {
            if let Some(m) = self.take_word() {
                out.push(m);
            }
        }
        out
    }

    fn decode_baudot(&mut self, code: u8) {
        match code {
            0x1F => self.figs = false, // LTRS
            0x1B => self.figs = true,  // FIGS
            _ => {
                if let Some(c) = baudot(code, self.figs) {
                    self.word.push(c);
                }
            }
        }
    }

    fn take_word(&mut self) -> Option<DigitalMsg> {
        let text = self.word.trim().to_string();
        self.word.clear();
        if text.is_empty() {
            None
        } else {
            Some(DigitalMsg {
                text,
                ts_ms: self.last_ts_ms,
                snr_db: None,
                meta: serde_json::json!({ "mode": "RTTY" }),
            })
        }
    }
}

/// ITA2 / Baudot. Returns the character for a 5-bit code given the shift state.
fn baudot(code: u8, figs: bool) -> Option<char> {
    let ltrs = [
        '\0', 'E', '\n', 'A', ' ', 'S', 'I', 'U', '\r', 'D', 'R', 'J', 'N', 'F', 'C', 'K', 'T', 'Z',
        'L', 'W', 'H', 'Y', 'P', 'Q', 'O', 'B', 'G', '\0', 'M', 'X', 'V', '\0',
    ];
    let figs_tbl = [
        '\0', '3', '\n', '-', ' ', '\'', '8', '7', '\r', '$', '4', '\u{7}', ',', '!', ':', '(', '5',
        '+', ')', '2', '#', '6', '0', '1', '9', '?', '&', '\0', '.', '/', ';', '\0',
    ];
    let c = if figs { figs_tbl[code as usize] } else { ltrs[code as usize] };
    if c == '\0' {
        None
    } else {
        Some(c)
    }
}

// ===================== PSK31 =====================

const PSK_BAUD: f32 = 31.25;

struct PskState {
    sample_rate: u32,
    buf: Vec<f32>,
    sample_pos: u64, // absolute index of buf[0] in the stream (for phase continuity)
    carrier: f32,
    samples_per_sym: f32,
    prev_phase: Option<f32>,
    varicode_bits: String, // accumulating '0'/'1'
    word: String,
    last_ts_ms: i64,
}

impl PskState {
    fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            buf: Vec::new(),
            sample_pos: 0,
            carrier: 0.0,
            samples_per_sym: sample_rate as f32 / PSK_BAUD,
            prev_phase: None,
            varicode_bits: String::new(),
            word: String::new(),
            last_ts_ms: 0,
        }
    }

    /// Find the carrier. BPSK is a suppressed-carrier signal (especially during
    /// the all-reversals idle), so detecting the carrier directly finds sidebands.
    /// Squaring the signal yields a clean spectral line at 2×carrier independent of
    /// the phase modulation; we locate that and halve it.
    fn detect_carrier(&self, window: &[f32]) -> f32 {
        let sq: Vec<f32> = window.iter().map(|s| s * s).collect();
        let nyq = self.sample_rate as f32 / 2.0;
        let max2 = (2.0f32 * 2700.0).min(nyq - 1.0);
        let mut best_f = 2000.0;
        let mut best_p = 0.0;
        // Coarse pass over 2×[300, 2700].
        let mut f = 600.0;
        while f <= max2 {
            let p = goertzel(&sq, self.sample_rate, f);
            if p > best_p {
                best_p = p;
                best_f = f;
            }
            f += 31.25;
        }
        // Fine pass ±40 Hz at 1 Hz — carrier accuracy is critical for differential BPSK.
        let lo = (best_f - 40.0).max(200.0);
        let hi = (best_f + 40.0).min(nyq - 1.0);
        let mut f = lo;
        while f <= hi {
            let p = goertzel(&sq, self.sample_rate, f);
            if p > best_p {
                best_p = p;
                best_f = f;
            }
            f += 1.0;
        }
        best_f / 2.0
    }

    /// Average phase of the carrier over one symbol window via I/Q correlation.
    fn symbol_phase(&self, start: usize) -> Option<f32> {
        let n = self.samples_per_sym as usize;
        if start + n > self.buf.len() {
            return None;
        }
        let (mut i, mut q) = (0.0f32, 0.0f32);
        let w = 2.0 * PI * self.carrier / self.sample_rate as f32;
        for k in 0..n {
            let s = self.buf[start + k];
            // Absolute stream index keeps the reference oscillator continuous
            // across buffer drains between pushes.
            let abs = (self.sample_pos + (start + k) as u64) as f32;
            let ph = w * abs;
            i += s * ph.cos();
            q += s * ph.sin();
        }
        Some(q.atan2(i))
    }

    fn push(&mut self, frame: &AudioFrame) -> Vec<DigitalMsg> {
        self.last_ts_ms = frame.ts_ms;
        self.buf.extend_from_slice(&frame.samples);
        let n = self.samples_per_sym as usize;
        let mut out = Vec::new();

        if self.carrier == 0.0 && self.buf.len() >= n * 4 {
            self.carrier = self.detect_carrier(&self.buf[..n * 4]);
        }
        if self.carrier == 0.0 {
            return out;
        }

        let mut start = 0usize;
        while start + n <= self.buf.len() {
            if let Some(phase) = self.symbol_phase(start) {
                if let Some(prev) = self.prev_phase {
                    let mut d = (phase - prev).abs();
                    if d > PI {
                        d = 2.0 * PI - d;
                    }
                    // Phase reversal (~pi) => bit 0; no reversal => bit 1.
                    let bit = if d > PI / 2.0 { '0' } else { '1' };
                    self.varicode_bits.push(bit);
                    self.scan_varicode();
                }
                self.prev_phase = Some(phase);
            }
            start += n;
        }
        if start > 0 {
            self.buf.drain(..start);
            self.sample_pos += start as u64;
        }

        if self.word.len() >= 8 || self.word.ends_with(' ') {
            if let Some(m) = self.take_word() {
                out.push(m);
            }
        }
        out
    }

    /// Varicode characters never contain "00"; characters are separated by a run
    /// of zeros (idle is a long run). Trim leading zeros (separator/idle), then a
    /// complete symbol is everything up to the next "00".
    fn scan_varicode(&mut self) {
        loop {
            let trimmed_len = self.varicode_bits.trim_start_matches('0').len();
            if trimmed_len != self.varicode_bits.len() {
                self.varicode_bits = self.varicode_bits[self.varicode_bits.len() - trimmed_len..].to_string();
            }
            // Now starts with '1' (or empty). A symbol ends at the next "00".
            match self.varicode_bits.find("00") {
                Some(idx) => {
                    let symbol = self.varicode_bits[..idx].to_string();
                    // Keep the zeros; they get trimmed as the separator next iteration.
                    self.varicode_bits = self.varicode_bits[idx..].to_string();
                    if let Some(c) = varicode_to_char(&symbol) {
                        self.word.push(c);
                    }
                }
                None => break,
            }
        }
        // Bound growth if we never sync on a noisy/garbage stream.
        if self.varicode_bits.len() > 128 {
            self.varicode_bits.clear();
        }
    }

    fn take_word(&mut self) -> Option<DigitalMsg> {
        let text = self.word.trim().to_string();
        self.word.clear();
        if text.is_empty() {
            None
        } else {
            Some(DigitalMsg {
                text,
                ts_ms: self.last_ts_ms,
                snr_db: None,
                meta: serde_json::json!({ "mode": "PSK31", "carrier_hz": self.carrier }),
            })
        }
    }
}

/// PSK31 varicode -> character. Standard, high-confidence subset: space + a–z.
/// Bit patterns for which we are certain. Unknown patterns return `None` and are
/// skipped — we never guess a character. (Uppercase/digits/punctuation are a
/// documented gap to be filled from the full published varicode table.)
fn varicode_to_char(bits: &str) -> Option<char> {
    Some(match bits {
        "1" => ' ',
        "1011" => 'a', "1011111" => 'b', "101111" => 'c', "101101" => 'd', "11" => 'e',
        "111101" => 'f', "1011011" => 'g', "101011" => 'h', "1101" => 'i', "111101011" => 'j',
        "10111111" => 'k', "11011" => 'l', "111011" => 'm', "1111" => 'n', "111" => 'o',
        "111111" => 'p', "110111111" => 'q', "10101" => 'r', "10111" => 's', "101" => 't',
        "110111" => 'u', "1111011" => 'v', "1101011" => 'w', "11011111" => 'x', "1011101" => 'y',
        "111010101" => 'z',
        _ => return None,
    })
}

/// Inverse of `varicode_to_char` for the supported subset (used by tests).
#[cfg(test)]
fn char_to_varicode(c: char) -> Option<&'static str> {
    Some(match c {
        ' ' => "1",
        'a' => "1011", 'b' => "1011111", 'c' => "101111", 'd' => "101101", 'e' => "11",
        'f' => "111101", 'g' => "1011011", 'h' => "101011", 'i' => "1101", 'j' => "111101011",
        'k' => "10111111", 'l' => "11011", 'm' => "111011", 'n' => "1111", 'o' => "111",
        'p' => "111111", 'q' => "110111111", 'r' => "10101", 's' => "10111", 't' => "101",
        'u' => "110111", 'v' => "1111011", 'w' => "1101011", 'x' => "11011111", 'y' => "1011101",
        'z' => "111010101",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth_rtty(text: &str, sr: u32) -> Vec<f32> {
        let bit = sr as f32 / RTTY_BAUD;
        let mut out: Vec<f32> = Vec::new();
        let mut phase = 0f32;
        let tone = |freq: f32, nsamp: usize, out: &mut Vec<f32>, phase: &mut f32| {
            for _ in 0..nsamp {
                out.push((*phase).sin() * 0.6);
                *phase += 2.0 * PI * freq / sr as f32;
            }
        };
        let nbit = bit as usize;
        // idle mark
        tone(RTTY_MARK, nbit * 10, &mut out, &mut phase);
        let send_code = |code: u8, out: &mut Vec<f32>, phase: &mut f32| {
            tone(RTTY_SPACE, nbit, out, phase); // start bit (0)
            for i in 0..5 {
                let f = if (code >> i) & 1 == 1 { RTTY_MARK } else { RTTY_SPACE };
                tone(f, nbit, out, phase);
            }
            tone(RTTY_MARK, (bit * 1.5) as usize, out, phase); // 1.5 stop bits
        };
        for ch in text.chars() {
            // figures/letters handled simply: assume letters
            if let Some(code) = letter_code(ch) {
                send_code(code, &mut out, &mut phase);
            }
        }
        tone(RTTY_MARK, nbit * 10, &mut out, &mut phase);
        out
    }

    fn letter_code(c: char) -> Option<u8> {
        let ltrs = [
            '\0', 'E', '\n', 'A', ' ', 'S', 'I', 'U', '\r', 'D', 'R', 'J', 'N', 'F', 'C', 'K', 'T',
            'Z', 'L', 'W', 'H', 'Y', 'P', 'Q', 'O', 'B', 'G', '\0', 'M', 'X', 'V', '\0',
        ];
        ltrs.iter().position(|&x| x == c.to_ascii_uppercase()).map(|p| p as u8)
    }

    #[test]
    fn rtty_decodes_text() {
        let sr = 12000;
        let samples = synth_rtty("TEST", sr);
        let mut dec = RttyState::new(sr);
        let mut decoded = String::new();
        for chunk in samples.chunks(2048) {
            let f = AudioFrame { samples: chunk.to_vec(), sample_rate: sr, ts_ms: 0 };
            for m in dec.push(&f) {
                decoded.push_str(&m.text);
            }
        }
        // flush remainder
        decoded.push_str(&dec.take_word().map(|m| m.text).unwrap_or_default());
        assert!(decoded.contains("TEST"), "decoded: {decoded:?}");
    }

    #[test]
    fn baudot_roundtrip_letters() {
        // 'A' = 0x03 in ITA2.
        assert_eq!(baudot(0x03, false), Some('A'));
        assert_eq!(baudot(0x04, false), Some(' '));
    }

    /// Differential-BPSK encode `text` (varicode + "00" separators) at `carrier`.
    fn synth_psk(text: &str, sr: u32, carrier: f32) -> Vec<f32> {
        let n = (sr as f32 / PSK_BAUD) as usize;
        // Build the bit stream: preamble of reversals, then chars separated by 00.
        let mut bits = String::new();
        bits.push_str("0000000000"); // idle reversals to settle sync
        for ch in text.chars() {
            bits.push_str(char_to_varicode(ch).expect("char in subset"));
            bits.push_str("00");
        }
        // Differential modulation: bit '0' = phase reversal, '1' = no change.
        let mut samples = Vec::new();
        let mut phase = 0.0f32; // 0 or PI
        let mut idx = 0u64;
        for b in bits.chars() {
            if b == '0' {
                phase += PI;
            }
            for _ in 0..n {
                let t = idx as f32 / sr as f32;
                samples.push((2.0 * PI * carrier * t + phase).cos() * 0.6);
                idx += 1;
            }
        }
        samples
    }

    #[test]
    fn psk31_decodes_text() {
        let sr = 12000;
        let carrier = 1000.0;
        let samples = synth_psk("cq test", sr, carrier);
        let mut dec = PskState::new(sr);
        // Single push so carrier detect + symbol stream stay aligned.
        let frame = AudioFrame { samples, sample_rate: sr, ts_ms: 0 };
        let mut decoded = String::new();
        for m in dec.push(&frame) {
            decoded.push_str(&m.text);
        }
        decoded.push_str(&dec.take_word().map(|m| m.text).unwrap_or_default());
        assert!(decoded.contains("cq") && decoded.contains("test"), "decoded: {decoded:?}");
    }
}
