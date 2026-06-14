import { useEffect, useRef } from "react";
import { audioPlayer } from "../lib/audioPlayer";

/** Audio Scope + Spectrum Analyzer (Spectran / G313-ADS style). Reads the
 *  passive analyser tap off the audio master and draws, in real time:
 *   - top half:  the demodulated-audio waveform (time domain, oscilloscope)
 *   - bottom half: its spectrum (frequency domain, ~0–6 kHz of the AF)
 *  Pure read-only display — it never touches the audio output path. */
export function AudioScope() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let raf = 0;
    let time: Float32Array<ArrayBuffer> | null = null;
    let freq: Uint8Array<ArrayBuffer> | null = null;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.fillStyle = "#02100c";
      ctx.fillRect(0, 0, w, h);
      const mid = Math.floor(h * 0.5);

      // grid + divider
      ctx.strokeStyle = "#0c2a22";
      ctx.lineWidth = 1;
      for (let i = 1; i < 8; i++) {
        const x = (w * i) / 8;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.strokeStyle = "#10463a";
      ctx.stroke();

      const an = audioPlayer.getAnalyser();
      if (!an) {
        ctx.fillStyle = "#2a6";
        ctx.font = `${12 * dpr}px ui-monospace, monospace`;
        ctx.fillText("no audio — start a channel", 10 * dpr, mid);
        return;
      }
      if (!time || time.length !== an.fftSize) time = new Float32Array(an.fftSize);
      if (!freq || freq.length !== an.frequencyBinCount) freq = new Uint8Array(an.frequencyBinCount);

      // --- top: waveform (oscilloscope) ---
      an.getFloatTimeDomainData(time);
      ctx.beginPath();
      const n = time.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const y = mid * 0.5 + (-time[i] * mid * 0.45);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#2aa8ff";
      ctx.lineWidth = 1.2 * dpr;
      ctx.stroke();

      // --- bottom: spectrum (only the lower ~6 kHz of the AF is interesting) ---
      an.getByteFrequencyData(freq);
      // analyser covers 0..sampleRate/2; show 0..6 kHz.
      const rate = an.context.sampleRate;
      const maxHz = 6000;
      const bins = Math.max(1, Math.min(freq.length, Math.floor((maxHz / (rate / 2)) * freq.length)));
      const base = h - 2;
      const span = h - mid - 2;
      ctx.beginPath();
      ctx.moveTo(0, base);
      for (let x = 0; x < w; x++) {
        const i = Math.floor((x / w) * bins);
        const v = freq[i] / 255;
        ctx.lineTo(x, base - v * span);
      }
      ctx.lineTo(w, base);
      ctx.closePath();
      ctx.fillStyle = "rgba(42,168,255,.16)";
      ctx.fill();
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const i = Math.floor((x / w) * bins);
        const v = freq[i] / 255;
        const y = base - v * span;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#2aa8ff";
      ctx.lineWidth = 1.2 * dpr;
      ctx.stroke();

      // labels
      ctx.fillStyle = "#3fb6a0";
      ctx.font = `${9 * dpr}px ui-monospace, monospace`;
      ctx.fillText("WAVEFORM", 6 * dpr, 12 * dpr);
      ctx.fillText("AUDIO SPECTRUM  0–6 kHz", 6 * dpr, mid + 12 * dpr);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className="afscope-canvas" />;
}
