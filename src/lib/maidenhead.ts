// Maidenhead grid locator -> [lat, lon] (square center), plus helpers to pull
// grids/callsigns out of decoded digital text.

export function gridToLatLon(grid: string): [number, number] | null {
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;
  const A = "A".charCodeAt(0);
  let lon = (g.charCodeAt(0) - A) * 20 - 180;
  let lat = (g.charCodeAt(1) - A) * 10 - 90;
  lon += parseInt(g[2], 10) * 2;
  lat += parseInt(g[3], 10) * 1;
  if (g.length >= 6) {
    lon += (g.charCodeAt(4) - A) * (2 / 24) + (2 / 24) / 2;
    lat += (g.charCodeAt(5) - A) * (1 / 24) + (1 / 24) / 2;
  } else {
    lon += 1; // center of 2deg cell
    lat += 0.5; // center of 1deg cell
  }
  return [lat, lon];
}

/** Find a Maidenhead grid token in a decoded message, if any. */
export function extractGrid(text: string): string | null {
  for (const tok of text.split(/\s+/)) {
    if (/^[A-R]{2}[0-9]{2}([a-x]{2})?$/i.test(tok)) return tok;
  }
  return null;
}

/** Pull plausible callsigns out of a decoded message. */
export function extractCallsigns(text: string): string[] {
  const out: string[] = [];
  for (const tok of text.split(/\s+/)) {
    const t = tok.replace(/[<>]/g, "");
    if (/^[A-Z0-9]{1,3}\d[A-Z0-9]*[A-Z]$/i.test(t) && /\d/.test(t) && t.length >= 3) {
      out.push(t.toUpperCase());
    }
  }
  return out;
}
