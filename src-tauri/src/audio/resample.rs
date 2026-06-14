//! Streaming resampler to 16 kHz (Whisper's required rate) using rubato.
//!
//! `SincFixedIn` consumes a fixed input block per call, so this wraps it with an
//! input buffer: feed arbitrary-length chunks via `process`, get back whatever
//! whole output blocks are ready. The resampler is created once and keeps its
//! filter state across calls (no per-frame rebuild, no boundary clicks).

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

const BLOCK: usize = 1024;

pub struct Resampler16k {
    inner: Option<SincFixedIn<f32>>,
    from_sr: u32,
    in_buf: Vec<f32>,
    // Reusable scratch for the per-block drain, to avoid a heap alloc each block
    // in this realtime path. Reset before each use.
    block: Vec<f32>,
}

impl Resampler16k {
    pub fn new() -> Self {
        Self { inner: None, from_sr: 0, in_buf: Vec::new(), block: Vec::with_capacity(BLOCK) }
    }

    fn ensure(&mut self, from_sr: u32) {
        if self.from_sr == from_sr && (self.inner.is_some() || from_sr == 16000 || from_sr == 0) {
            return;
        }
        self.from_sr = from_sr;
        self.in_buf.clear();
        if from_sr == 16000 || from_sr == 0 {
            self.inner = None;
            return;
        }
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };
        let ratio = 16000.0 / from_sr as f64;
        // max_resample_ratio_relative = 2.0 (we never change the ratio, headroom is fine).
        let r = SincFixedIn::<f32>::new(ratio, 2.0, params, BLOCK, 1)
            .expect("failed to build resampler");
        self.inner = Some(r);
    }

    /// Feed input at `from_sr`; returns 16 kHz samples that are ready. Some input
    /// may remain buffered until a full block accumulates. A mid-stream change of
    /// `from_sr` resets filter state and discards any sub-block remnant from the
    /// previous rate (it cannot be flushed through `SincFixedIn`'s fixed block).
    pub fn process(&mut self, samples: &[f32], from_sr: u32) -> Vec<f32> {
        self.ensure(from_sr);
        if self.inner.is_none() {
            // Already 16k (or unknown rate): pass through.
            return samples.to_vec();
        }
        self.in_buf.extend_from_slice(samples);

        let mut out = Vec::new();
        while self.in_buf.len() >= BLOCK {
            // Reuse `block` across iterations to avoid a per-block heap alloc.
            let mut block = std::mem::take(&mut self.block);
            block.clear();
            block.extend(self.in_buf.drain(..BLOCK));
            let r = self.inner.as_mut().unwrap();
            match r.process(&[&block], None) {
                Ok(res) => out.extend_from_slice(&res[0]),
                // Surface the failure rather than silently dropping audio: a lost
                // block becomes an audible dropout downstream, so it must be visible.
                Err(e) => eprintln!("resample: process failed, dropping {BLOCK}-sample block: {e}"),
            }
            self.block = block;
        }
        out
    }
}

impl Default for Resampler16k {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_passthrough_16k() {
        let mut r = Resampler16k::new();
        let input = vec![0.25f32; 4096];
        let out = r.process(&input, 16000);
        assert_eq!(out.len(), input.len());
    }

    #[test]
    fn test_downsample_12k_produces_output() {
        let mut r = Resampler16k::new();
        // Feed several blocks of 12 kHz audio; expect ~4/3 as many 16 kHz samples.
        let input = vec![0.1f32; BLOCK * 4];
        let out = r.process(&input, 12000);
        assert!(!out.is_empty(), "expected resampled output");
        // 12k -> 16k is upsampling: more samples out than the blocks consumed.
        assert!(out.len() >= BLOCK * 3);
    }

    #[test]
    fn test_buffers_partial_block() {
        let mut r = Resampler16k::new();
        // Less than one block: nothing emitted yet, but no panic.
        let out = r.process(&vec![0.1f32; 100], 12000);
        assert_eq!(out.len(), 0);
    }
}
