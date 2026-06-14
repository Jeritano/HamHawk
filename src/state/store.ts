import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { spectrumBus, telemetryBus, lastDbm } from "../lib/bus";
import { audioPlayer } from "../lib/audioPlayer";

export type Kind = "kiwisdr" | "openwebrx" | "feed";
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
  subId: string | null; // SUB (right channel) receiver for dual receive, or null
  activeId: string | null;
  view: View;
  ctxTab: CtxTab;
  paletteOpen: boolean;
  settingsOpen: boolean;
  addOpen: boolean;
  addKind: Kind;
  editId: string | null;
  search: string;
  error: string | null;
  scanning: boolean;
  scanDir: number; // -1 down, +1 up, 0 idle
  squelch: number; // dBm threshold for the scanner

  loadAll: () => Promise<void>;
  loadReceivers: () => Promise<void>;
  addReceiver: (cfg: Omit<ReceiverConfig, "id" | "enabled">, start?: boolean) => Promise<void>;
  removeReceiver: (id: string) => Promise<void>;
  updateReceiver: (cfg: ReceiverConfig) => Promise<void>;
  setEditId: (id: string | null) => void;
  startReceiver: (id: string) => Promise<boolean>;
  stopReceiver: (id: string) => Promise<void>;
  stopAll: () => Promise<void>;
  tune: (id: string, freqHz: number) => void;
  setSquelch: (dbm: number) => void;
  startScan: (id: string, dir: number) => Promise<void>;
  stopScan: () => void;
  togglePlay: (id: string) => Promise<void>;
  selectBand: (freqHz: number, mode: string) => Promise<void>;

  setActive: (id: string | null) => void;
  setView: (v: View) => void;
  setCtxTab: (t: CtxTab) => void;
  setPaletteOpen: (b: boolean) => void;
  setSettingsOpen: (b: boolean) => void;
  setAddOpen: (b: boolean) => void;
  openAdd: (kind?: Kind) => void;
  setSearch: (s: string) => void;
  runSearch: (text: string) => Promise<void>;

  setMonitor: (id: string | null) => Promise<void>;
  setSub: (id: string | null) => Promise<void>;
  setWatched: (ids: string[]) => void;
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
let scanGen = 0; // bumped on every start/stop so stale loops self-cancel

// Squelch is a UI scanner control; persist it across restarts via localStorage
// (no backend round-trip needed).
const SQUELCH_KEY = "hh_squelch";
function loadSquelch(): number {
  try {
    const v = Number(localStorage.getItem(SQUELCH_KEY));
    if (Number.isFinite(v) && v >= -120 && v <= -40) return v;
  } catch {
    /* ignore */
  }
  return -90;
}

// Serialize MAIN/SUB channel mutations so setMonitor and setSub can't interleave
// their check-then-invoke windows and leave backend/frontend (or the audio lanes)
// diverged. Each call chains onto the previous one.
let monitorChain: Promise<void> = Promise.resolve();
const withMonitorLock = (fn: () => Promise<void>): Promise<void> => {
  const next = monitorChain.then(fn, fn);
  // Keep the chain alive even if fn rejects (it shouldn't — both callers catch).
  monitorChain = next.catch(() => {});
  return next;
};

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
  subId: null,
  activeId: null,
  view: "workspace",
  ctxTab: "map",
  paletteOpen: false,
  settingsOpen: false,
  addOpen: false,
  addKind: "kiwisdr",
  editId: null,
  search: "",
  error: null,
  scanning: false,
  scanDir: 0,
  squelch: loadSquelch(),

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
        editId: get().editId === id ? null : get().editId,
        activeId: get().activeId === id ? receivers[0]?.id ?? null : get().activeId,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  setEditId: (id) => set({ editId: id }),

  // Save edits to a memory (label/freq/mode/lane). Upserts to the DB; if the
  // session is running, restart it so the new settings take effect.
  updateReceiver: async (cfg) => {
    try {
      await invoke("update_receiver", { cfg });
      set({
        receivers: get().receivers.map((r) => (r.id === cfg.id ? cfg : r)),
        editId: null,
      });
      const st = get().sessionStatus[cfg.id] ?? "stopped";
      if (st !== "stopped") await get().startReceiver(cfg.id);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  startReceiver: async (id) => {
    try {
      await invoke("start_receiver", { id });
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  stopReceiver: async (id) => {
    try {
      await invoke("stop_receiver", { id });
      if (get().monitoredId === id) await get().setMonitor(null);
      if (get().subId === id) await get().setSub(null);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  // Optimistic local freq change (so the readout moves live), debounced backend
  // retune (one reconnect after the knob settles, not per-tick).
  tune: (id, freqHz) => {
    const f = Math.max(0, Math.round(freqHz));
    const prev = get().receivers.find((r) => r.id === id)?.freq_hz;
    set({ receivers: get().receivers.map((r) => (r.id === id ? { ...r, freq_hz: f } : r)) });
    clearTimeout(tuneTimer);
    tuneTimer = setTimeout(() => {
      invoke("tune", { id, freqHz: f }).catch((e) => {
        // Backend rejected the retune — revert the readout so it never shows a
        // frequency the SDR isn't actually on.
        if (prev != null) {
          set({ receivers: get().receivers.map((r) => (r.id === id ? { ...r, freq_hz: prev } : r)) });
        }
        set({ error: String(e) });
      });
    }, 350);
  },

  setSquelch: (dbm) => {
    set({ squelch: dbm });
    try {
      localStorage.setItem(SQUELCH_KEY, String(dbm));
    } catch {
      /* ignore */
    }
  },

  // Band scan: sweep ±100 kHz around the active VFO in 1 kHz steps via live
  // retune, stopping when the S-meter clears the squelch threshold.
  // Directional squelch scan: dir +1 sweeps up, -1 sweeps down, ±100 kHz around
  // the start, wrapping, stopping when the S-meter clears squelch.
  startScan: async (id, dir) => {
    const rx = get().receivers.find((r) => r.id === id);
    if (!rx) return;
    if (rx.kind === "feed") {
      set({ error: "Scan needs a tunable SDR receiver" });
      return;
    }
    clearTimeout(tuneTimer); // a pending debounced tune would fight the scan
    // New scan generation — any previously-running scan loop self-cancels.
    const myGen = ++scanGen;
    scanActive = true;
    const st = get().sessionStatus[id] ?? "stopped";
    if (st === "stopped") {
      set({ activeId: id });
      const ok = await get().startReceiver(id);
      if (!ok) {
        scanActive = false;
        set({ scanning: false, scanDir: 0 });
        return;
      }
      await get().setMonitor(id);
      if (myGen !== scanGen) return; // superseded while awaiting
    }
    set({ scanning: true, scanDir: dir });

    // The receiver may have been removed during the startup awaits — abort rather
    // than scan/tune a non-existent receiver.
    const cur = get().receivers.find((r) => r.id === id);
    if (!cur) {
      scanActive = false;
      set({ scanning: false, scanDir: 0 });
      return;
    }
    // Re-read current freq (so reversing direction continues from here).
    const base = cur.freq_hz;
    const lo = Math.max(0, base - 100_000);
    const hi = base + 100_000;
    const stepHz = 1000 * (dir < 0 ? -1 : 1);
    let f = base;
    const dwell = 600;

    const tick = () => {
      if (!scanActive || myGen !== scanGen) return; // stale loop -> stop
      const prev = get().receivers.find((r) => r.id === id)?.freq_hz ?? f;
      f += stepHz;
      if (f > hi) f = lo;
      if (f < lo) f = hi;
      const stepped = f;
      set({ receivers: get().receivers.map((r) => (r.id === id ? { ...r, freq_hz: stepped } : r)) });
      lastDbm.delete(id); // require a FRESH reading at the new freq, not a stale one
      invoke("tune", { id, freqHz: stepped }).catch((e) => {
        // Retune failed — revert the readout so it never shows an unconfirmed freq.
        set({ receivers: get().receivers.map((r) => (r.id === id ? { ...r, freq_hz: prev } : r)) });
        set({ error: String(e) });
      });
      const decide = (): boolean => {
        // Returns true if a signal was found (scan should stop).
        const d = lastDbm.get(id);
        if (d != null && d >= get().squelch) {
          scanActive = false;
          set({ scanning: false, scanDir: 0 }); // stop on signal
          return true;
        }
        return false;
      };
      setTimeout(() => {
        if (!scanActive || myGen !== scanGen) return;
        if (decide()) return;
        // No reading cleared squelch yet. If telemetry simply hadn't arrived for
        // this freq, give it one short grace re-check before advancing so a late
        // S-meter sample can't be skipped past a real signal.
        if (lastDbm.get(id) == null) {
          setTimeout(() => {
            if (!scanActive || myGen !== scanGen) return;
            if (decide()) return;
            tick();
          }, 300);
          return;
        }
        tick();
      }, dwell);
    };
    setTimeout(() => {
      if (myGen === scanGen) tick();
    }, st === "stopped" ? 2600 : 250);
  },

  stopScan: () => {
    scanGen++; // invalidate any running loop
    scanActive = false;
    clearTimeout(tuneTimer);
    set({ scanning: false, scanDir: 0 });
  },

  // Stop every running receiver (POWER off).
  stopAll: async () => {
    for (const id of Object.keys(get().sessionStatus)) {
      if ((get().sessionStatus[id] ?? "stopped") !== "stopped") await get().stopReceiver(id);
    }
    await get().setSub(null);
    await get().setMonitor(null);
  },

  // Item IS the switch: click a memory to start + listen on MAIN; click again to
  // stop. Other receivers keep running (decode/transcribe/record) — this only
  // changes what you HEAR. Assign a SUB (right channel) via setSub for dual receive.
  togglePlay: async (id) => {
    const running = (get().sessionStatus[id] ?? "stopped") !== "stopped";
    if (running && get().monitoredId === id) {
      await get().stopReceiver(id); // hearing it already -> toggle off
    } else {
      const ok = running || (await get().startReceiver(id));
      if (ok) {
        set({ activeId: id });
        await get().setMonitor(id); // becomes MAIN audio; others keep running
      }
    }
  },

  // HF band toggle: apply band to the active VFO + start + listen; clicking the
  // band you're already on (and playing) stops it.
  selectBand: async (freqHz, mode) => {
    const { receivers, activeId, sessionStatus, monitoredId } = get();
    const active = receivers.find((r) => r.id === activeId) || receivers[0];
    if (!active) {
      set({ error: "Add a receiver first, then pick a band" });
      return;
    }
    if (active.kind === "feed") {
      set({ error: "Bands don't apply to a scanner feed — select an SDR VFO" });
      return;
    }
    const running = (sessionStatus[active.id] ?? "stopped") !== "stopped";
    const onBand = active.freq_hz === freqHz && active.mode === mode;
    if (running && onBand && monitoredId === active.id) {
      await get().stopReceiver(active.id); // deselect
      return;
    }
    if (active.mode !== mode) {
      await get().updateReceiver({ ...active, freq_hz: freqHz, mode }); // upsert + restart-if-running
    } else {
      // immediate (non-debounced) optimistic tune so it doesn't race startReceiver
      const prev = active.freq_hz;
      set({ receivers: get().receivers.map((r) => (r.id === active.id ? { ...r, freq_hz: freqHz } : r)) });
      invoke("tune", { id: active.id, freqHz }).catch((e) => {
        // Revert on rejection so the readout never shows an unconfirmed freq.
        set({ receivers: get().receivers.map((r) => (r.id === active.id ? { ...r, freq_hz: prev } : r)) });
        set({ error: String(e) });
      });
    }
    let ok = (get().sessionStatus[active.id] ?? "stopped") !== "stopped";
    if (!ok) ok = await get().startReceiver(active.id);
    if (ok) {
      await get().setMonitor(active.id);
      set({ activeId: active.id });
    }
  },

  setActive: (id) => set({ activeId: id, view: "workspace" }),
  setView: (v) => set({ view: v }),
  setCtxTab: (t) => set({ ctxTab: t }),
  setPaletteOpen: (b) => set({ paletteOpen: b }),
  setSettingsOpen: (b) => set({ settingsOpen: b }),
  setAddOpen: (b) => set({ addOpen: b }),
  openAdd: (kind = "kiwisdr") => set({ addOpen: true, addKind: kind }),
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

  setWatched: (ids) => {
    invoke("set_watched", { ids }).catch(() => {});
  },

  // MAIN (left) channel. A receiver can't be both MAIN and SUB — assigning it to
  // MAIN clears it from SUB.
  setMonitor: (id) =>
    withMonitorLock(async () => {
      try {
        await invoke("set_monitor", { id });
        set({ monitoredId: id });
        if (id && get().subId === id) {
          await invoke("set_monitor_sub", { id: null });
          set({ subId: null });
        }
      } catch (e) {
        set({ error: String(e) });
      } finally {
        // Always resync the player to whatever the store actually committed, even if
        // a later invoke threw — otherwise audioPlayer keeps routing to a stale MAIN.
        const main = get().monitoredId;
        const sub = get().subId;
        audioPlayer.setLanes(main, sub);
        if (main || sub) {
          audioPlayer.start();
          audioPlayer.reset(); // start the new channel promptly, not behind the old queue
        } else {
          audioPlayer.stop();
        }
      }
    }),

  // SUB (right) channel for true dual receive. Pass null to clear. Ignored if the
  // id is already MAIN (can't be both).
  setSub: (id) =>
    withMonitorLock(async () => {
      if (id && id === get().monitoredId) return; // can't be both MAIN and SUB
      try {
        await invoke("set_monitor_sub", { id });
        set({ subId: id });
      } catch (e) {
        set({ error: String(e) });
      } finally {
        // Always resync the player to the committed store state (see setMonitor).
        const main = get().monitoredId;
        const sub = get().subId;
        audioPlayer.setLanes(main, sub);
        if (main || sub) {
          audioPlayer.start();
          audioPlayer.reset();
        } else {
          audioPlayer.stop();
        }
      }
    }),

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

  // Tune to a bookmark. Reuse an existing matching receiver (same node + freq +
  // mode) instead of spawning a duplicate on every apply; only add it if it isn't
  // already in memory. Either way: start it and listen (MAIN).
  applyBookmark: async (bm) => {
    const existing = get().receivers.find(
      (r) => r.url === bm.url && r.freq_hz === bm.freq_hz && r.mode === bm.mode
    );
    if (existing) {
      if ((get().sessionStatus[existing.id] ?? "stopped") === "stopped") {
        const ok = await get().startReceiver(existing.id);
        if (!ok) return;
      }
      set({ activeId: existing.id });
      await get().setMonitor(existing.id);
      return;
    }
    await get().addReceiver(
      { kind: bm.kind, url: bm.url, label: bm.label, freq_hz: bm.freq_hz, mode: bm.mode, lane: bm.lane },
      true
    );
    // addReceiver sets activeId + starts but doesn't monitor — make it audible.
    const id = get().activeId;
    if (id) await get().setMonitor(id);
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
    const u3 = await listen<{ receiver_id: string; status: string; reason?: string }>(
      "session",
      (e) => {
        const { receiver_id: id, status, reason } = e.payload;
        // Surface WHY a session is struggling — once per reconnect streak, not on
        // every backoff tick — so it isn't a mystery "connecting/reconnecting" loop.
        if (status === "reconnecting" && get().sessionStatus[id] !== "reconnecting") {
          const rx = get().receivers.find((r) => r.id === id);
          const name = rx?.label || rx?.url || id;
          set({
            toasts: [
              ...get().toasts,
              { key: toastSeq++, ruleName: name, text: reason ? `Reconnecting — ${reason}` : "Reconnecting…" },
            ],
          });
        }
        set({ sessionStatus: { ...get().sessionStatus, [id]: status } });
      }
    );
    const u4 = await listen<{ receiver_id: string; bins: number[] }>("spectrum", (e) => {
      spectrumBus.emit(e.payload.receiver_id, e.payload.bins);
    });
    const u5 = await listen<{ receiver_id: string; sample_rate: number; pcm_b64: string }>(
      "audio",
      (e) => {
        // Player routes by receiver_id into MAIN (left) / SUB (right) lanes and
        // ignores any other id, so just forward every audio chunk.
        audioPlayer.push(e.payload.receiver_id, e.payload.pcm_b64, e.payload.sample_rate);
      }
    );
    const u6 = await listen<AlertHit>("alert", (e) => {
      const key = toastSeq++;
      set({
        alertHits: [e.payload, ...get().alertHits].slice(0, 200),
        toasts: [...get().toasts, { key, ruleName: e.payload.rule_name, text: e.payload.text }],
      });
    });
    // Authoritative recording state from the backend: keeps the REC indicator in
    // sync when a recording stops on its own (session drop) and surfaces a toast
    // if the file couldn't be opened (so REC never lies about writing).
    const u7 = await listen<{ receiver_id: string; recording: boolean; error?: string | null }>(
      "recording",
      (e) => {
        const { receiver_id: id, recording, error } = e.payload;
        const cur = get().recordingIds;
        const next = recording ? Array.from(new Set([...cur, id])) : cur.filter((x) => x !== id);
        set({ recordingIds: next });
        if (error) {
          const rx = get().receivers.find((r) => r.id === id);
          set({
            toasts: [
              ...get().toasts,
              { key: toastSeq++, ruleName: rx?.label || rx?.url || id, text: error },
            ],
          });
        }
      }
    );
    return () => {
      u1();
      u2();
      u3();
      u4();
      u5();
      u6();
      u7();
    };
  },
}));
