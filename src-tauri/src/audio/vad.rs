//! RMS-based Voice Activity Detection with hysteresis and noise-floor tracking.
//!
//! Operates on fixed 20 ms frames (320 samples @ 16 kHz). `process_frame` returns
//! the current speaking decision so the segmenter and VAD agree on frame units.

/// One 20 ms frame at 16 kHz.
pub const FRAME_SAMPLES: usize = 320;

pub struct Vad {
    noise_floor: f32,
    is_speaking: bool,
    hi_mult: f32,
    lo_mult: f32,
}

impl Vad {
    pub fn new() -> Self {
        Self {
            noise_floor: 1e-4,
            is_speaking: false,
            hi_mult: 3.0,
            lo_mult: 1.5,
        }
    }

    /// Process one frame; returns whether speech is currently active.
    pub fn process_frame(&mut self, frame: &[f32]) -> bool {
        let rms = rms(frame);

        // Track the noise floor only while NOT speaking, so loud speech doesn't
        // inflate the floor and choke off detection.
        if !self.is_speaking {
            self.noise_floor = self.noise_floor * 0.95 + rms * 0.05;
        }

        let hi = (self.noise_floor * self.hi_mult).max(1e-4);
        let lo = (self.noise_floor * self.lo_mult).max(5e-5);

        if !self.is_speaking && rms > hi {
            self.is_speaking = true;
        } else if self.is_speaking && rms < lo {
            self.is_speaking = false;
        }
        self.is_speaking
    }
}

impl Default for Vad {
    fn default() -> Self {
        Self::new()
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_silence_not_speaking() {
        let mut vad = Vad::new();
        let silent = vec![0.0f32; FRAME_SAMPLES];
        for _ in 0..10 {
            assert!(!vad.process_frame(&silent));
        }
    }

    #[test]
    fn test_loud_tone_triggers() {
        let mut vad = Vad::new();
        // Establish a quiet floor first.
        for _ in 0..20 {
            vad.process_frame(&vec![0.0005f32; FRAME_SAMPLES]);
        }
        let tone: Vec<f32> = (0..FRAME_SAMPLES)
            .map(|i| (i as f32 * 0.2).sin() * 0.5)
            .collect();
        assert!(vad.process_frame(&tone), "loud tone should be detected as speech");
    }
}
