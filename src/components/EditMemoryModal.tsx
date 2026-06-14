import { useEffect, useState } from "react";
import { useStore, type Kind, type Lane } from "../state/store";
import { VOICE_MODES, DIGITAL_MODES } from "../lib/format";

/** Edit a saved memory: fine-tune frequency, change mode/lane/label, save or delete. */
export function EditMemoryModal() {
  const editId = useStore((s) => s.editId);
  const setEditId = useStore((s) => s.setEditId);
  const receivers = useStore((s) => s.receivers);
  const updateReceiver = useStore((s) => s.updateReceiver);
  const removeReceiver = useStore((s) => s.removeReceiver);

  const rx = receivers.find((r) => r.id === editId) || null;

  const [label, setLabel] = useState("");
  const [hz, setHz] = useState(0);
  const [mode, setMode] = useState("usb");
  const [lane, setLane] = useState<Lane>("voice");
  const [kind, setKind] = useState<Kind>("kiwisdr");
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (rx) {
      setLabel(rx.label || "");
      setHz(rx.freq_hz);
      setMode(rx.mode);
      setLane(rx.lane);
      setKind(rx.kind);
      setUrl(rx.url);
    }
  }, [editId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rx) return null;

  const modes = lane === "voice" ? VOICE_MODES : DIGITAL_MODES;
  const nudge = (d: number) => setHz((h) => Math.max(0, h + d));
  const save = () =>
    updateReceiver({
      ...rx,
      label: label.trim() || undefined,
      freq_hz: Math.round(hz),
      mode,
      lane,
      kind,
      url: url.trim() || rx.url,
    });

  const mhz = (hz / 1e6).toFixed(5);

  return (
    <div className="overlay" onClick={() => setEditId(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Edit memory</h2>
        <div className="body">
          <div>
            <label className="fld">Label</label>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="(optional)" />
          </div>

          <div>
            <label className="fld">Frequency — {mhz} MHz</label>
            <input
              className="input"
              type="number"
              step="0.00001"
              value={mhz}
              onChange={(e) => setHz(Math.round(Number(e.target.value) * 1e6))}
            />
            <div className="bandbar" style={{ marginTop: 8 }}>
              <button onClick={() => nudge(-1000)}>−1k</button>
              <button onClick={() => nudge(-100)}>−100</button>
              <button onClick={() => nudge(-10)}>−10</button>
              <button onClick={() => nudge(10)}>+10</button>
              <button onClick={() => nudge(100)}>+100</button>
              <button onClick={() => nudge(1000)}>+1k</button>
              <span className="faint" style={{ alignSelf: "center", fontSize: 11 }}>Hz</span>
            </div>
          </div>

          <div className="grid2">
            <div>
              <label className="fld">Lane</label>
              <select
                className="input"
                value={lane}
                onChange={(e) => {
                  const l = e.target.value as Lane;
                  setLane(l);
                  if (!(l === "voice" ? VOICE_MODES : DIGITAL_MODES).includes(mode)) {
                    setMode(l === "voice" ? "usb" : "ft8");
                  }
                }}
              >
                <option value="voice">Voice (transcribe)</option>
                <option value="digital">Digital (decode)</option>
              </select>
            </div>
            <div>
              <label className="fld">Mode</label>
              <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
                {modes.map((m) => (
                  <option key={m} value={m}>{m.toUpperCase()}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid2">
            <div>
              <label className="fld">Source</label>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="kiwisdr">KiwiSDR</option>
                <option value="openwebrx">OpenWebRX</option>
              </select>
            </div>
            <div>
              <label className="fld">URL</label>
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
          </div>
          <div className="faint" style={{ fontSize: 11 }}>
            Running memories restart to apply. Tip: turning the MAIN TUNING knob also saves the active
            memory's frequency live.
          </div>
        </div>
        <div className="foot">
          <button className="btn danger" onClick={() => removeReceiver(rx.id)} style={{ marginRight: "auto" }}>
            Delete
          </button>
          <button className="btn" onClick={() => setEditId(null)}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
