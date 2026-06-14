// WebAudio playback of the monitored receiver's PCM stream. Chunks arrive base64
// (LE i16) via the 'audio' Tauri event; we schedule them gaplessly.

function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

class AudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nextTime = 0;
  private playing = false;
  private volume = 0.8;

  isPlaying() {
    return this.playing;
  }

  start() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    this.ctx.resume();
    this.playing = true;
    this.nextTime = this.ctx.currentTime + 0.12;
  }

  stop() {
    this.playing = false;
    this.ctx?.suspend();
  }

  /** Drop the look-ahead schedule so a newly-selected channel starts promptly. */
  reset() {
    if (this.ctx) this.nextTime = this.ctx.currentTime + 0.12;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  getVolume() {
    return this.volume;
  }

  push(b64: string, sampleRate: number) {
    if (!this.playing || !this.ctx || !this.gain) return;
    const i16 = base64ToInt16(b64);
    if (i16.length === 0) return;
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const buf = this.ctx.createBuffer(1, f32.length, sampleRate);
    buf.getChannelData(0).set(f32);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    // Drift guard: if we've buffered too far ahead (catch-up bursts after a
    // reconnect / source switch), drop the backlog so latency can't grow unbounded.
    if (this.nextTime - this.ctx.currentTime > 0.5) {
      this.nextTime = this.ctx.currentTime + 0.12;
    }
    const t = Math.max(this.nextTime, this.ctx.currentTime + 0.02);
    src.start(t);
    this.nextTime = t + buf.duration;
  }
}

export const audioPlayer = new AudioPlayer();
