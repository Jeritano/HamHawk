// WebAudio playback of the monitored receiver(s). Chunks arrive base64 (LE i16)
// via the 'audio' Tauri event, tagged with receiver_id. Supports true dual
// receive (IC-7760 style): a MAIN lane panned left and a SUB lane panned right,
// each scheduled gaplessly on its own timeline. With no SUB assigned, MAIN plays
// centered (mono to both speakers).

function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

interface Lane {
  panner: StereoPannerNode;
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

  start() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    this.ctx.resume();
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
    // Tear down lanes that are no longer routed.
    for (const [id, lane] of this.lanes) {
      if (id !== mainId && id !== subId) {
        lane.panner.disconnect();
        this.lanes.delete(id);
      }
    }
    // Re-pan surviving lanes (e.g. MAIN goes center<->left as SUB appears/clears).
    for (const [id, lane] of this.lanes) lane.panner.pan.value = this.panFor(id);
  }

  private panFor(id: string): number {
    if (!this.subId) return 0; // mono: center
    if (id === this.mainId) return -PAN;
    if (id === this.subId) return PAN;
    return 0;
  }

  private lane(id: string): Lane | null {
    if (!this.ctx || !this.master) return null;
    let lane = this.lanes.get(id);
    if (!lane) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = this.panFor(id);
      panner.connect(this.master);
      lane = { panner, nextTime: this.ctx.currentTime + 0.12 };
      this.lanes.set(id, lane);
    }
    return lane;
  }

  push(receiverId: string, b64: string, sampleRate: number) {
    if (!this.playing || !this.ctx) return;
    // Only route the two assigned channels; ignore other running receivers.
    if (receiverId !== this.mainId && receiverId !== this.subId) return;
    const lane = this.lane(receiverId);
    if (!lane) return;
    const i16 = base64ToInt16(b64);
    if (i16.length === 0) return;
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const buf = this.ctx.createBuffer(1, f32.length, sampleRate);
    buf.getChannelData(0).set(f32);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(lane.panner);
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
