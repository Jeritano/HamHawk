import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { useStore } from "../state/store";
import {
  THEMES,
  getTheme,
  getControlSize,
  applyTheme,
  applyControlSize,
  type ThemeId,
  type ControlSize,
} from "../lib/theme";

interface Settings {
  asr_worker_count: number;
  whisper_model_path?: string;
  recording_dir?: string;
}
interface ModelStatus {
  present: boolean;
  path?: string;
  source: string;
  default_path: string;
}
interface DlState {
  received: number;
  total: number;
  done: boolean;
  error?: string;
}

export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const [settings, setSettings] = useState<Settings>({ asr_worker_count: 2 });
  const [effectiveDir, setEffectiveDir] = useState("");
  const [saving, setSaving] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(getTheme());
  const [controlSize, setControlSize] = useState<ControlSize>(getControlSize());
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [dl, setDl] = useState<DlState | null>(null);

  const refreshModel = () => invoke<ModelStatus>("model_status").then(setModel).catch(() => {});

  useEffect(() => {
    if (!open) return;
    invoke<Settings>("get_settings").then(setSettings).catch(() => {});
    invoke<string>("recordings_dir").then(setEffectiveDir).catch(() => {});
    refreshModel();
    // Live model-download progress.
    const un = listen<DlState>("model_dl", (e) => {
      setDl(e.payload);
      if (e.payload.done && !e.payload.error) refreshModel();
    });
    return () => {
      un.then((f) => f());
    };
  }, [open]);

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    try {
      await invoke("set_settings", { settings });
      setOpen(false);
    } catch {
      /* surfaced elsewhere */
    }
    setSaving(false);
  };

  const chooseFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Choose recordings folder" });
    if (typeof dir === "string") {
      setSettings((s) => ({ ...s, recording_dir: dir }));
      setEffectiveDir(dir);
    }
  };

  const chooseModel = async () => {
    const f = await openDialog({
      multiple: false,
      title: "Choose Whisper model (.bin)",
      filters: [{ name: "GGML model", extensions: ["bin"] }],
    });
    if (typeof f === "string") setSettings((s) => ({ ...s, whisper_model_path: f }));
  };

  const startDownload = () => {
    setDl({ received: 0, total: 0, done: false });
    invoke("download_model").catch((e) => setDl({ received: 0, total: 0, done: true, error: String(e) }));
  };

  const revealFolder = async () => {
    const dir = settings.recording_dir || effectiveDir;
    if (dir) await openPath(dir).catch(() => {});
  };

  return (
    <div className="overlay" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <div className="body">
          <div>
            <label className="fld">Accessibility — color theme</label>
            <select
              className="input"
              value={theme}
              onChange={(e) => {
                const t = e.target.value as ThemeId;
                setTheme(t);
                applyTheme(t); // live preview + persist immediately
              }}
            >
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} — {t.note}
                </option>
              ))}
            </select>
            <div className="row" style={{ marginTop: 8 }}>
              <label className="fld" style={{ margin: 0 }}>Larger controls</label>
              <span className="spacer" />
              <button
                className={"btn sm" + (controlSize === "large" ? " primary" : "")}
                onClick={() => {
                  const s: ControlSize = controlSize === "large" ? "normal" : "large";
                  setControlSize(s);
                  applyControlSize(s);
                }}
              >
                {controlSize === "large" ? "On" : "Off"}
              </button>
            </div>
            <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
              Colorblind-safe palettes keep the status colors (live / sub / alert) distinguishable.
              Applies instantly and is remembered.
            </div>
          </div>

          <div>
            <label className="fld">ASR worker count</label>
            <input
              className="input"
              type="number"
              min={1}
              max={8}
              value={settings.asr_worker_count}
              onChange={(e) => {
                const n = Number(e.target.value);
                const clamped = Number.isFinite(n) ? Math.max(1, Math.min(8, n)) : 1;
                setSettings({ ...settings, asr_worker_count: clamped });
              }}
            />
            <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
              Parallel Whisper transcription workers.
            </div>
          </div>

          <div>
            <label className="fld">Recordings folder</label>
            <input
              className="input"
              placeholder={effectiveDir}
              value={settings.recording_dir ?? ""}
              onChange={(e) => setSettings({ ...settings, recording_dir: e.target.value || undefined })}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={chooseFolder}>Choose…</button>
              <button className="btn sm" onClick={revealFolder}>Reveal in Finder</button>
              <span className="spacer" />
            </div>
            <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
              WAVs save as <code>&lt;station&gt;-&lt;date-time&gt;.wav</code> here. Currently:{" "}
              <span style={{ color: "var(--teal)" }}>{settings.recording_dir || effectiveDir}</span>.
              Applies to newly-started recordings.
            </div>
          </div>

          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <label className="fld" style={{ margin: 0 }}>Whisper model (voice transcription)</label>
              <span className="spacer" />
              {model && (
                <span className={"model-status " + (model.present ? "ok" : "no")}>
                  {model.present ? `Ready · ${model.source}` : "Not installed"}
                </span>
              )}
            </div>
            <input
              className="input"
              placeholder="~/.hamhawk/models/ggml-base.bin"
              value={settings.whisper_model_path ?? ""}
              onChange={(e) => setSettings({ ...settings, whisper_model_path: e.target.value || undefined })}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={chooseModel}>Choose…</button>
              <button
                className="btn sm primary"
                disabled={model?.present || (!!dl && !dl.done)}
                onClick={startDownload}
              >
                {dl && !dl.done ? "Downloading…" : "Download base model"}
              </button>
              <span className="spacer" />
            </div>
            {dl && (
              <div style={{ marginTop: 6 }}>
                {dl.error ? (
                  <div className="faint" style={{ fontSize: 11, color: "var(--red)" }}>Download failed — {dl.error}</div>
                ) : dl.done ? (
                  <div className="faint" style={{ fontSize: 11, color: "var(--green)" }}>Model downloaded — ready.</div>
                ) : (
                  <>
                    <div className="model-dl-bar">
                      <div style={{ width: dl.total ? `${Math.round((dl.received / dl.total) * 100)}%` : "0%" }} />
                    </div>
                    <div className="faint" style={{ fontSize: 10, marginTop: 3 }}>
                      {(dl.received / 1e6).toFixed(1)} MB{dl.total ? ` / ${(dl.total / 1e6).toFixed(0)} MB` : ""}
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
              Without a model, audio + waterfall + digital decode still work; only voice transcription is
              disabled. Default: <code>~/.hamhawk/models/ggml-base.bin</code>.
            </div>
          </div>
        </div>
        <div className="foot">
          <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn primary" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
