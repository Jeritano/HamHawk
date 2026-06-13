//! Thin wrapper over whisper-rs. One shared `WhisperContext`; a fresh state per
//! segment. `task=translate` yields English (decision D2); language auto-detect
//! reports the source language.
//!
//! Note: whisper-rs takes f32 PCM in [-1.0, 1.0] directly — no i16 conversion.

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext};

/// Transcribe+translate one segment. Returns (english_text, detected_language).
pub fn transcribe(ctx: &WhisperContext, pcm: &[f32]) -> Result<(String, Option<String>), String> {
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_translate(true); // -> English (D2)
    params.set_language(None); // auto-detect source language
    params.set_n_threads(4);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_no_context(true);
    params.set_single_segment(true);

    state.full(params, pcm).map_err(|e| e.to_string())?;

    let n = state.full_n_segments().map_err(|e| e.to_string())?;
    let mut text = String::new();
    for i in 0..n {
        if let Ok(seg) = state.full_get_segment_text(i) {
            text.push_str(seg.trim());
            text.push(' ');
        }
    }

    // Detected language id -> ISO code string (best effort).
    let src_lang = state
        .full_lang_id_from_state()
        .ok()
        .and_then(|id| whisper_rs::get_lang_str(id).map(|s| s.to_string()));

    Ok((text.trim().to_string(), src_lang))
}
