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

    // Reusable scratch: a one-row ImageData and an offscreen back-buffer for
    // scrolling. Kept in sync with the canvas's rendered size by sync() below,
    // which is cheap (only reallocates when the size actually drifts) and runs
    // each frame so it can't desync across a remount/HMR/late layout.
    let row: ImageData | null = null;
    const back = document.createElement("canvas");
    const backCtx = back.getContext("2d", { alpha: false });

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Returns false until the canvas has a real rendered size.
    const sync = (): boolean => {
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (w < 2 || h < 2) return false;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        ctx.fillStyle = "#05070c";
        ctx.fillRect(0, 0, w, h);
      }
      if (back.width !== w || back.height !== h) {
        back.width = w;
        back.height = h;
      }
      if (!row || row.width !== w) row = ctx.createImageData(w, 1);
      return true;
    };
    sync();
    const ro = new ResizeObserver(() => sync());
    ro.observe(canvas);

    const off = spectrumBus.on(id, (bins) => {
      if (!bins.length || !backCtx || !sync() || !row) return;
      const w = canvas.width;
      const h = canvas.height;
      // Scroll existing content down by one row via an offscreen buffer to avoid
      // a self-referential drawImage (which can force a GPU readback).
      backCtx.drawImage(canvas, 0, 0);
      ctx.drawImage(back, 0, 0, w, h - 1, 0, 1, w, h - 1);
      // Paint the newest row at the top.
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
