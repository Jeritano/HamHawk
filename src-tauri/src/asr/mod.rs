pub mod whisper;

use crate::audio::AsrJob;
use std::sync::Arc;
use tokio::sync::mpsc;
use whisper_rs::{WhisperContext, WhisperContextParameters};

pub struct AsrResult {
    // Routes the result back to its receiver in the shared cross-receiver pool.
    pub receiver_id: String,
    pub ts_start: i64,
    pub ts_end: i64,
    pub text_en: String,
    pub src_lang: Option<String>,
    pub confidence: Option<f32>,
}

/// Run a pool of `worker_count` ASR workers sharing one loaded Whisper model.
/// Jobs are dispatched round-robin; if a worker's queue is full the job is dropped
/// (newest-drop) and counted, so the network/audio side never blocks.
pub async fn run_worker_pool(
    mut job_rx: mpsc::Receiver<AsrJob>,
    result_tx: mpsc::Sender<AsrResult>,
    worker_count: u32,
    model_path: String,
) {
    let ctx = match WhisperContext::new_with_params(&model_path, WhisperContextParameters::default())
    {
        Ok(c) => Arc::new(c),
        Err(e) => {
            // Log only the file name, not the full path (avoid leaking fs structure).
            let name = std::path::Path::new(&model_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("model");
            log::error!("failed to load whisper model '{name}': {e}; transcription disabled");
            // Drain jobs so the upstream pipeline doesn't stall.
            drop(result_tx);
            while job_rx.recv().await.is_some() {}
            return;
        }
    };

    let n = worker_count.max(1) as usize;
    let mut senders = Vec::with_capacity(n);
    let mut handles = Vec::with_capacity(n);

    for _ in 0..n {
        let (tx, mut rx) = mpsc::channel::<AsrJob>(2);
        let result_tx = result_tx.clone();
        let ctx = ctx.clone();
        let handle = tokio::spawn(async move {
            while let Some(job) = rx.recv().await {
                let ctx = ctx.clone();
                let pcm = job.pcm;
                // Whisper inference is CPU-bound and synchronous -> blocking pool.
                let res = tokio::task::spawn_blocking(move || whisper::transcribe(ctx.as_ref(), &pcm))
                    .await;
                if let Ok(Ok((text, lang))) = res {
                    if !text.is_empty() {
                        let _ = result_tx
                            .send(AsrResult {
                                receiver_id: job.receiver_id,
                                ts_start: job.ts_start,
                                ts_end: job.ts_end,
                                text_en: text,
                                src_lang: lang,
                                confidence: None,
                            })
                            .await;
                    }
                }
            }
        });
        senders.push(tx);
        handles.push(handle);
    }
    drop(result_tx);

    let mut idx = 0usize;
    let mut dropped: u64 = 0;
    while let Some(job) = job_rx.recv().await {
        let target = &senders[idx % senders.len()];
        idx += 1;
        if target.try_send(job).is_err() {
            dropped += 1;
            if dropped == 1 || dropped.is_multiple_of(10) {
                log::warn!("ASR overloaded; dropped {dropped} segment(s)");
            }
        }
    }

    drop(senders);
    for h in handles {
        let _ = h.await;
    }
}
