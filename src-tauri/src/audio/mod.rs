pub mod adpcm;
pub mod resample;
pub mod segment;
pub mod vad;

use crate::source::AudioFrame;
use tokio::sync::mpsc;
use vad::FRAME_SAMPLES;

#[derive(Clone, Debug)]
pub struct AsrJob {
    pub receiver_id: String,
    pub pcm: Vec<f32>,
    pub ts_start: i64,
    pub ts_end: i64,
    #[allow(dead_code)]
    pub snr_est: Option<f32>,
}

/// Voice-lane pipeline for one receiver:
/// resample -> 16 kHz, split into 20 ms VAD frames, segment on silence, emit ASR jobs.
pub async fn audio_pipeline(
    receiver_id: String,
    mut audio_rx: mpsc::Receiver<AudioFrame>,
    asr_tx: mpsc::Sender<AsrJob>,
) {
    let mut resampler = resample::Resampler16k::new();
    let mut vad = vad::Vad::new();
    let mut segmenter = segment::Segmenter::new();
    // Carry leftover samples that don't fill a whole 320-sample frame.
    let mut frame_buf: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 2);

    while let Some(frame) = audio_rx.recv().await {
        let resampled = resampler.process(&frame.samples, frame.sample_rate);
        frame_buf.extend_from_slice(&resampled);

        while frame_buf.len() >= FRAME_SAMPLES {
            let chunk: Vec<f32> = frame_buf.drain(..FRAME_SAMPLES).collect();
            let speaking = vad.process_frame(&chunk);
            segmenter.push(&chunk, speaking, frame.ts_ms);

            if let Some(seg) = segmenter.try_emit() {
                let job = AsrJob {
                    receiver_id: receiver_id.clone(),
                    pcm: seg.samples,
                    ts_start: seg.ts_start,
                    ts_end: seg.ts_end,
                    snr_est: None,
                };
                if asr_tx.send(job).await.is_err() {
                    return; // ASR side gone; stop the pipeline.
                }
            }
        }
    }
}
