import { useEffect, useRef } from "react";
import { spectrumBus } from "../lib/bus";

/** Live spectrum trace (filled blue line + peak-hold) for one receiver — the top
 *  half of the scope. Renders straight to canvas (DPR-crisp), off the React path. */
export function SpectrumTrace({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    let w = 1;
    let h = 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, Math.floor(r.width * dpr));
      h = Math.max(1, Math.floor(r.height * dpr));
      canvas.width = w;
      canvas.height = h;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let peaks: Float32Array | null = null;

    const off = spectrumBus.on(id, (bins) => {
      if (w < 2 || h < 2 || !bins.length) return;
      const n = bins.length;
      if (!peaks || peaks.length !== n) peaks = new Float32Array(n);

      ctx.fillStyle = "#02100c";
      ctx.fillRect(0, 0, w, h);

      // grid
      ctx.strokeStyle = "#0c2a22";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = (h * i) / 4;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      for (let i = 1; i < 8; i++) {
        const x = (w * i) / 8;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      const yOf = (v: number) => h - (v / 255) * h * 0.92;

      // peak-hold (decay)
      for (let i = 0; i < n; i++) {
        const v = bins[i] | 0;
        peaks[i] = Math.max(v, peaks[i] * 0.97);
      }
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const v = peaks[Math.floor((x / w) * n)];
        const y = yOf(v);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "rgba(120,190,255,.4)";
      ctx.lineWidth = dpr;
      ctx.stroke();

      // filled live trace
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x < w; x++) {
        ctx.lineTo(x, yOf(bins[Math.floor((x / w) * n)] | 0));
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = "rgba(42,168,255,.18)";
      ctx.fill();
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const y = yOf(bins[Math.floor((x / w) * n)] | 0);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#2aa8ff";
      ctx.lineWidth = 1.3 * dpr;
      ctx.stroke();

      // center (tuned) marker
      ctx.strokeStyle = "rgba(255,90,90,.55)";
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();
    });
    return () => {
      off();
      ro.disconnect();
    };
  }, [id]);
  return <canvas ref={ref} className="trace" />;
}
