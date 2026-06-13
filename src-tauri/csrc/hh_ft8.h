#ifndef HH_FT8_H
#define HH_FT8_H

#ifdef __cplusplus
extern "C" {
#endif

/// Decode FT8 (is_ft4=0) or FT4 (is_ft4=1) from a buffer of mono float samples
/// spanning (roughly) one slot. Decoded message texts are written into `out_text`
/// as fixed-width records of `text_stride` bytes each (NUL-terminated), up to
/// `max_msgs`. Per-message SNR estimate and audio frequency are written to
/// `out_snr` / `out_freq` if non-NULL. Returns the number of messages decoded,
/// or a negative value on error.
int hh_ft8_decode(const float* samples, int num_samples, int sample_rate,
                  int is_ft4, char* out_text, int text_stride,
                  float* out_snr, float* out_freq, int max_msgs);

/// Encode `message` into a slot-length waveform (for testing). Writes up to
/// `max_samples` mono float samples at `sample_rate` with base frequency `f0`.
/// Returns the number of samples written, or a negative value on error.
int hh_ft8_encode(const char* message, int is_ft4, float* out_samples,
                  int max_samples, int sample_rate, float f0);

#ifdef __cplusplus
}
#endif

#endif
