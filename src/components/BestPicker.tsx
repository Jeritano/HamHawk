import { useMemo, useState } from "react";
import { useStore } from "../state/store";
import { KIWI_CATALOG, CATALOG_REGIONS, type KiwiCatalogEntry } from "../lib/kiwicatalog";
import { BANDS } from "../lib/format";

// "Best receiver" picker (RHR-inspired): rank curated KiwiSDR nodes by real SNR +
// antenna quality, filter by region, and add+tune the chosen one for the selected
// band. Antenna/region metadata travels onto the created receiver.
export function BestPicker() {
  const open = useStore((s) => s.bestOpen);
  const setOpen = useStore((s) => s.setBestOpen);
  const addReceiver = useStore((s) => s.addReceiver);

  const [region, setRegion] = useState("Any");
  const [bandIdx, setBandIdx] = useState(4); // default 20m

  const list = useMemo(() => {
    const l = region === "Any" ? KIWI_CATALOG : KIWI_CATALOG.filter((e) => e.region === region);
    return [...l].sort((a, b) => b.snr - a.snr || b.score - a.score);
  }, [region]);

  if (!open) return null;
  const band = BANDS[bandIdx];

  const pick = async (e: KiwiCatalogEntry) => {
    await addReceiver(
      {
        kind: "kiwisdr",
        url: e.url,
        label: e.name,
        freq_hz: band.hz,
        mode: band.mode,
        lane: "voice",
        antenna: e.antenna,
        region: e.region,
      },
      true,
    );
    setOpen(false);
  };

  return (
    <div className="overlay" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()} style={{ width: 540 }}>
        <h2>Best receiver — KiwiSDR catalog</h2>
        <div className="body">
          <div className="cat-filters">
            <div style={{ flex: 1 }}>
              <label className="fld">Region</label>
              <select className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
                {CATALOG_REGIONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="fld">Tune to band</label>
              <select className="input" value={bandIdx} onChange={(e) => setBandIdx(Number(e.target.value))}>
                {BANDS.map((b, i) => (
                  <option key={b.label} value={i}>{b.label} · {(b.hz / 1e6).toFixed(3)} MHz {b.mode.toUpperCase()}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="row" style={{ marginBottom: 10 }}>
            <span className="faint" style={{ fontSize: 11 }}>
              Ranked by reported SNR (dB, higher = clearer) then antenna quality. {list.length} node(s).
            </span>
            <span className="spacer" />
            <button
              className="btn sm primary"
              disabled={!list.length}
              onClick={() => list[0] && pick(list[0])}
            >
              ⚡ Auto-pick best
            </button>
          </div>

          {list.map((e) => (
            <div className="cat-row" key={e.url}>
              <div className="cat-snr">
                {e.snr}
                <span className="u">dB SNR</span>
              </div>
              <div className="main">
                <div className="nm">{e.name}</div>
                <div className="ant">📡 {e.antenna}</div>
                <div className="meta">{e.loc || e.region} · {e.region} · up to {e.users_max} users</div>
              </div>
              <button className="btn sm" onClick={() => pick(e)}>Add &amp; Tune</button>
            </div>
          ))}
        </div>
        <div className="foot">
          <button className="btn" onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>
    </div>
  );
}
