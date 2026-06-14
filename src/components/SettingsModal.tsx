import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { useStore } from "../state/store";

interface Settings {
  asr_worker_count: number;
  whisper_model_path?: string;
  recording_dir?: string;
}

export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const [settings, setSettings] = useState<Settings>({ asr_worker_count: 2 });
  const [effectiveDir, setEffectiveDir] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      invoke<Settings>("get_settings").then(setSettings).catch(() => {});
      invoke<string>("recordings_dir").then(setEffectiveDir).catch(() => {});
    }
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
            <label className="fld">ASR worker count</label>
            <input
              className="input"
              type="number"
              min={1}
              max={8}
              value={settings.asr_worker_count}
              onChange={(e) => setSettings({ ...settings, asr_worker_count: Number(e.target.value) })}
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
            <label className="fld">Whisper model path</label>
            <input
              className="input"
              placeholder="~/.hamhawk/models/ggml-base.bin"
              value={settings.whisper_model_path ?? ""}
              onChange={(e) => setSettings({ ...settings, whisper_model_path: e.target.value || undefined })}
            />
            <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
              Leave default to use <code>~/.hamhawk/models/ggml-base.bin</code>. Without a model, audio
              and waterfall still work; transcription is disabled.
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
