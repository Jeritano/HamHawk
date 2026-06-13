import { useEffect, useState } from "react";
import { telemetryBus } from "../lib/bus";

// Maps dBm to 0..1 across an S-meter scale (S1≈-121dBm … S9≈-73 … +60 over S9≈-13).
function frac(dbm: number) {
  return Math.min(1, Math.max(0, (dbm + 121) / 108));
}
function pt(f: number, rad: number): [number, number] {
  const ang = ((-52 + f * 104) * Math.PI) / 180;
  return [100 + Math.sin(ang) * rad, 86 - Math.cos(ang) * rad];
}
function arc(f0: number, f1: number, rad: number) {
  const [x0, y0] = pt(f0, rad);
  const [x1, y1] = pt(f1, rad);
  return `M ${x0} ${y0} A ${rad} ${rad} 0 0 1 ${x1} ${y1}`;
}

const TICKS: [string, number][] = [
  ["1", 0], ["3", 0.111], ["5", 0.222], ["7", 0.333], ["9", 0.444],
  ["+20", 0.63], ["+40", 0.815], ["+60", 1],
];

/** Analog S-meter (IC-7760 style), needle driven by the telemetry bus. */
export function SMeterArc({ id, label }: { id: string; label: string }) {
  const [dbm, setDbm] = useState<number | undefined>();
  useEffect(() => telemetryBus.on(id, (t) => setDbm(t.s_meter_dbm)), [id]);
  const f = dbm == null ? 0 : frac(dbm);
  const [nx, ny] = pt(f, 60);

  return (
    <div className="meter">
      <svg viewBox="0 0 200 96">
        {/* face */}
        <rect x="2" y="2" width="196" height="92" rx="6" fill="#f3efe2" />
        {/* scale arcs */}
        <path d={arc(0, 0.444, 70)} fill="none" stroke="#1a1a1a" strokeWidth="2" />
        <path d={arc(0.444, 1, 70)} fill="none" stroke="#d12b2b" strokeWidth="2.4" />
        {/* ticks + labels */}
        {TICKS.map(([t, fr]) => {
          const [ax, ay] = pt(fr, 70);
          const [bx, by] = pt(fr, 62);
          const [lx, ly] = pt(fr, 53);
          const red = fr > 0.444;
          return (
            <g key={t}>
              <line x1={ax} y1={ay} x2={bx} y2={by} stroke={red ? "#d12b2b" : "#1a1a1a"} strokeWidth="1.4" />
              <text x={lx} y={ly + 3} fontSize="8" fontFamily="var(--mono)" textAnchor="middle" fill={red ? "#d12b2b" : "#222"}>
                {t}
              </text>
            </g>
          );
        })}
        <text x="100" y="40" fontSize="8" textAnchor="middle" fill="#666" fontFamily="var(--mono)">
          S-METER
        </text>
        {/* needle */}
        <line x1="100" y1="86" x2={nx} y2={ny} stroke="#d12b2b" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="100" cy="86" r="3.5" fill="#222" />
        {/* readout */}
        <text x="10" y="14" fontSize="9" fill="#444" fontFamily="var(--mono)" fontWeight="700">{label}</text>
        <text x="190" y="14" fontSize="9" fill="#444" fontFamily="var(--mono)" textAnchor="end">
          {dbm == null ? "-- dBm" : `${dbm.toFixed(0)} dBm`}
        </text>
      </svg>
    </div>
  );
}
