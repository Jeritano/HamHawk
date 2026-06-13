// Waterfall colormap: a 256-entry LUT going black -> deep blue -> cyan -> green
// -> yellow -> red -> white. Returns packed [r,g,b] triples in a flat array.

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

const STOPS: [number, [number, number, number]][] = [
  [0.0, [4, 6, 16]],
  [0.18, [16, 28, 92]],
  [0.38, [20, 120, 180]],
  [0.55, [24, 200, 170]],
  [0.7, [120, 220, 70]],
  [0.84, [250, 200, 40]],
  [0.93, [250, 90, 50]],
  [1.0, [255, 240, 230]],
];

export const COLORMAP: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s = 0;
    while (s < STOPS.length - 2 && t > STOPS[s + 1][0]) s++;
    const [t0, c0] = STOPS[s];
    const [t1, c1] = STOPS[s + 1];
    const f = (t - t0) / (t1 - t0 || 1);
    lut[i * 3] = lerp(c0[0], c1[0], f);
    lut[i * 3 + 1] = lerp(c0[1], c1[1], f);
    lut[i * 3 + 2] = lerp(c0[2], c1[2], f);
  }
  return lut;
})();
