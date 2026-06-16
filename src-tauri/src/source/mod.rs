pub mod feed;
pub mod kiwisdr;
pub mod openwebrx;

#[derive(Clone, Debug)]
pub struct AudioFrame {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub ts_ms: i64,
}

#[derive(Clone, Debug)]
pub struct TelemetryFrame {
    pub s_meter_dbm: Option<f32>,
    pub snr_db: Option<f32>,
}

#[derive(Debug, thiserror::Error)]
#[error("source error: {0}")]
pub struct SourceError(pub String);

/// Map a HamHawk mode to a valid SDR DEMODULATION mode. Neither KiwiSDR nor
/// OpenWebRX has an "ft8"/"psk31"/etc. demod — digital lanes are decoded from USB
/// audio, so those must demodulate as USB and feed the in-app decoder. Shared by
/// all SDR adapters so the demod mapping can't drift between them.
pub fn sdr_demod(mode: &str) -> &'static str {
    match mode {
        "lsb" => "lsb",
        "am" | "amn" => "am",
        "cw" | "cwn" => "cw",
        _ => "usb", // usb voice + all digital modes
    }
}
