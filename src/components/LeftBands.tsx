import { Fragment, useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { BAND_GROUPS, type Band } from "../lib/bands";

/** Scrollable band/channel browser for the left rail. HF entries live-tune the
 *  active VFO; VHF/UHF/P25 (real police) are reference-only and say so. */
export function LeftBands() {
  const receivers = useStore((s) => s.receivers);
  const activeId = useStore((s) => s.activeId);
  const tune = useStore((s) => s.tune);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(noteTimer.current), []);

  const flash = (m: string) => {
    setNote(m);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 3500);
  };

  const click = (b: Band) => {
    if (b.tunable && b.freqHz != null) {
      const active = receivers.find((r) => r.id === activeId);
      if (!active) {
        flash("Select a VFO first");
        return;
      }
      tune(active.id, b.freqHz);
      flash(`Tuned ${b.name} · ${(b.freqHz / 1e6).toFixed(3)} MHz`);
    } else {
      flash(`${b.name} — ${b.band}: HF nodes can't receive this. Needs a scanner feed.`);
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
                className={"lband " + (b.tunable ? "tun" : "ref")}
                onClick={() => click(b)}
                title={b.tunable ? "Tune active VFO" : g.note}
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
