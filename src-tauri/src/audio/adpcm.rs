//! IMA-ADPCM decoder for KiwiSDR audio frames.
//!
//! KiwiSDR streams 4-bit IMA-ADPCM (one nibble per sample, **low nibble first**)
//! and the decoder state (step index + predictor) is **continuous across frames**
//! for the lifetime of the connection — so callers must hold a single `ImaAdpcm`
//! instance and feed every frame through it, not reset per frame.
//!
//! Algorithm ported from the standard IMA-ADPCM spec, matching jks-prv/kiwiclient.

const STEP_TABLE: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
    19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
    5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

const INDEX_TABLE: [i32; 16] = [
    -1, -1, -1, -1, 2, 4, 6, 8,
    -1, -1, -1, -1, 2, 4, 6, 8,
];

/// Stateful IMA-ADPCM decoder. One instance per connection.
pub struct ImaAdpcm {
    index: i32,
    predictor: i32,
}

impl ImaAdpcm {
    pub fn new() -> Self {
        Self { index: 0, predictor: 0 }
    }

    #[inline]
    fn step_nibble(&mut self, nibble: u8) -> f32 {
        let n = (nibble & 0x0F) as usize;
        let step = STEP_TABLE[self.index as usize];

        // Advance the step index, then clamp.
        self.index = (self.index + INDEX_TABLE[n]).clamp(0, 88);

        // Reconstruct the difference: diff = step/8 + (b2 ? step/2 : 0) + (b1 ? step/4 : 0) + (b0 ? step : 0)
        let mut diff = step >> 3;
        if n & 1 != 0 { diff += step >> 2; }
        if n & 2 != 0 { diff += step >> 1; }
        if n & 4 != 0 { diff += step; }

        if n & 8 != 0 { self.predictor -= diff; } else { self.predictor += diff; }
        self.predictor = self.predictor.clamp(-32768, 32767);

        self.predictor as f32 / 32768.0
    }

    /// Decode a frame of ADPCM bytes into f32 samples in [-1.0, 1.0].
    /// Low nibble of each byte decodes first.
    pub fn decode(&mut self, data: &[u8]) -> Vec<f32> {
        let mut out = Vec::with_capacity(data.len() * 2);
        for &byte in data {
            out.push(self.step_nibble(byte & 0x0F));
            out.push(self.step_nibble((byte >> 4) & 0x0F));
        }
        out
    }
}

impl Default for ImaAdpcm {
    fn default() -> Self {
        Self::new()
    }
}

/// Stateless convenience decode (fresh decoder). Use `ImaAdpcm` for streaming.
#[cfg(test)]
pub fn decode(data: &[u8]) -> Vec<f32> {
    ImaAdpcm::new().decode(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_length() {
        // 10 bytes -> 20 samples (2 nibbles each).
        let data = vec![0x80u8; 10];
        let result = decode(&data);
        assert_eq!(result.len(), 20);
    }

    #[test]
    fn test_decode_all_zero_is_silent() {
        // Nibble 0 => diff = step>>3 with the smallest step, predictor barely moves.
        let data = vec![0x00u8; 64];
        let result = decode(&data);
        for &s in &result {
            assert!(s.abs() < 0.05, "silent sample drifted too far: {}", s);
        }
    }

    #[test]
    fn test_index_clamped() {
        // Repeated max-magnitude codes must not panic (index stays in 0..=88).
        let data = vec![0x77u8; 256];
        let _ = decode(&data);
    }
}
