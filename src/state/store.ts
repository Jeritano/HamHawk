import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface ReceiverConfig {
  id: string;
  kind: 'kiwisdr' | 'openwebrx';
  url: string;
  label?: string;
  freq_hz: number;
  mode: string;
  lane: 'voice' | 'digital';
  enabled: boolean;
}

export interface TranscriptRow {
  id: number;
  receiver_id: string;
  ts_start: number;
  ts_end: number;
  lane: 'voice' | 'digital';
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
  waterfall_row?: number[];
}

type SessionStatus = string;

interface AppState {
  receivers: ReceiverConfig[];
  transcripts: TranscriptRow[];
  telemetry: Record<string, TelemetryFrame>;
  sessionStatus: Record<string, SessionStatus>;
  activeTab: string;
  loading: boolean;
  error: string | null;

  loadReceivers: () => Promise<void>;
  addReceiver: (cfg: Omit<ReceiverConfig, 'id' | 'enabled'>) => Promise<void>;
  removeReceiver: (id: string) => Promise<void>;
  startReceiver: (id: string) => Promise<void>;
  stopReceiver: (id: string) => Promise<void>;
  queryTranscripts: (receiverId?: string, timeRange?: [number, number], textQuery?: string) => Promise<void>;
  setActiveTab: (tab: string) => void;
  initListeners: () => Promise<UnlistenFn>;
}

export const useStore = create<AppState>((set, get) => ({
  receivers: [],
  transcripts: [],
  telemetry: {},
  sessionStatus: {},
  activeTab: 'receivers',
  loading: false,
  error: null,

  loadReceivers: async () => {
    set({ loading: true, error: null });
    try {
      const receivers = await invoke<ReceiverConfig[]>('list_receivers');
      set({ receivers, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  addReceiver: async (cfg) => {
    const id = `recv_${Date.now()}`;
    const fullCfg: ReceiverConfig = { ...cfg, id, enabled: true };
    set({ loading: true, error: null });
    try {
      await invoke('add_receiver', { cfg: fullCfg });
      set({ receivers: [...get().receivers, fullCfg], loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  removeReceiver: async (id) => {
    set({ loading: true, error: null });
    try {
      await invoke('remove_receiver', { id });
      set({ receivers: get().receivers.filter((r) => r.id !== id), loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  startReceiver: async (id) => {
    set({ error: null });
    try {
      await invoke('start_receiver', { id });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  stopReceiver: async (id) => {
    set({ error: null });
    try {
      await invoke('stop_receiver', { id });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  // NOTE: Tauri maps JS camelCase args -> Rust snake_case params, so keys are camelCase.
  queryTranscripts: async (receiverId?: string, timeRange?: [number, number], textQuery?: string) => {
    set({ loading: true, error: null });
    try {
      const transcripts = await invoke<TranscriptRow[]>('query_transcripts', {
        receiverId,
        timeRangeStart: timeRange?.[0],
        timeRangeEnd: timeRange?.[1],
        textQuery,
      });
      set({ transcripts, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  initListeners: async () => {
    const unTranscript = await listen<TranscriptRow>('transcript', (e) => {
      const row = e.payload;
      set({ transcripts: [row, ...get().transcripts].slice(0, 1000) });
    });
    const unTelemetry = await listen<TelemetryFrame>('telemetry', (e) => {
      const f = e.payload;
      set({ telemetry: { ...get().telemetry, [f.receiver_id]: f } });
    });
    const unSession = await listen<{ receiver_id: string; status: string }>('session', (e) => {
      const { receiver_id, status } = e.payload;
      set({ sessionStatus: { ...get().sessionStatus, [receiver_id]: status } });
    });
    return () => {
      unTranscript();
      unTelemetry();
      unSession();
    };
  },
}));
