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

/** Offline equirectangular map: graticule + plotted points (no external tiles). */
export function WorldMap({ points }: { points: MapPoint[] }) {
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
        {lons.map((l) => {
          const [x] = proj(0, l);
          return <line key={"x" + l} className="grat" x1={x} y1={0} x2={x} y2={H} />;
        })}
        {lats.map((l) => {
          const [, y] = proj(l, 0);
          return <line key={"y" + l} className="grat" x1={0} y1={y} x2={W} y2={y} />;
        })}
        {/* equator + prime meridian emphasis */}
        <line className="grat" x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="#1b2740" strokeWidth={0.7} />
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
