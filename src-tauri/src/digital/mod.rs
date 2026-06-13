pub mod ft8;
pub mod cw;
pub mod psk_rtty;

use crate::source::AudioFrame;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigitalMsg {
    pub text: String,
    pub ts_ms: i64,
    pub snr_db: Option<f32>,
    pub meta: Value,
}

pub trait Decoder: Send {
    /// Feed native-rate audio; emit zero or more decoded messages.
    fn push(&mut self, frame: &AudioFrame) -> Vec<DigitalMsg>;
}

impl Decoder for Box<dyn Decoder> {
    fn push(&mut self, frame: &AudioFrame) -> Vec<DigitalMsg> {
        (**self).push(frame)
    }
}
