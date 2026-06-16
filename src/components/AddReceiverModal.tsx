import { useEffect, useState } from "react";
import { useStore, type Kind, type Lane } from "../state/store";
import { VOICE_MODES, DIGITAL_MODES, BANDS } from "../lib/format";

// Resolve a Broadcastify feed ID, listen-link, or full stream URL into a direct
// stream URL. Free public feeds stream at broadcastify.cdnstream1.com/<id>.
function broadcastifyUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s; // already a full URL — use as-is
  const m = s.match(/feed\/(\d+)/i) || s.match(/^#?(\d+)$/);
  return m ? `https://broadcastify.cdnstream1.com/${m[1]}` : null;
}

function broadcastifyId(input: string): string {
  const m = input.match(/feed\/(\d+)/i) || input.match(/(\d+)/);
  return m ? m[1] : input.trim();
}

export function AddReceiverModal() {
  const open = useStore((s) => s.addOpen);
  const setOpen = useStore((s) => s.setAddOpen);
  const addReceiver = useStore((s) => s.addReceiver);
  const addKind = useStore((s) => s.addKind);

  // Dropdown value — "broadcastify" is a UI convenience that maps to a feed.
  const [source, setSource] = useState<string>("kiwisdr");
  useEffect(() => {
    if (open) setSource(addKind);
  }, [open, addKind]);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [antenna, setAntenna] = useState("");
  const [mhz, setMhz] = useState("14.074");
  const [mode, setMode] = useState("usb");
  const [lane, setLane] = useState<Lane>("voice");

  if (!open) return null;

  const isBroadcastify = source === "broadcastify";
  const kind: Kind = isBroadcastify ? "feed" : (source as Kind);
  const isFeed = kind === "feed";
  const modes = lane === "voice" ? VOICE_MODES : DIGITAL_MODES;
  const mhzNum = Number(mhz);
  const mhzBad = !isFeed && mhz.trim() !== "" && !(mhzNum > 0);
  const valid = isBroadcastify
    ? broadcastifyUrl(url) != null
    : url.trim() !== "" && (isFeed || mhzNum > 0);

  const submit = () => {
    if (!valid) return;
    const resolvedUrl = isBroadcastify ? broadcastifyUrl(url)! : url.trim();
    const defaultLabel = isBroadcastify ? `Broadcastify · ${broadcastifyId(url)}` : undefined;
    addReceiver({
      kind,
      url: resolvedUrl,
      label: label.trim() || defaultLabel,
      freq_hz: isFeed ? 0 : Math.round(Number(mhz) * 1e6),
      mode: isFeed ? "fm" : mode,
      lane: isFeed ? "voice" : lane,
      antenna: antenna.trim() || undefined,
    });
    setUrl("");
    setLabel("");
    setAntenna("");
  };

  return (
    <div className="overlay" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add receiver</h2>
        <div className="body">
          <div className="grid2">
            <div>
              <label className="fld">Source</label>
              <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="kiwisdr">KiwiSDR</option>
                <option value="openwebrx">OpenWebRX</option>
                <option value="feed">Scanner Feed (stream URL)</option>
                <option value="broadcastify">Broadcastify (scanner)</option>
              </select>
            </div>
            {!isFeed && (
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
            )}
          </div>
          <div>
            <label className="fld">{isBroadcastify ? "Feed ID or link" : "URL"}</label>
            <input
              className="input"
              placeholder={
                isBroadcastify
                  ? "34503   or   broadcastify.com/listen/feed/34503"
                  : isFeed
                    ? "https://…  MP3/AAC scanner stream URL"
                    : "ws://host:port  or  http://host:port"
              }
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {isBroadcastify && (
              <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
                Free public feed — paste the number from a broadcastify.com/listen/feed/<b>NNNN</b> page
                (or the link). HamHawk builds the stream URL and transcribes it.
              </div>
            )}
            {isFeed && !isBroadcastify && (
              <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
                Paste a direct audio-stream URL (MP3/AAC). It's played and transcribed like any voice
                source. Police/P25 feeds = audio only (already demodulated upstream).
              </div>
            )}
          </div>
          {!isFeed && (
            <>
              <div className="grid2">
                <div>
                  <label className="fld">Frequency (MHz)</label>
                  <input className="input" type="number" min="0" step="any" value={mhz} onChange={(e) => setMhz(e.target.value)} />
                  {mhzBad && (
                    <div className="faint" style={{ fontSize: 11, marginTop: 4, color: "var(--err, #e66)" }}>
                      Frequency must be a positive number.
                    </div>
                  )}
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
                <label className="fld">Band presets</label>
                <div className="bandbar">
                  {BANDS.map((b) => (
                    <button
                      key={b.label}
                      onClick={() => {
                        if (!Number.isFinite(b.hz) || b.hz <= 0) return;
                        setMhz((b.hz / 1e6).toString());
                        if (lane === "voice") setMode(b.mode);
                      }}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          <div>
            <label className="fld">Label (optional)</label>
            <input
              className="input"
              placeholder={isBroadcastify ? "e.g. County PD Dispatch" : isFeed ? "e.g. County PD Dispatch" : "e.g. G8JNJ Kiwi — 20m"}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          {!isFeed && (
            <div>
              <label className="fld">Antenna (optional)</label>
              <input
                className="input"
                placeholder="e.g. Beverage 250m NE · Mini-Whip · 40m dipole"
                value={antenna}
                onChange={(e) => setAntenna(e.target.value)}
              />
              <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
                Shown in the memory list so you can pick a station by its antenna.
              </div>
            </div>
          )}
        </div>
        <div className="foot">
          <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn primary" disabled={!valid} onClick={submit}>Add &amp; Start</button>
        </div>
      </div>
    </div>
  );
}
