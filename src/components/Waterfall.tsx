import { useEffect, useRef } from "react";
import { spectrumBus } from "../lib/bus";
import { COLORMAP } from "../lib/colormap";

/** Scrolling waterfall fed by the spectrum bus for one receiver. Renders on the
 *  canvas directly — never through React state — so it stays smooth. */
export function Waterfall({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));
      if (w !== canvas.width || h !== canvas.height) {
        canvas.width = w;
        canvas.height = h;
        ctx.fillStyle = "#05070c";
        ctx.fillRect(0, 0, w, h);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const off = spectrumBus.on(id, (bins) => {
      const w = canvas.width;
      const h = canvas.height;
      if (w < 2 || h < 2 || !bins.length) return;
      // Scroll existing content down by one row.
      ctx.drawImage(canvas, 0, 0, w, h - 1, 0, 1, w, h - 1);
      // Paint the newest row at the top.
      const row = ctx.createImageData(w, 1);
      for (let x = 0; x < w; x++) {
        const v = bins[Math.floor((x / w) * bins.length)] | 0;
        const c = v * 3;
        const o = x * 4;
        row.data[o] = COLORMAP[c];
        row.data[o + 1] = COLORMAP[c + 1];
        row.data[o + 2] = COLORMAP[c + 2];
        row.data[o + 3] = 255;
      }
      ctx.putImageData(row, 0, 0);
    });

    return () => {
      off();
      ro.disconnect();
    };
  }, [id]);

  return <canvas ref={ref} className="wf-canvas" />;
}
