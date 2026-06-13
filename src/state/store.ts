import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { spectrumBus, telemetryBus, lastDbm } from "../lib/bus";
import { audioPlayer } from "../lib/audioPlayer";

export type Kind = "kiwisdr" | "openwebrx";
export type Lane = "voice" | "digital";

export interface ReceiverConfig {
  id: string;
  kind: Kind;
  url: string;
  label?: string;
  freq_hz: number;
  mode: string;
  lane: Lane;
  enabled: boolean;
}
export interface TranscriptRow {
  id: number;
  receiver_id: string;
  ts_start: number;
  ts_end: number;
  lane: Lane;
  mode: string;
  src_lang?: string;
  text_en: string;
  text_native?: string;
  confidence?: number;
  snr_db?: number;
}
export interface TelemetryFrame {
  receiver_id: string;
  status: string;
  s_meter_dbm?: number;
  snr_db?: number;
}
export interface Bookmark {
  id: string;
  label: string;
  kind: Kind;
  url: string;
  freq_hz: number;
  mode: string;
  lane: Lane;
}
export interface AlertRule {
  id: string;
  name: string;
  pattern: string;
  enabled: boolean;
}
export interface AlertHit {
  rule_id: string;
  rule_name: string;
  receiver_id: string;
  ts_ms: number;
  text: string;
}
export interface Toast {
  key: number;
  ruleName: string;
  text: string;
}

export type View = "workspace" | "matrix";
export type CtxTab = "map" | "activity" | "bookmarks" | "alerts";

interface AppState {
  receivers: ReceiverConfig[];
  transcripts: TranscriptRow[];
  sessionStatus: Record<string, string>;
  bookmarks: Bookmark[];
  alertRules: AlertRule[];
  alertHits: AlertHit[];
  toasts: Toast[];
  recordingIds: string[];
  monitoredId: string | null;
  activeId: string | null;
  view: View;
  ctxTab: CtxTab;
  paletteOpen: boolean;
  settingsOpen: boolean;
  addOpen: boolean;
  search: string;
  error: string | null;
  scanning: boolean;
  squelch: number; // dBm threshold for the scanner

  loadAll: () => Promise<void>;
  loadReceivers: () => Promise<void>;
  addReceiver: (cfg: Omit<ReceiverConfig, "id" | "enabled">, start?: boolean) => Promise<void>;
  removeReceiver: (id: string) => Promise<void>;
  startReceiver: (id: string) => Promise<void>;
  stopReceiver: (id: string) => Promise<void>;
  tune: (id: string, freqHz: number) => void;
  setSquelch: (dbm: number) => void;
  startScan: (id: string) => Promise<void>;
  stopScan: () => void;

  setActive: (id: string | null) => void;
  setView: (v: View) => void;
  setCtxTab: (t: CtxTab) => void;
  setPaletteOpen: (b: boolean) => void;
  setSettingsOpen: (b: boolean) => void;
  setAddOpen: (b: boolean) => void;
  setSearch: (s: string) => void;
  runSearch: (text: string) => Promise<void>;

  setMonitor: (id: string | null) => Promise<void>;
  toggleRecording: (id: string) => Promise<void>;

  loadBookmarks: () => Promise<void>;
  addBookmark: (bm: Bookmark) => Promise<void>;
  removeBookmark: (id: string) => Promise<void>;
  applyBookmark: (bm: Bookmark) => Promise<void>;

  loadAlerts: () => Promise<void>;
  addAlertRule: (r: Omit<AlertRule, "id">) => Promise<void>;
  removeAlertRule: (id: string) => Promise<void>;
  dismissToast: (key: number) => void;

  initListeners: () => Promise<UnlistenFn>;
}

let toastSeq = 1;
let tuneTimer: ReturnType<typeof setTimeout> | undefined;
let scanActive = false; // module-level scan loop flag

export const useStore = create<AppState>((set, get) => ({
  receivers: [],
  transcripts: [],
  sessionStatus: {},
  bookmarks: [],
  alertRules: [],
  alertHits: [],
  toasts: [],
  recordingIds: [],
  monitoredId: null,
  activeId: null,
  view: "workspace",
  ctxTab: "map",
  paletteOpen: false,
  settingsOpen: false,
  addOpen: false,
  search: "",
  error: null,
  scanning: false,
  squelch: -90,

  loadAll: async () => {
    await Promise.all([get().loadReceivers(), get().loadBookmarks(), get().loadAlerts()]);
    try {
      const rec = await invoke<string[]>("recording_ids");
      set({ recordingIds: rec });
    } catch {
      /* ignore */
    }
  },

  loadReceivers: async () => {
    try {
      const receivers = await invoke<ReceiverConfig[]>("list_receivers");
      set({ receivers });
      if (!get().activeId && receivers.length) set({ activeId: receivers[0].id });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  addReceiver: async (cfg, start = true) => {
    const id = `recv_${Date.now()}`;
    const full: ReceiverConfig = { ...cfg, id, enabled: true };
    try {
      await invoke("add_receiver", { cfg: full });
      set({ receivers: [...get().receivers, full], activeId: id, addOpen: false });
      if (start) await get().startReceiver(id);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  removeReceiver: async (id) => {
    try {
      await invoke("remove_receiver", { id });
      const receivers = get().receivers.filter((r) => r.id !== id);
      set({
        receivers,
        activeId: get().activeId === id ? receivers[0]?.id ?? null : get().activeId,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  startReceiver: async (id) => {
    try {
      await invoke("start_receiver", { id });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  stopReceiver: async (id) => {
    try {
      await invoke("stop_receiver", { id });
      if (get().monitoredId === id) await get().setMonitor(null);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  // Optimistic local freq change (so the readout moves live), debounced backend
  // retune (one reconnect after the knob settles, not per-tick).
  tune: (id, freqHz) => {
    const f = Math.max(0, Math.round(freqHz));
    set({ receivers: get().receivers.map((r) => (r.id === id ? { ...r, freq_hz: f } : r)) });
    clearTimeout(tuneTimer);
    tuneTimer = setTimeout(() => {
      invoke("tune", { id, freqHz: f }).catch((e) => set({ error: String(e) }));
    }, 350);
  },

  setSquelch: (dbm) => set({ squelch: dbm }),

  // Band scan: sweep ±100 kHz around the active VFO in 1 kHz steps via live
  // retune, stopping when the S-meter clears the squelch threshold.
  startScan: async (id) => {
    const rx = get().receivers.find((r) => r.id === id);
    if (!rx) return;
    const st = get().sessionStatus[id] ?? "stopped";
    if (st === "stopped") await get().startReceiver(id);
    scanActive = true;
    set({ scanning: true });

    const base = rx.freq_hz;
    const lo = Math.max(0, base - 100_000);
    const hi = base + 100_000;
    const stepHz = 1000;
    let f = base;
    const dwell = 600;

    const tick = () => {
      if (!scanActive) return;
      f += stepHz;
      if (f > hi) f = lo;
      // optimistic readout + immediate (non-debounced) live retune
      set({ receivers: get().receivers.map((r) => (r.id === id ? { ...r, freq_hz: f } : r)) });
      invoke("tune", { id, freqHz: f }).catch((e) => set({ error: String(e) }));
      setTimeout(() => {
        if (!scanActive) return;
        const d = lastDbm.get(id);
        if (d != null && d >= get().squelch) {
          scanActive = false;
          set({ scanning: false }); // stop on signal
          return;
        }
        tick();
      }, dwell);
    };
    setTimeout(tick, st === "stopped" ? 2600 : 250);
  },

  stopScan: () => {
    scanActive = false;
    set({ scanning: false });
  },

  setActive: (id) => set({ activeId: id, view: "workspace" }),
  setView: (v) => set({ view: v }),
  setCtxTab: (t) => set({ ctxTab: t }),
  setPaletteOpen: (b) => set({ paletteOpen: b }),
  setSettingsOpen: (b) => set({ settingsOpen: b }),
  setAddOpen: (b) => set({ addOpen: b }),
  setSearch: (s) => set({ search: s }),

  runSearch: async (text) => {
    try {
      const transcripts = await invoke<TranscriptRow[]>("query_transcripts", {
        textQuery: text || undefined,
      });
      set({ transcripts });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  setMonitor: async (id) => {
    try {
      await invoke("set_monitor", { id });
      if (id) {
        audioPlayer.start();
        audioPlayer.reset(); // start the new channel promptly, not behind the old queue
      } else {
        audioPlayer.stop();
      }
      set({ monitoredId: id });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  toggleRecording: async (id) => {
    const recording = get().recordingIds.includes(id);
    try {
      await invoke(recording ? "stop_recording" : "start_recording", { id });
      const ids = await invoke<string[]>("recording_ids");
      set({ recordingIds: ids });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadBookmarks: async () => {
    try {
      set({ bookmarks: await invoke<Bookmark[]>("list_bookmarks") });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  addBookmark: async (bm) => {
    try {
      await invoke("add_bookmark", { bookmark: bm });
      await get().loadBookmarks();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  removeBookmark: async (id) => {
    try {
      await invoke("remove_bookmark", { id });
      set({ bookmarks: get().bookmarks.filter((b) => b.id !== id) });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  applyBookmark: async (bm) => {
    await get().addReceiver(
      { kind: bm.kind, url: bm.url, label: bm.label, freq_hz: bm.freq_hz, mode: bm.mode, lane: bm.lane },
      true
    );
  },

  loadAlerts: async () => {
    try {
      const [alertRules, alertHits] = await Promise.all([
        invoke<AlertRule[]>("list_alert_rules"),
        invoke<AlertHit[]>("list_alert_hits", { limit: 100 }),
      ]);
      set({ alertRules, alertHits });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  addAlertRule: async (r) => {
    const rule: AlertRule = { ...r, id: `rule_${Date.now()}` };
    try {
      await invoke("add_alert_rule", { rule });
      await get().loadAlerts();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  removeAlertRule: async (id) => {
    try {
      await invoke("remove_alert_rule", { id });
      set({ alertRules: get().alertRules.filter((r) => r.id !== id) });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  dismissToast: (key) => set({ toasts: get().toasts.filter((t) => t.key !== key) }),

  initListeners: async () => {
    const u1 = await listen<TranscriptRow>("transcript", (e) => {
      set({ transcripts: [e.payload, ...get().transcripts].slice(0, 500) });
    });
    const u2 = await listen<TelemetryFrame>("telemetry", (e) => {
      // Route to a per-receiver bus instead of the store — avoids re-rendering the
      // whole UI on every telemetry tick. Also snapshot dBm for the scanner.
      if (e.payload.s_meter_dbm != null) lastDbm.set(e.payload.receiver_id, e.payload.s_meter_dbm);
      telemetryBus.emit(e.payload.receiver_id, {
        s_meter_dbm: e.payload.s_meter_dbm,
        snr_db: e.payload.snr_db,
        status: e.payload.status,
      });
    });
    const u3 = await listen<{ receiver_id: string; status: string }>("session", (e) => {
      set({ sessionStatus: { ...get().sessionStatus, [e.payload.receiver_id]: e.payload.status } });
    });
    const u4 = await listen<{ receiver_id: string; bins: number[] }>("spectrum", (e) => {
      spectrumBus.emit(e.payload.receiver_id, e.payload.bins);
    });
    const u5 = await listen<{ receiver_id: string; sample_rate: number; pcm_b64: string }>(
      "audio",
      (e) => {
        if (e.payload.receiver_id === get().monitoredId) {
          audioPlayer.push(e.payload.pcm_b64, e.payload.sample_rate);
        }
      }
    );
    const u6 = await listen<AlertHit>("alert", (e) => {
      const key = toastSeq++;
      set({
        alertHits: [e.payload, ...get().alertHits].slice(0, 200),
        toasts: [...get().toasts, { key, ruleName: e.payload.rule_name, text: e.payload.text }],
      });
    });
    return () => {
      u1();
      u2();
      u3();
      u4();
      u5();
      u6();
    };
  },
}));
