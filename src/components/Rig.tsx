import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type ReceiverConfig } from "../state/store";
import { Waterfall } from "./Waterfall";
import { SpectrumTrace } from "./SpectrumTrace";
import { SMeterArc } from "./SMeterArc";
import { WorldMap, type MapPoint } from "./WorldMap";
import { LeftBands } from "./LeftBands";
import { extractGrid, gridToLatLon } from "../lib/maidenhead";
import { formatFreq, formatTimeHMS } from "../lib/format";
import { audioPlayer } from "../lib/audioPlayer";

type LcdView = "scope" | "text" | "map" | "mem" | "activity" | "bmarks" | "alerts";

function freqParts(hz: number) {
  const s = hz.toLocaleString("de-DE"); // dot-grouped, e.g. 7.077.600
  const parts = s.split(".");
  const hzPart = parts.length > 1 ? parts.pop()! : "000";
  return { main: parts.join("."), hz: hzPart };
}

export function Rig() {
  const receivers = useStore((s) => s.receivers);
  const activeId = useStore((s) => s.activeId);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const monitoredId = useStore((s) => s.monitoredId);
  const recordingIds = useStore((s) => s.recordingIds);
  const setActive = useStore((s) => s.setActive);
  const setEditId = useStore((s) => s.setEditId);
  const startReceiver = useStore((s) => s.startReceiver);
  const stopReceiver = useStore((s) => s.stopReceiver);
  const setMonitor = useStore((s) => s.setMonitor);
  const toggleRecording = useStore((s) => s.toggleRecording);
  const setAddOpen = useStore((s) => s.setAddOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const tune = useStore((s) => s.tune);
  const scanning = useStore((s) => s.scanning);
  const startScan = useStore((s) => s.startScan);
  const stopScan = useStore((s) => s.stopScan);
  const squelch = useStore((s) => s.squelch);
  const setSquelch = useStore((s) => s.setSquelch);

  const [view, setView] = useState<LcdView>("scope");
  const [vol, setVol] = useState(audioPlayer.getVolume());
  const [clock, setClock] = useState("");
  const STEPS = [10, 100, 1000, 5000];
  const [stepIdx, setStepIdx] = useState(1); // default 100 Hz
  const step = STEPS[stepIdx];
  const [angle, setAngle] = useState(0);
  const dragY = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      setClock(`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const main = receivers.find((r) => r.id === activeId) || null;
  const sub =
    monitoredId && monitoredId !== activeId ? receivers.find((r) => r.id === monitoredId) || null : null;
  const mainStatus = main ? sessionStatus[main.id] ?? "stopped" : "stopped";
  const listening = main ? monitoredId === main.id : false;
  const recording = main ? recordingIds.includes(main.id) : false;

  const stepLabel = step < 1000 ? `${step} Hz` : `${step / 1000} kHz`;
  const bump = (steps: number) => {
    if (!main || steps === 0) return;
    tune(main.id, main.freq_hz + steps * step);
    setAngle((a) => a + steps * 8);
  };

  return (
    <div className="rig">
      <div className="chassis">
        {/* LEFT COLUMN */}
        <div className="col left">
          <div className="brandplate">
            <div className="logo">H</div>
            <div className="txt">
              Ham<b>Hawk</b>
            </div>
          </div>
          <div className="model">HX-1 · HF/VHF SDR MONITOR</div>
          <div className="rigbtn power">
            <div className="led" />
            <div className="k">POWER</div>
            <div className="v">on</div>
          </div>
          <button
            className={"rigbtn" + (listening ? " on" : "")}
            disabled={!main || main.lane !== "voice"}
            onClick={async () => {
              if (!main) return;
              if (listening) setMonitor(null);
              else {
                if (mainStatus !== "live" && mainStatus !== "connecting") await startReceiver(main.id);
                setMonitor(main.id);
              }
            }}
          >
            <div className="led" />
            <div className="k">LISTEN</div>
            <div className="v">{listening ? "on" : "af"}</div>
          </button>
          <button
            className={"rigbtn rec" + (recording ? " on" : "")}
            disabled={!main}
            onClick={() => main && toggleRecording(main.id)}
          >
            <div className="led" />
            <div className="k">REC</div>
            <div className="v">wav</div>
          </button>
          <button
            className={"rigbtn warn" + (mainStatus === "live" || mainStatus === "connecting" ? " on" : "")}
            disabled={!main}
            onClick={() => {
              if (!main) return;
              if (mainStatus === "stopped") startReceiver(main.id);
              else stopReceiver(main.id);
            }}
          >
            <div className="led" />
            <div className="k">{mainStatus === "stopped" ? "START" : "STOP"}</div>
            <div className="v">rx</div>
          </button>
          <button
            className={"rigbtn warn" + (scanning ? " on" : "")}
            disabled={!main}
            onClick={() => {
              if (!main) return;
              scanning ? stopScan() : startScan(main.id);
            }}
          >
            <div className="led" />
            <div className="k">{scanning ? "SCANNING" : "SCAN"}</div>
            <div className="v">squelch</div>
          </button>
          <button className="rigbtn" onClick={() => setAddOpen(true)}>
            <div className="led" />
            <div className="k">ADD</div>
            <div className="v">vfo</div>
          </button>
          <button className="rigbtn" onClick={() => setPaletteOpen(true)}>
            <div className="led" />
            <div className="k">SEARCH</div>
            <div className="v">⌘K</div>
          </button>
          <button className="rigbtn" onClick={() => setSettingsOpen(true)}>
            <div className="led" />
            <div className="k">SET</div>
            <div className="v">menu</div>
          </button>
          <LeftBands />
        </div>

        {/* CENTER LCD */}
        <div className="lcd">
          <div className="lcd-top">
            <span className="pill">ANT 1</span>
            <span className="pill">BW 2.4k</span>
            {main && <span className="pill">{main.mode.toUpperCase()}</span>}
            <span>{main ? mainStatus.toUpperCase() : "NO VFO"}</span>
            <span className="clock">
              {clock} <span className="utc">UTC</span>
            </span>
          </div>

          <div className="vfos">
            <Vfo rx={main} role="MAIN" />
            <Vfo rx={sub} role="SUB" />
          </div>

          <div className="lcd-body">
            {view === "scope" && <ScopeView main={main} sub={sub} />}
            {view === "text" && <TextView rx={main} />}
            {view === "map" && <MapView />}
            {view === "mem" && <MemView />}
            {view === "activity" && <ActivityView />}
            {view === "bmarks" && <BookmarksView />}
            {view === "alerts" && <AlertsView />}
          </div>

          <div className="softkeys">
            {(
              [
                ["scope", "SCOPE"],
                ["text", "TEXT"],
                ["map", "MAP"],
                ["mem", "MEMORY"],
                ["activity", "ACTIVITY"],
                ["bmarks", "BMARKS"],
                ["alerts", "ALERTS"],
              ] as [LcdView, string][]
            ).map(([v, label]) => (
              <button key={v} className={"softkey" + (view === v ? " on" : "")} onClick={() => setView(v)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* RIGHT COLUMN — knobs */}
        <div className="col right" style={{ alignItems: "center" }}>
          <div className="knobwrap">
            <div
              className="knob small"
              title="Multi — click to change tuning step"
              onClick={() => setStepIdx((i) => (i + 1) % STEPS.length)}
            />
            <div className="knob-label">MULTI · STEP</div>
            <div className="knob-label" style={{ color: "var(--teal)" }}>{stepLabel}</div>
          </div>
          <div className="knobwrap" style={{ marginTop: 6 }}>
            <div
              className="knob tune"
              style={{ transform: `rotate(${angle}deg)`, cursor: "ns-resize", touchAction: "none" }}
              title="Tuning — drag up/down or scroll to change frequency"
              onWheel={(e) => bump(e.deltaY > 0 ? -1 : 1)}
              onPointerDown={(e) => {
                dragY.current = e.clientY;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (dragY.current == null) return;
                const dy = dragY.current - e.clientY; // up = increase
                const steps = Math.trunc(dy / 4);
                if (steps !== 0) {
                  bump(steps);
                  dragY.current = e.clientY;
                }
              }}
              onPointerUp={() => (dragY.current = null)}
              onPointerCancel={() => (dragY.current = null)}
            />
            <div className="knob-label">MAIN TUNING</div>
            <div className="knob-label" style={{ color: "var(--teal)" }}>
              {main ? formatFreq(main.freq_hz) : "—"}
            </div>
          </div>
          <div className="vol" style={{ marginTop: 10 }}>
            <div className="knob-label" style={{ textAlign: "center", marginBottom: 4 }}>
              AF / VOLUME
            </div>
            <input
              className="slider"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={vol}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVol(v);
                audioPlayer.setVolume(v);
              }}
            />
          </div>
          <div className="vol" style={{ marginTop: 12 }}>
            <div className="knob-label" style={{ textAlign: "center", marginBottom: 4 }}>
              SQUELCH <span style={{ color: "var(--teal)" }}>{squelch} dBm</span>
            </div>
            <input
              className="slider"
              type="range"
              min={-120}
              max={-40}
              step={1}
              value={squelch}
              onChange={(e) => setSquelch(Number(e.target.value))}
            />
          </div>

          <div className="rmem">
            <div className="rmem-head">Memory · {receivers.length}</div>
            <div className="rmem-list">
              {receivers.map((r) => {
                const st = sessionStatus[r.id] ?? "stopped";
                return (
                  <button
                    key={r.id}
                    className={"rmem-item" + (activeId === r.id ? " active" : "")}
                    onClick={() => setActive(r.id)}
                  >
                    <div className="r1">
                      <span className={"dot " + st} />
                      <span className="fr">{formatFreq(r.freq_hz)}</span>
                      <span className="spacer" />
                      <span
                        className="rmem-go"
                        title="Edit / fine-tune"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditId(r.id);
                        }}
                      >
                        ✎
                      </span>
                      <span
                        className="rmem-go"
                        title={st === "stopped" ? "Start" : "Stop"}
                        onClick={(e) => {
                          e.stopPropagation();
                          st === "stopped" ? startReceiver(r.id) : stopReceiver(r.id);
                        }}
                      >
                        {st === "stopped" ? "▶" : "■"}
                      </span>
                    </div>
                    <div className="nm">{r.label || r.url}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Vfo({ rx, role }: { rx: ReceiverConfig | null; role: "MAIN" | "SUB" }) {
  if (!rx) {
    return (
      <div className={"vfo " + role.toLowerCase()}>
        <div className="vfo-head">
          <span className={"tag " + role.toLowerCase()}>{role}</span>
          <span className="vfo-name faint">—</span>
        </div>
        <SMeterArc id={"none-" + role} label={role} />
        <div className="freq dim">
          0.000.<span className="hz">000</span>
        </div>
      </div>
    );
  }
  const { main, hz } = freqParts(rx.freq_hz);
  return (
    <div className={"vfo " + role.toLowerCase()}>
      <div className="vfo-head">
        <span className={"tag " + role.toLowerCase()}>{role}</span>
        <span className="tag mode">{rx.mode.toUpperCase()}</span>
        <span className="tag fil">FIL2</span>
        <span className="vfo-name">{rx.label || rx.url}</span>
      </div>
      <SMeterArc id={rx.id} label={role} />
      <div className="freq">
        {main}.<span className="hz">{hz}</span>
      </div>
      <div className="freq-sub">{(rx.freq_hz / 1e6).toFixed(5)} MHz · {rx.mode.toUpperCase()} · {rx.lane}</div>
    </div>
  );
}

function ScopePane({ rx, role }: { rx: ReceiverConfig; role: string }) {
  return (
    <div className="scope">
      <div className="scope-head">
        <span>{role}</span>
        <span>{formatFreq(rx.freq_hz)}</span>
        <span>{rx.mode.toUpperCase()}</span>
      </div>
      <SpectrumTrace id={rx.id} />
      <div className="wf">
        <Waterfall id={rx.id} />
      </div>
      <div className="scope-scale">
        <span>0</span>
        <span>AF SPECTRUM</span>
        <span>~6 kHz</span>
      </div>
    </div>
  );
}

function ScopeView({ main, sub }: { main: ReceiverConfig | null; sub: ReceiverConfig | null }) {
  if (!main) {
    return (
      <div className="lcd-empty">
        <div className="big">📡</div>
        <div>No VFO selected — ADD a station or pick one from MEMORY</div>
      </div>
    );
  }
  return (
    <div className={"scope-grid" + (sub ? "" : " single")}>
      <ScopePane rx={main} role="MAIN" />
      {sub && <ScopePane rx={sub} role="SUB" />}
    </div>
  );
}

function TextView({ rx }: { rx: ReceiverConfig | null }) {
  const transcripts = useStore((s) => s.transcripts);
  const rows = rx ? transcripts.filter((t) => t.receiver_id === rx.id) : [];
  if (!rx || rows.length === 0)
    return <div className="lcd-empty"><div>{rx ? "No decodes yet." : "No VFO."}</div></div>;
  return (
    <div className="lcd-data">
      {rows.map((t) => (
        <div className="tr-row" key={t.id + "-" + t.ts_start}>
          <div className="tr-time">{formatTimeHMS(t.ts_start)}</div>
          <div>
            <div className="tr-tags">
              {t.src_lang && <span className="tr-lang">🌐 {t.src_lang}</span>}
              {t.snr_db != null && <span className="faint" style={{ fontSize: 10 }}>{t.snr_db.toFixed(0)} dB</span>}
            </div>
            <div className={"tr-text" + (t.lane === "digital" ? " digital" : "")}>{t.text_en}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MapView() {
  const transcripts = useStore((s) => s.transcripts);
  const points = useMemo<MapPoint[]>(() => {
    const seen = new Set<string>();
    const out: MapPoint[] = [];
    for (const t of transcripts) {
      const g = extractGrid(t.text_en);
      if (!g) continue;
      const ll = gridToLatLon(g);
      if (!ll) continue;
      const k = g.slice(0, 6).toUpperCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ lat: ll[0], lon: ll[1], label: `${t.text_en} (${g})` });
      if (out.length > 300) break;
    }
    return out;
  }, [transcripts]);
  return (
    <div className="lcd-data">
      <WorldMap points={points} />
      <div className="map-legend">{points.length} station(s) located from decoded grid squares.</div>
    </div>
  );
}

function MemView() {
  const receivers = useStore((s) => s.receivers);
  const activeId = useStore((s) => s.activeId);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const setActive = useStore((s) => s.setActive);
  const startReceiver = useStore((s) => s.startReceiver);
  const stopReceiver = useStore((s) => s.stopReceiver);
  return (
    <div className="lcd-data">
      <div className="section-title">
        <span>Memory channels ({receivers.length})</span>
      </div>
      <div className="mem-grid">
        {receivers.map((r) => {
          const st = sessionStatus[r.id] ?? "stopped";
          return (
            <div
              key={r.id}
              className={"mem" + (activeId === r.id ? " active" : "")}
              onClick={() => setActive(r.id)}
            >
              <div className="row">
                <span className={"dot " + st} style={{ width: 7, height: 7, borderRadius: "50%" }} />
                <span className="nm">{r.label || r.url}</span>
              </div>
              <div className="row">
                <span className="fr">{formatFreq(r.freq_hz)}</span>
                <span className="mt">{r.mode.toUpperCase()}</span>
                <span className="spacer" />
                <button
                  className="btn sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    st === "stopped" ? startReceiver(r.id) : stopReceiver(r.id);
                  }}
                >
                  {st === "stopped" ? "▶" : "■"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActivityView() {
  const transcripts = useStore((s) => s.transcripts);
  const digital = transcripts.filter((t) => t.lane === "digital").slice(0, 80);
  if (digital.length === 0) return <div className="lcd-empty"><div>No digital decodes yet.</div></div>;
  return (
    <div className="lcd-data">
      {digital.map((t) => (
        <div className="ba-row" key={t.id + "-" + t.ts_start}>
          <span>{t.text_en}</span>
          <span className="snr">{t.snr_db != null ? `${t.snr_db.toFixed(0)}dB` : ""}</span>
          <span className="tm">{formatTimeHMS(t.ts_start)}</span>
        </div>
      ))}
    </div>
  );
}

function BookmarksView() {
  const bookmarks = useStore((s) => s.bookmarks);
  const applyBookmark = useStore((s) => s.applyBookmark);
  const removeBookmark = useStore((s) => s.removeBookmark);
  return (
    <div className="lcd-data">
      <div className="section-title"><span>Bookmarks ({bookmarks.length})</span></div>
      {bookmarks.length === 0 && <div className="faint" style={{ fontSize: 13, padding: 8 }}>None. Save one from a running VFO.</div>}
      {bookmarks.map((b) => (
        <div className="list-row" key={b.id}>
          <div className="main">
            <div className="t">{b.label}</div>
            <div className="s">{formatFreq(b.freq_hz)} · {b.mode.toUpperCase()} · {b.lane}</div>
          </div>
          <button className="btn sm" onClick={() => applyBookmark(b)}>Tune</button>
          <button className="btn sm icon danger" onClick={() => removeBookmark(b.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}

function AlertsView() {
  const rules = useStore((s) => s.alertRules);
  const hits = useStore((s) => s.alertHits);
  const addAlertRule = useStore((s) => s.addAlertRule);
  const removeAlertRule = useStore((s) => s.removeAlertRule);
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  return (
    <div className="lcd-data">
      <div className="section-title"><span>Alert rules</span></div>
      <div className="list-row" style={{ flexWrap: "wrap", gap: 6 }}>
        <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 90 }} />
        <input className="input" placeholder="Keyword" value={pattern} onChange={(e) => setPattern(e.target.value)} style={{ flex: 1, minWidth: 90 }} />
        <button className="btn sm primary" disabled={!name || !pattern} onClick={() => { addAlertRule({ name, pattern, enabled: true }); setName(""); setPattern(""); }}>Add</button>
      </div>
      {rules.map((r) => (
        <div className="list-row" key={r.id}>
          <div className="main"><div className="t">{r.name}</div><div className="s">matches “{r.pattern}”</div></div>
          <button className="btn sm icon danger" onClick={() => removeAlertRule(r.id)}>✕</button>
        </div>
      ))}
      <div className="section-title" style={{ marginTop: 12 }}><span>Recent hits ({hits.length})</span></div>
      {hits.slice(0, 40).map((h, i) => (
        <div className="list-row" key={i}>
          <div className="main"><div className="t" style={{ color: "var(--amber)" }}>{h.rule_name}</div><div className="s" style={{ whiteSpace: "normal" }}>{h.text}</div></div>
          <span className="tm faint" style={{ fontSize: 10 }}>{formatTimeHMS(h.ts_ms)}</span>
        </div>
      ))}
    </div>
  );
}
