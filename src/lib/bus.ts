// Lightweight pub/sub for high-frequency streams (waterfall rows, audio chunks)
// so they bypass the React/zustand store and never trigger re-render storms.

type Cb<T> = (v: T) => void;

class Bus<T> {
  private subs = new Map<string, Set<Cb<T>>>();

  on(topic: string, cb: Cb<T>): () => void {
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  emit(topic: string, v: T) {
    this.subs.get(topic)?.forEach((cb) => cb(v));
  }
}

/** Waterfall rows keyed by receiver id. */
export const spectrumBus = new Bus<number[]>();

/** S-meter / telemetry keyed by receiver id (high-frequency; bypasses the store). */
export const telemetryBus = new Bus<{ s_meter_dbm?: number; snr_db?: number; status: string }>();
