import { useEffect, useMemo, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { useStore, type ReceiverConfig } from "../state/store";
import { Waterfall } from "./Waterfall";
import { SpectrumTrace } from "./SpectrumTrace";
import { AudioScope } from "./AudioScope";
import { SMeterArc } from "./SMeterArc";
import { WorldMap, type MapPoint } from "./WorldMap";
import { LeftBands } from "./LeftBands";
import { extractGrid, gridToLatLon } from "../lib/maidenhead";
import { formatFreq, formatTimeHMS } from "../lib/format";
import { audioPlayer } from "../lib/audioPlayer";
import { telemetryBus } from "../lib/bus";

type LcdView = "scope" | "afscope" | "text" | "map" | "activity" | "log" | "bmarks" | "alerts";

// Best-effort callsign match for the logbook display (the file export uses the
// backend parser). e.g. K1ABC / W3ILT / DL1XYZ / VK2DEF.
function findCall(text: string): string | null {
  const m = text.toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z]{1,4}\b/);
  return m ? m[0] : null;
}

// Passband edges (Hz, relative to tuned freq) for a given mode + filter width.
function passbandFor(mode: string, width: number): { low_cut: number; high_cut: number } {
  const m = mode.toLowerCase();
  if (m === "am" || m === "amn") return { low_cut: -width / 2, high_cut: width / 2 };
  if (m === "cw" || m === "cwn") return { low_cut: 550 - width / 2, high_cut: 550 + width / 2 };
  return { low_cut: 300, high_cut: 300 + width }; // ssb
}

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
  const subId = useStore((s) => s.subId);
  const setSub = useStore((s) => s.setSub);
  const recordingIds = useStore((s) => s.recordingIds);
  const setEditId = useStore((s) => s.setEditId);
  const togglePlay = useStore((s) => s.togglePlay);
  const startReceiver = useStore((s) => s.startReceiver);
  const setWatched = useStore((s) => s.setWatched);
  const stopAll = useStore((s) => s.stopAll);
  const toggleRecording = useStore((s) => s.toggleRecording);
  const openAdd = useStore((s) => s.openAdd);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const setBestOpen = useStore((s) => s.setBestOpen);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const setRadioCtl = useStore((s) => s.setRadioCtl);
  const tune = useStore((s) => s.tune);
  const scanning = useStore((s) => s.scanning);
  const scanDir = useStore((s) => s.scanDir);
  const startScan = useStore((s) => s.startScan);
  const stopScan = useStore((s) => s.stopScan);
  const squelch = useStore((s) => s.squelch);
  const setSquelch = useStore((s) => s.setSquelch);

  const [view, setView] = useState<LcdView>("scope");
  const [vol, setVol] = useState(audioPlayer.getVolume());
  const [filterBw, setFilterBw] = useState(2400); // SSB default passband width (Hz)
  const [rfGain, setRfGain] = useState(0); // 0 = AGC (auto); >0 = manual RF gain
  const STEPS = [10, 100, 1000, 5000];
  const [stepIdx, setStepIdx] = useState(1); // default 100 Hz
  const step = STEPS[stepIdx];
  const [angle, setAngle] = useState(0);
  const dragY = useRef<number | null>(null);

  const main = receivers.find((r) => r.id === activeId) || null;
  // Filter/RF-gain control is wired only for KiwiSDR (the SET-command protocol).
  const kiwiMain = !!main && main.kind === "kiwisdr";
  // Memoized favorites-first order so the list isn't re-sorted on every unrelated
  // re-render (sessionStatus/activeId/transcript churn).
  const sortedReceivers = useMemo(
    () => [...receivers].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite)),
    [receivers],
  );
  // SUB = the receiver assigned to the right channel (dual receive), or null.
  const sub = receivers.find((r) => r.id === subId) || null;
  const mainStatus = main ? sessionStatus[main.id] ?? "stopped" : "stopped";
  const recording = main ? recordingIds.includes(main.id) : false;
  const anyRunning = Object.values(sessionStatus).some((s) => s !== "stopped");
  const tunable = !!main && main.kind !== "feed";

  // Tell the backend which waterfalls are on screen (only those compute spectrum).
  const watchIds = view === "scope" ? [main?.id, sub?.id].filter(Boolean).join(",") : "";
  useEffect(() => {
    setWatched(watchIds ? watchIds.split(",") : []);
  }, [watchIds, setWatched]);

  // Right-click a memory to assign/clear it as SUB (right channel, dual receive).
  const toggleSub = async (id: string) => {
    if (subId === id) {
      await setSub(null);
      return;
    }
    if (id === monitoredId) return; // can't be both MAIN and SUB
    if ((sessionStatus[id] ?? "stopped") === "stopped") {
      const ok = await startReceiver(id);
      if (!ok) return;
    }
    await setSub(id);
  };

  const stepLabel = step < 1000 ? `${step} Hz` : `${step / 1000} kHz`;
  const bump = (steps: number) => {
    if (!main || !tunable || steps === 0) return; // feeds aren't tunable
    tune(main.id, main.freq_hz + steps * step);
    setAngle((a) => a + steps * 8);
  };

  return (
    <div className="rig">
      <div className="window-drag-strip" data-tauri-drag-region />
      <div className="chassis">
        {/* LEFT COLUMN */}
        <div className="col left">
          <div className="brandplate" data-tauri-drag-region>
            <div className="logo">H</div>
            <div className="txt">
              Ham<b>Hawk</b>
            </div>
          </div>
          <div className="model">HX-1 · HF/VHF SDR MONITOR</div>
          <button
            className={"rigbtn power" + (anyRunning ? " on" : "")}
            title={anyRunning ? "Power off — stop all receivers" : "Power on — start the selected station"}
            disabled={!anyRunning && !activeId && receivers.length === 0}
            onClick={() => {
              if (anyRunning) {
                stopAll();
                return;
              }
              // Power ON: start + listen to the active (or first) station.
              const id = activeId || receivers[0]?.id;
              if (id) togglePlay(id);
            }}
          >
            <div className="led" />
            <div className="k">POWER</div>
            <div className="v">{anyRunning ? "on" : "idle"}</div>
          </button>
          <div className={"rigbtn scanbtn warn" + (scanning ? " on" : "")}>
            <div className="led" />
            <div className="k">{scanning ? "SCANNING" : "SCAN"}</div>
            <div className="scan-split">
              <button
                className={"scan-half" + (scanning && scanDir < 0 ? " on" : "")}
                disabled={!main}
                title="Scan down"
                onClick={() => {
                  if (!main) return;
                  scanning && scanDir < 0 ? stopScan() : startScan(main.id, -1);
                }}
              >
                ◀ DN
              </button>
              <button
                className={"scan-half" + (scanning && scanDir > 0 ? " on" : "")}
                disabled={!main}
                title="Scan up"
                onClick={() => {
                  if (!main) return;
                  scanning && scanDir > 0 ? stopScan() : startScan(main.id, 1);
                }}
              >
                UP ▶
              </button>
            </div>
          </div>
          <button className="rigbtn" onClick={() => setPaletteOpen(true)}>
            <div className="led" />
            <div className="k">SEARCH</div>
            <div className="v">⌘K</div>
          </button>
          <div className="rigbtn-row">
            <button className="rigbtn" onClick={() => openAdd("kiwisdr")}>
              <div className="led" />
              <div className="k">ADD</div>
              <div className="v">vfo</div>
            </button>
            <button className="rigbtn" onClick={() => setSettingsOpen(true)}>
              <div className="led" />
              <div className="k">SET</div>
              <div className="v">menu</div>
            </button>
          </div>
          <button className="rigbtn" title="Find the best-antenna KiwiSDR for a band/region" onClick={() => setBestOpen(true)}>
            <div className="led" />
            <div className="k">BEST RX</div>
            <div className="v">auto-pick</div>
          </button>
          <LeftBands />
        </div>

        {/* CENTER LCD */}
        <div className="lcd">
          <div className="lcd-top" data-tauri-drag-region>
            <span className="pill">ANT 1</span>
            <span className="pill">BW 2.4k</span>
            {main && <span className="pill">{main.mode.toUpperCase()}</span>}
            <span>{main ? mainStatus.toUpperCase() : "NO VFO"}</span>
            <span className="clock">
              <Clock /> <span className="utc">UTC</span>
            </span>
          </div>

          <div className="vfos">
            <Vfo rx={main} role="MAIN" />
            {/* Adaptive SUB cell: SUB meter when a SUB receiver is assigned,
                a live recent-decode ribbon when none is. */}
            <SubCell sub={sub} />
          </div>

          <div className="lcd-body">
            {view === "scope" && <ScopeView main={main} sub={sub} />}
            {view === "afscope" && <AudioScope />}
            {view === "text" && <TextView rx={main} />}
            {view === "map" && <MapView />}
            {view === "activity" && <ActivityView />}
            {view === "log" && <LogView />}
            {view === "bmarks" && <BookmarksView />}
            {view === "alerts" && <AlertsView />}
          </div>

          <div className="softkeys">
            {(
              [
                ["scope", "SCOPE"],
                ["afscope", "AF SCOPE"],
                ["text", "TEXT"],
                ["map", "MAP"],
                ["activity", "ACTIVITY"],
                ["log", "LOG"],
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
            <div className="tuneknob">
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
              <button
                className={"recbtn" + (recording ? " on" : "")}
                disabled={!main}
                title={recording ? "Recording — click to stop" : "Record MAIN to WAV"}
                onClick={() => main && toggleRecording(main.id)}
              >
                <span className="recdot" />
              </button>
            </div>
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

          {kiwiMain && (
            <>
              <div className="vol ctlrow" style={{ marginTop: 12 }}>
                <div className="knob-label" style={{ textAlign: "center", marginBottom: 4 }}>
                  FILTER <span style={{ color: "var(--teal)" }}>{(filterBw / 1000).toFixed(1)}k</span>
                </div>
                <input
                  className="slider"
                  type="range"
                  min={300}
                  max={6000}
                  step={100}
                  value={filterBw}
                  title="Receiver passband width"
                  onChange={(e) => {
                    const bw = Number(e.target.value);
                    setFilterBw(bw);
                    if (main) setRadioCtl(main.id, passbandFor(main.mode, bw));
                  }}
                />
              </div>
              <div className="vol ctlrow" style={{ marginTop: 12 }}>
                <div className="knob-label" style={{ textAlign: "center", marginBottom: 4 }}>
                  RF GAIN <span style={{ color: "var(--teal)" }}>{rfGain === 0 ? "AGC" : `${rfGain}`}</span>
                  <button
                    className={"agcbtn" + (rfGain === 0 ? " on" : "")}
                    title="Automatic gain control"
                    onClick={() => {
                      setRfGain(0);
                      if (main) setRadioCtl(main.id, { agc: true });
                    }}
                  >
                    AGC
                  </button>
                </div>
                <input
                  className="slider"
                  type="range"
                  min={0}
                  max={120}
                  step={1}
                  value={rfGain}
                  title="Manual RF gain (0 = AGC auto)"
                  onChange={(e) => {
                    const g = Number(e.target.value);
                    setRfGain(g);
                    if (main) setRadioCtl(main.id, g === 0 ? { agc: true } : { agc: false, man_gain: g });
                  }}
                />
              </div>
            </>
          )}

          <div className="rmem">
            <div className="rmem-head">Memory · {receivers.length}</div>
            <div className="rmem-list">
              {sortedReceivers.map((r) => {
                  const st = sessionStatus[r.id] ?? "stopped";
                  return (
                    <button
                      key={r.id}
                      className={
                        "rmem-item" +
                        (st !== "stopped" ? " playing" : "") +
                        (monitoredId === r.id ? " onair" : "") +
                        (subId === r.id ? " issub" : "")
                      }
                      title="Click to listen (MAIN) · right-click to set SUB (right channel) · click again to stop"
                      onClick={() => togglePlay(r.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        toggleSub(r.id);
                      }}
                    >
                      <div className="r1">
                        <span
                          className={"fav-star" + (r.favorite ? " on" : "")}
                          title={r.favorite ? "Unfavorite" : "Favorite (quick-connect, sorts to top)"}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFavorite(r.id);
                          }}
                        >
                          {r.favorite ? "★" : "☆"}
                        </span>
                        <span className={"dot " + st} />
                        <span className="fr">{formatFreq(r.freq_hz)}</span>
                        <span className="spacer" />
                        {monitoredId === r.id && <span className="onair-tag">ON AIR</span>}
                        {subId === r.id && <span className="sub-tag">SUB</span>}
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
                      </div>
                      <div className="nm">{r.label || r.url}</div>
                      {r.antenna && <div className="ant">📡 {r.antenna}</div>}
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

function Clock() {
  const [t, setT] = useState("");
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      setT(`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return <>{t}</>;
}

function Vfo({ rx, role, onClear }: { rx: ReceiverConfig | null; role: "MAIN" | "SUB"; onClear?: () => void }) {
  const id = rx?.id;
  const status = useStore((s) => (id ? s.sessionStatus[id] : undefined));
  const reason = useStore((s) => (id ? s.sessionReason[id] : undefined));
  if (!rx) {
    return (
      <div className={"vfo " + role.toLowerCase()}>
        <div className="vfo-head">
          <span className={"tag " + role.toLowerCase()}>{role}</span>
          <span className="vfo-name faint">—</span>
        </div>
        <SMeterArc id={"none-" + role} label={role} />
        {role === "SUB" ? (
          <div className="freq-sub faint" style={{ textAlign: "center", padding: "6px 0" }}>
            right-click a memory to assign SUB
          </div>
        ) : (
          <div className="freq dim">
            0.000.<span className="hz">000</span>
          </div>
        )}
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
        <SnrTag id={rx.id} />
        <span className="vfo-name">{rx.label || rx.url}</span>
        {onClear && (
          <button className="vfo-clear" title="Clear SUB (stop dual receive)" onClick={onClear}>
            ✕
          </button>
        )}
      </div>
      {reason && (status === "reconnecting" || status === "error") && (
        <div className={"vfo-reason " + status}>
          {status === "error" ? "✕ " : "⟳ "}
          {reason}
        </div>
      )}
      <SMeterArc id={rx.id} label={role} kind={rx.kind} />
      <div className="freq">
        {main}.<span className="hz">{hz}</span>
      </div>
      <div className="freq-sub">{(rx.freq_hz / 1e6).toFixed(5)} MHz · {rx.mode.toUpperCase()} · {rx.lane}</div>
    </div>
  );
}

// Live S/N readout driven off the telemetry bus (same ref-update, no-re-render
// pattern as SMeterArc). Hidden whenever snr_db is absent — never shows a fake 0.
function SnrTag({ id }: { id: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.style.display = "none"; // reset on id change
    const off = telemetryBus.on(id, (t) => {
      const el = ref.current;
      if (!el) return;
      if (t.snr_db != null && Number.isFinite(t.snr_db)) {
        el.textContent = `S/N ${t.snr_db > 0 ? "+" : ""}${t.snr_db.toFixed(0)}`;
        el.style.display = "";
      } else {
        el.style.display = "none";
      }
    });
    return off;
  }, [id]);
  return <span ref={ref} className="tag snr" style={{ display: "none" }} />;
}

/** Adaptive SUB cell: the SUB VFO meter when a SUB (right-channel) receiver is
 *  assigned, otherwise a live recent-decode ribbon so the slot is never dead. */
function SubCell({ sub }: { sub: ReceiverConfig | null }) {
  const setSub = useStore((s) => s.setSub);
  if (sub) return <Vfo rx={sub} role="SUB" onClear={() => setSub(null)} />;
  return <DecodeRibbon />;
}

/** Newest-first digital decodes (callsign + grid + S/N) from any running receiver.
 *  Click a row to make MAIN listen to the receiver that heard it. Real data only. */
function DecodeRibbon() {
  const transcripts = useStore((s) => s.transcripts);
  const receivers = useStore((s) => s.receivers);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const startReceiver = useStore((s) => s.startReceiver);
  const setMonitor = useStore((s) => s.setMonitor);
  const setActive = useStore((s) => s.setActive);

  const rows = useMemo(() => transcripts.filter((t) => t.lane === "digital").slice(0, 8), [transcripts]);

  const go = async (rid: string) => {
    if (!receivers.some((r) => r.id === rid)) return;
    setActive(rid);
    const running = (sessionStatus[rid] ?? "stopped") !== "stopped";
    const ok = running || (await startReceiver(rid));
    if (ok) await setMonitor(rid);
  };

  return (
    <div className="vfo subribbon">
      <div className="ribbon-head">RECENT DECODES</div>
      {rows.length === 0 ? (
        <div className="ribbon-empty">No digital decodes yet — right-click a memory to assign a SUB receiver.</div>
      ) : (
        <div className="ribbon-list">
          {rows.map((t) => {
            const call = findCall(t.text_en);
            const grid = extractGrid(t.text_en);
            return (
              <button
                className="ribbon-row"
                key={t.id + "-" + t.ts_start}
                title="Listen to the receiver that decoded this"
                onClick={() => go(t.receiver_id)}
              >
                <span className="rb-call">{call || t.mode.toUpperCase()}</span>
                {grid && <span className="rb-grid">{grid}</span>}
                <span className="rb-txt">{t.text_en}</span>
                {t.snr_db != null && <span className="rb-snr">{t.snr_db.toFixed(0)}</span>}
              </button>
            );
          })}
        </div>
      )}
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

function LogView() {
  const transcripts = useStore((s) => s.transcripts);
  const exportLog = useStore((s) => s.exportLog);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState("");
  const rows = transcripts.slice(0, 200);
  const doExport = async (fmt: "adif" | "csv") => {
    setBusy(true);
    // ADIF carries callsigns/grids → digital lane only; CSV exports everything.
    const path = await exportLog(fmt, fmt === "adif");
    setBusy(false);
    if (path) {
      setLast(path);
      openPath(path).catch(() => {});
    }
  };
  return (
    <div className="lcd-data">
      <div className="section-title">
        <span>Logbook ({transcripts.length})</span>
        <span>
          <button className="btn sm" disabled={busy || !transcripts.length} onClick={() => doExport("adif")}>
            Export ADIF
          </button>{" "}
          <button className="btn sm" disabled={busy || !transcripts.length} onClick={() => doExport("csv")}>
            Export CSV
          </button>
        </span>
      </div>
      {last && (
        <div className="faint" style={{ fontSize: 11, padding: "0 2px 8px", wordBreak: "break-all" }}>
          Saved → {last}
        </div>
      )}
      {rows.length === 0 && (
        <div className="faint" style={{ fontSize: 13, padding: 8 }}>
          No decodes or transcripts logged yet. Run a digital (FT8/CW) or voice receiver.
        </div>
      )}
      {rows.map((t) => {
        const call = findCall(t.text_en);
        const grid = extractGrid(t.text_en);
        return (
          <div className="list-row" key={t.id + "-" + t.ts_start}>
            <div className="main">
              <div className="t" style={{ whiteSpace: "normal" }}>
                {call && <span style={{ color: "var(--teal)", fontWeight: 700 }}>{call} </span>}
                {grid && <span className="faint">{grid} </span>}
                <span style={{ fontWeight: 400 }}>{t.text_en}</span>
              </div>
              <div className="s">
                {formatTimeHMS(t.ts_start)} · {t.mode.toUpperCase()} · {t.lane}
                {t.snr_db != null ? ` · ${t.snr_db.toFixed(0)}dB` : ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BookmarksView() {
  const bookmarks = useStore((s) => s.bookmarks);
  const receivers = useStore((s) => s.receivers);
  const activeId = useStore((s) => s.activeId);
  const addBookmark = useStore((s) => s.addBookmark);
  const applyBookmark = useStore((s) => s.applyBookmark);
  const removeBookmark = useStore((s) => s.removeBookmark);
  const active = receivers.find((r) => r.id === activeId);
  return (
    <div className="lcd-data">
      <div className="section-title">
        <span>Bookmarks ({bookmarks.length})</span>
        <button
          className="btn sm primary"
          disabled={!active}
          onClick={() =>
            active &&
            addBookmark({
              id: `bm_${Date.now()}`,
              label: active.label || active.url,
              kind: active.kind,
              url: active.url,
              freq_hz: active.freq_hz,
              mode: active.mode,
              lane: active.lane,
            })
          }
        >
          ★ Save current
        </button>
      </div>
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
