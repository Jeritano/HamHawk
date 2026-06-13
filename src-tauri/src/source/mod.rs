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
