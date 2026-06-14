// WebAudio playback of the monitored receiver(s). Chunks arrive base64 (LE i16)
// via the 'audio' Tauri event, tagged with receiver_id. Supports true dual
// receive (IC-7760 style): a MAIN lane panned left and a SUB lane panned right,
// each scheduled gaplessly on its own timeline. With no SUB assigned, MAIN plays
// centered (mono to both speakers).

function base64ToInt16(b64: string): Int16Array {
  // Audio arrives from untrusted public SDR nodes; a malformed chunk must never
  // crash the audio path. Decode defensively and drop on any failure.
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // Int16Array needs an even byte count; truncate a stray trailing byte.
    const usable = bytes.length - (bytes.length % 2);
    return new Int16Array(bytes.buffer, 0, usable / 2);
  } catch {
    return new Int16Array(0);
  }
}

interface Lane {
  nextTime: number;
}

const PAN = 0.6; // L/R spread when both MAIN and SUB are active

class AudioPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lanes = new Map<string, Lane>();
  private mainId: string | null = null;
  private subId: string | null = null;
  private playing = false;
  private volume = 0.8;

  isPlaying() {
    return this.playing;
  }

  /** Create the context if needed (does not start playback). */
  private ensureCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Resume the AudioContext from within a user gesture. WKWebView keeps the
   *  context suspended until a gesture, and `start()` runs after awaits (gesture
   *  context lost), so a gesture-time unlock is what actually enables audio. */
  unlock() {
    this.ensureCtx().resume();
  }

  start() {
    this.ensureCtx().resume();
    this.playing = true;
  }

  stop() {
    this.playing = false;
    this.ctx?.suspend();
  }

  /** Drop the look-ahead schedule on all lanes so a switch starts promptly. */
  reset() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.12;
    for (const lane of this.lanes.values()) lane.nextTime = t;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  getVolume() {
    return this.volume;
  }

  /** Assign which receiver feeds MAIN (left) and which feeds SUB (right). */
  setLanes(mainId: string | null, subId: string | null) {
    this.mainId = mainId;
    this.subId = subId;
    for (const id of [...this.lanes.keys()]) {
      if (id !== mainId && id !== subId) this.lanes.delete(id);
    }
  }

  /** L/R gains for a receiver. Pan is baked into a stereo buffer (no
   *  StereoPannerNode — that node renders silent in WKWebView). Equal-power pan. */
  private gainsFor(id: string): [number, number] {
    let pan = 0; // center (mono to both) when no SUB
    if (this.subId) {
      if (id === this.mainId) pan = -PAN;
      else if (id === this.subId) pan = PAN;
    }
    const a = ((pan + 1) * Math.PI) / 4; // 0..PI/2
    return [Math.cos(a), Math.sin(a)];
  }

  private lane(id: string): Lane | null {
    if (!this.ctx || !this.master) return null;
    let lane = this.lanes.get(id);
    if (!lane) {
      lane = { nextTime: this.ctx.currentTime + 0.12 };
      this.lanes.set(id, lane);
    }
    return lane;
  }

  push(receiverId: string, b64: string, sampleRate: number) {
    if (!this.playing || !this.ctx) return;
    // Only route the two assigned channels; ignore other running receivers.
    // Prune any stale lane for an unrouted receiver so the map can't accumulate
    // orphans when a source stops without setLanes() running.
    if (receiverId !== this.mainId && receiverId !== this.subId) {
      this.lanes.delete(receiverId);
      return;
    }
    const lane = this.lane(receiverId);
    if (!lane) return;
    // Guard against a malformed/garbage sample rate (0/NaN -> Infinity ratio).
    if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000) return;
    const i16 = base64ToInt16(b64);
    if (i16.length === 0) return;

    // Decode to mono float, then resample to the context's native rate. WKWebView
    // mishandles AudioBuffers declared at a non-context sample rate, so we never
    // hand it a 12 kHz buffer — we upsample to ctx.sampleRate ourselves.
    const ctxRate = this.ctx.sampleRate;
    const ratio = ctxRate / sampleRate;
    const outLen = Math.max(1, Math.round(i16.length * ratio));
    const [gl, gr] = this.gainsFor(receiverId);
    const buf = this.ctx.createBuffer(2, outLen, ctxRate);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const posStep = 1 / ratio; // precompute; avoid a divide per output sample
    let srcPos = 0;
    for (let i = 0; i < outLen; i++, srcPos += posStep) {
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, i16.length - 1);
      const frac = srcPos - i0;
      const s = (i16[i0] + (i16[i1] - i16[i0]) * frac) / 32768; // linear interp
      L[i] = s * gl;
      R[i] = s * gr;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master!);

    // Drift guard: if buffered too far ahead (catch-up bursts after a reconnect /
    // source switch), drop the backlog so latency can't grow unbounded.
    if (lane.nextTime - this.ctx.currentTime > 0.5) {
      lane.nextTime = this.ctx.currentTime + 0.12;
    }
    const t = Math.max(lane.nextTime, this.ctx.currentTime + 0.02);
    src.start(t);
    lane.nextTime = t + buf.duration;
  }
}

export const audioPlayer = new AudioPlayer();

// Unlock the AudioContext on the first user gestures. Resuming an already-running
// context is a no-op, so leaving these attached is harmless. The listeners are
// kept removable (see disposeAudioPlayer) so HMR / unmount doesn't duplicate them.
let removeGestureListeners: (() => void) | null = null;
if (typeof window !== "undefined") {
  const unlock = () => audioPlayer.unlock();
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  removeGestureListeners = () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}

/** Detach the gesture-unlock listeners. Call from an unmount/HMR cleanup. */
export function disposeAudioPlayer() {
  removeGestureListeners?.();
  removeGestureListeners = null;
}
