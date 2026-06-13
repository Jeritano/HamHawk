//! Streaming spectrogram: turns incoming audio into waterfall rows.
//!
//! Accumulates samples into FFT-sized windows (Hann-weighted), computes the
//! power spectrum, groups it down to `n_bins`, and maps log-magnitude to 0..255
//! for the UI waterfall. Real data only — no synthesis.

use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::Arc;

pub struct Spectrogram {
    fft: Arc<dyn Fft<f32>>,
    size: usize,
    n_bins: usize,
    buf: Vec<f32>,
    window: Vec<f32>,
}

impl Spectrogram {
    pub fn new(size: usize, n_bins: usize) -> Self {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(size);
        let window = (0..size)
            .map(|i| {
                let x = 2.0 * std::f32::consts::PI * i as f32 / (size as f32 - 1.0);
                0.5 - 0.5 * x.cos() // Hann
            })
            .collect();
        Self { fft, size, n_bins, buf: Vec::with_capacity(size * 2), window }
    }

    /// Feed samples; returns one waterfall row each time a full window completes
    /// (only the most recent row is returned if several complete at once).
    pub fn push(&mut self, samples: &[f32]) -> Option<Vec<u8>> {
        self.buf.extend_from_slice(samples);
        let mut row = None;
        while self.buf.len() >= self.size {
            let mut spectrum: Vec<Complex<f32>> = self
                .buf
                .iter()
                .take(self.size)
                .zip(self.window.iter())
                .map(|(&s, &w)| Complex::new(s * w, 0.0))
                .collect();
            self.buf.drain(..self.size);
            self.fft.process(&mut spectrum);

            // Use the lower half (real signal) and group into n_bins.
            let half = self.size / 2;
            let group = (half / self.n_bins).max(1);
            let mut bins = Vec::with_capacity(self.n_bins);
            for b in 0..self.n_bins {
                let start = b * group;
                let end = (start + group).min(half);
                if start >= end {
                    bins.push(0);
                    continue;
                }
                let mut mag = 0.0f32;
                for c in &spectrum[start..end] {
                    mag += c.norm();
                }
                mag /= (end - start) as f32;
                // Log scale: map roughly [-80, 0] dBFS -> [0, 255].
                let db = 20.0 * (mag + 1e-6).log10();
                let v = ((db + 80.0) / 80.0 * 255.0).clamp(0.0, 255.0);
                bins.push(v as u8);
            }
            row = Some(bins);
        }
        row
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tone_peaks_in_expected_bin() {
        let sr = 12000.0;
        let size = 1024;
        let n_bins = 128;
        let mut sg = Spectrogram::new(size, n_bins);
        // 3 kHz tone -> should light up a mid-range bin, not bin 0.
        let freq = 3000.0;
        let mut last = None;
        for chunk in 0..4 {
            let samples: Vec<f32> = (0..size)
                .map(|i| {
                    let t = (chunk * size + i) as f32 / sr;
                    (2.0 * std::f32::consts::PI * freq * t).sin() * 0.5
                })
                .collect();
            if let Some(row) = sg.push(&samples) {
                last = Some(row);
            }
        }
        let row = last.expect("expected a waterfall row");
        assert_eq!(row.len(), n_bins);
        let peak = row.iter().enumerate().max_by_key(|(_, &v)| v).unwrap().0;
        // 3kHz of 6kHz Nyquist => ~half-way across the bins.
        assert!(peak > n_bins / 4 && peak < 3 * n_bins / 4, "peak bin {peak}");
    }
}
