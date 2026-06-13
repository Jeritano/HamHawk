import { useEffect, useRef } from "react";
import { spectrumBus } from "../lib/bus";

/** Live spectrum trace (filled blue line) for one receiver — the top half of the
 *  scope, above the waterfall. Renders straight to canvas, off the React path. */
export function SpectrumTrace({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width));
      canvas.height = Math.max(1, Math.floor(r.height));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const off = spectrumBus.on(id, (bins) => {
      const w = canvas.width;
      const h = canvas.height;
      if (w < 2 || h < 2 || !bins.length) return;
      ctx.fillStyle = "#02100c";
      ctx.fillRect(0, 0, w, h);
      // faint grid
      ctx.strokeStyle = "#0c2a22";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = (h * i) / 4;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      // trace
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x < w; x++) {
        const v = bins[Math.floor((x / w) * bins.length)] | 0;
        const y = h - (v / 255) * h * 0.92;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = "rgba(42,168,255,.18)";
      ctx.fill();
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const v = bins[Math.floor((x / w) * bins.length)] | 0;
        const y = h - (v / 255) * h * 0.92;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#2aa8ff";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    });
    return () => {
      off();
      ro.disconnect();
    };
  }, [id]);
  return <canvas ref={ref} className="trace" />;
}
