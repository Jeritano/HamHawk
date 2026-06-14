import { Fragment, useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { BAND_GROUPS, type Band } from "../lib/bands";

/** Scrollable band browser. HF entries are toggles: click to tune the active VFO
 *  + start + listen; click the same band again to stop. VHF/UHF/P25 (real police)
 *  aren't on HF, so they open the scanner-feed dialog instead. */
export function LeftBands() {
  const receivers = useStore((s) => s.receivers);
  const activeId = useStore((s) => s.activeId);
  const monitoredId = useStore((s) => s.monitoredId);
  const selectBand = useStore((s) => s.selectBand);
  const openAdd = useStore((s) => s.openAdd);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(noteTimer.current), []);

  const flash = (m: string) => {
    setNote(m);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 3500);
  };

  const active = receivers.find((r) => r.id === activeId) || null;
  const isOn = (b: Band) =>
    !!active &&
    monitoredId === active.id &&
    b.freqHz != null &&
    active.freq_hz === b.freqHz &&
    active.mode === b.mode;

  const click = (b: Band) => {
    if (b.tunable && b.freqHz != null) {
      selectBand(b.freqHz, b.mode || "usb");
      flash(isOn(b) ? `Stopped ${b.name}` : `${b.name} · ${(b.freqHz / 1e6).toFixed(3)} ${(b.mode || "").toUpperCase()}`);
    } else {
      openAdd("feed");
      flash(`${b.name} (${b.band}) isn't on HF — add a scanner feed URL to listen.`);
    }
  };

  return (
    <div className="lbands">
      <div className="lbands-head">Bands</div>
      {note && <div className="lbands-note">{note}</div>}
      <div className="lbands-list">
        {BAND_GROUPS.map((g) => (
          <Fragment key={g.title}>
            <div className="lbands-grp" title={g.note}>{g.title}</div>
            {g.items.map((b) => (
              <button
                key={b.name + b.sub}
                className={"lband " + (b.tunable ? "tun" : "ref") + (isOn(b) ? " on" : "")}
                onClick={() => click(b)}
                title={b.tunable ? "Click to start + listen · click again to stop" : g.note}
              >
                <div className="r1">
                  <span className="bn">{b.name}</span>
                  <span className={"bt b" + b.band}>{b.band}</span>
                </div>
                <div className="bs">{b.sub}</div>
              </button>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
