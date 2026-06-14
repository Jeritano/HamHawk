import { useEffect, useState } from "react";
import { COUNTRIES } from "../lib/worldcountries";

export interface MapPoint {
  lat: number;
  lon: number;
  label: string;
}

const W = 360;
const H = 180;

function proj(lat: number, lon: number): [number, number] {
  return [((lon + 180) / 360) * W, ((90 - lat) / 180) * H];
}

// One SVG path for all country outlines (fill = land, stroke = borders).
const LAND_PATH = COUNTRIES.map((ring) => {
  const pts = ring.map(([lon, lat]) => `${(lon + 180).toFixed(1)},${(90 - lat).toFixed(1)}`);
  return "M" + pts[0] + "L" + pts.slice(1).join(" ") + "Z";
}).join("");

const CONTINENTS: { lat: number; lon: number; name: string }[] = [
  { lat: 48, lon: -100, name: "N. AMERICA" },
  { lat: -12, lon: -58, name: "S. AMERICA" },
  { lat: 52, lon: 18, name: "EUROPE" },
  { lat: 3, lon: 22, name: "AFRICA" },
  { lat: 46, lon: 92, name: "ASIA" },
  { lat: -25, lon: 134, name: "OCEANIA" },
  { lat: -82, lon: 0, name: "ANTARCTICA" },
];

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((cur - start) / 86_400_000);
}

// Night-side polygon for an equirectangular map. The terminator is the great
// circle 90° from the subsolar point; the dark hemisphere wraps the winter pole.
function terminatorPath(now: Date): string {
  const decl = (-23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear(now) + 10)) * Math.PI) / 180;
  if (Math.abs(decl) < 1e-4) return ""; // equinox — terminator is meridional; skip shading
  const utc = now.getUTCHours() + now.getUTCMinutes() / 60;
  const sunLon = 15 * (12 - utc); // subsolar longitude
  const pts: string[] = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const h = ((lon - sunLon) * Math.PI) / 180;
    const lat = (Math.atan(-Math.cos(h) / Math.tan(decl)) * 180) / Math.PI;
    const [x, y] = proj(lat, lon);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const d = "M" + pts.join("L");
  // decl>0 (N. summer): south polar region is in night → close to the bottom edge.
  return decl >= 0 ? d + `L${W},${H}L0,${H}Z` : d + `L${W},0L0,0Z`;
}

/** Offline equirectangular map: land + country borders, continent labels, a live
 *  day/night terminator, and plotted points (no external tiles). */
export function WorldMap({ points }: { points: MapPoint[] }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000); // advance the terminator
    return () => clearInterval(id);
  }, []);
  const night = terminatorPath(new Date());

  const lons = [];
  for (let l = -180; l <= 180; l += 30) lons.push(l);
  const lats = [];
  for (let l = -90; l <= 90; l += 30) lats.push(l);

  return (
    <div className="map">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="ocean" cx="55%" cy="35%" r="80%">
            <stop offset="0%" stopColor="#0d1830" />
            <stop offset="100%" stopColor="#070b14" />
          </radialGradient>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect x="0" y="0" width={W} height={H} fill="url(#ocean)" />
        <path d={LAND_PATH} fill="#1f4a3c" stroke="#4a8a73" strokeWidth={0.3} strokeLinejoin="round" />
        {lons.map((l) => {
          const [x] = proj(0, l);
          return <line key={"x" + l} className="grat" x1={x} y1={0} x2={x} y2={H} />;
        })}
        {lats.map((l) => {
          const [, y] = proj(l, 0);
          return <line key={"y" + l} className="grat" x1={0} y1={y} x2={W} y2={y} />;
        })}
        <line className="grat" x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="#1b2740" strokeWidth={0.7} />
        {night && <path d={night} fill="#040810" fillOpacity={0.5} pointerEvents="none" />}
        {CONTINENTS.map((c) => {
          const [x, y] = proj(c.lat, c.lon);
          return (
            <text
              key={c.name}
              x={x}
              y={y}
              fontSize={3.4}
              fill="#74a596"
              fillOpacity={0.7}
              textAnchor="middle"
              style={{ pointerEvents: "none", fontFamily: "var(--mono, monospace)", letterSpacing: "0.3px" }}
            >
              {c.name}
            </text>
          );
        })}
        {points.map((p, i) => {
          const [x, y] = proj(p.lat, p.lon);
          return (
            <g key={i} filter="url(#glow)">
              <circle cx={x} cy={y} r={1.7} fill="#20d6c5">
                <title>{p.label}</title>
              </circle>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
