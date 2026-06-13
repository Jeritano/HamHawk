import { useState } from "react";
import { useStore, type Kind, type Lane } from "../state/store";
import { VOICE_MODES, DIGITAL_MODES, BANDS } from "../lib/format";

export function AddReceiverModal() {
  const open = useStore((s) => s.addOpen);
  const setOpen = useStore((s) => s.setAddOpen);
  const addReceiver = useStore((s) => s.addReceiver);

  const [kind, setKind] = useState<Kind>("kiwisdr");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [mhz, setMhz] = useState("14.074");
  const [mode, setMode] = useState("usb");
  const [lane, setLane] = useState<Lane>("voice");

  if (!open) return null;

  const modes = lane === "voice" ? VOICE_MODES : DIGITAL_MODES;
  const valid = url.trim() && Number(mhz) > 0;

  const submit = () => {
    if (!valid) return;
    addReceiver({
      kind,
      url: url.trim(),
      label: label.trim() || undefined,
      freq_hz: Math.round(Number(mhz) * 1e6),
      mode,
      lane,
    });
    // reset
    setUrl("");
    setLabel("");
  };

  return (
    <div className="overlay" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add receiver</h2>
        <div className="body">
          <div className="grid2">
            <div>
              <label className="fld">Source</label>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="kiwisdr">KiwiSDR</option>
                <option value="openwebrx">OpenWebRX</option>
              </select>
            </div>
            <div>
              <label className="fld">Lane</label>
              <select
                className="input"
                value={lane}
                onChange={(e) => {
                  const l = e.target.value as Lane;
                  setLane(l);
                  setMode(l === "voice" ? "usb" : "ft8");
                }}
              >
                <option value="voice">Voice (transcribe)</option>
                <option value="digital">Digital (decode)</option>
              </select>
            </div>
          </div>
          <div>
            <label className="fld">URL</label>
            <input className="input" placeholder="ws://host:port  or  http://host:port" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="grid2">
            <div>
              <label className="fld">Frequency (MHz)</label>
              <input className="input" value={mhz} onChange={(e) => setMhz(e.target.value)} />
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
          <div>
            <label className="fld">Label (optional)</label>
            <input className="input" placeholder="e.g. G8JNJ Kiwi — 20m" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div>
            <label className="fld">Band presets</label>
            <div className="bandbar">
              {BANDS.map((b) => (
                <button
                  key={b.label}
                  onClick={() => {
                    setMhz((b.hz / 1e6).toString());
                    if (lane === "voice") setMode(b.mode);
                  }}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="foot">
          <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn primary" disabled={!valid} onClick={submit}>Add &amp; Start</button>
        </div>
      </div>
    </div>
  );
}
