import { useEffect, useRef } from "react";
import { telemetryBus } from "../lib/bus";

const CX = 110;
const CY = 104;
const R = 80;

function frac(dbm: number) {
  return Math.min(1, Math.max(0, (dbm + 121) / 108));
}
function angFor(f: number) {
  return -52 + f * 104; // degrees; 0 = straight up
}
function pt(f: number, rad: number): [number, number] {
  const ang = (angFor(f) * Math.PI) / 180;
  return [CX + Math.sin(ang) * rad, CY - Math.cos(ang) * rad];
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

/** Analog S-meter with ballistic (damped) needle animated via rAF — no React
 *  re-render per telemetry tick. `kind` is used only to show "no meter" for
 *  sources that never report a signal level (OpenWebRX / scanner feeds) instead
 *  of a static "-- dBm" that looks like a real-but-zero reading. */
export function SMeterArc({ id, label, kind }: { id: string; label: string; kind?: string }) {
  const hasMeter = kind === undefined || kind === "kiwisdr";
  const needle = useRef<SVGGElement>(null);
  const dbmText = useRef<SVGTextElement>(null);
  const target = useRef(angFor(0));
  const cur = useRef(angFor(0));

  useEffect(() => {
    const off = telemetryBus.on(id, (t) => {
      if (t.s_meter_dbm != null) {
        target.current = angFor(frac(t.s_meter_dbm));
        if (dbmText.current) dbmText.current.textContent = `${t.s_meter_dbm.toFixed(0)} dBm`;
      }
    });
    let raf = 0;
    const loop = () => {
      cur.current += (target.current - cur.current) * 0.16; // ballistic damping
      if (needle.current) needle.current.setAttribute("transform", `rotate(${cur.current.toFixed(2)} ${CX} ${CY})`);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [id]);

  const gid = `glass-${id}`;
  return (
    <div className="meter">
      <svg viewBox="0 0 220 120">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="0.45" stopColor="#ffffff" stopOpacity="0.05" />
            <stop offset="1" stopColor="#000000" stopOpacity="0.1" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="216" height="116" rx="7" fill="#f3efe2" />
        <path d={arc(0, 0.444, R)} fill="none" stroke="#1a1a1a" strokeWidth="2.4" />
        <path d={arc(0.444, 1, R)} fill="none" stroke="#d12b2b" strokeWidth="2.8" />
        {TICKS.map(([t, fr]) => {
          const [ax, ay] = pt(fr, R);
          const [bx, by] = pt(fr, R - 9);
          const [lx, ly] = pt(fr, R + 13);
          const red = fr > 0.444;
          return (
            <g key={t}>
              <line x1={ax} y1={ay} x2={bx} y2={by} stroke={red ? "#d12b2b" : "#1a1a1a"} strokeWidth="1.6" />
              <text x={lx} y={ly + 3} fontSize="10" fontFamily="var(--mono)" textAnchor="middle" fill={red ? "#d12b2b" : "#222"}>
                {t}
              </text>
            </g>
          );
        })}
        <g ref={needle} transform={`rotate(${angFor(0)} ${CX} ${CY})`}>
          <line x1={CX} y1={CY} x2={CX} y2={CY - (R - 8)} stroke="#d12b2b" strokeWidth="2" strokeLinecap="round" />
        </g>
        <circle cx={CX} cy={CY} r="4.5" fill="#222" />
        <text x="12" y="18" fontSize="11" fill="#444" fontFamily="var(--mono)" fontWeight="700">{label}</text>
        <text ref={dbmText} x="208" y="18" fontSize="11" fill="#444" fontFamily="var(--mono)" textAnchor="end">
          {hasMeter ? "-- dBm" : "no meter"}
        </text>
        {/* glass sheen */}
        <rect x="2" y="2" width="216" height="64" rx="7" fill={`url(#${gid})`} pointerEvents="none" />
      </svg>
    </div>
  );
}
