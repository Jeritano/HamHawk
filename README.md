<p align="center">
  <img src="assets/ham.png" alt="HamHawk" width="360" />
</p>

<h1 align="center">HamHawk</h1>

<p align="center">
  An internet-SDR monitoring workstation — listen to KiwiSDR / OpenWebRX receivers worldwide,
  transcribe &amp; translate voice, decode digital modes, all in an IC-7760-style rig interface.
</p>

---

## What it does

- **Rig-style desktop UI** (Tauri 2 + React + Rust): analog MAIN S-meter, spectrum + waterfall
  scopes, a working tuning knob (live retune, no reconnect), **POWER on/off**, squelch band scanner,
  and soft-key LCD views (scope / AF scope / text / map / activity / **log** / bookmarks / alerts).
- **Sources:** KiwiSDR (live, verified), OpenWebRX (ported), and scanner-feed stream URLs (incl. Broadcastify).
- **Voice lane:** local Whisper (`whisper.cpp`) — transcription, translate-to-English, language ID.
- **Digital lane:** real decoders — CW (Goertzel/Morse), RTTY (Baudot FSK), PSK31 (BPSK + varicode),
  and **FT8** via the vendored [`ft8_lib`](https://github.com/kgoba/ft8_lib) (MIT) over FFI. Digital
  modes are demodulated as USB and fed to the decoders, so FT8/FT4/PSK/RTTY decode over any SDR source.
- **True dual receive:** MAIN (left) + SUB (right) in stereo. The SUB cell shows the SUB meter when
  assigned, or a **live recent-decode ribbon** (callsign · grid · S/N, click to listen) when not.
- **Best-RX auto-pick:** a curated KiwiSDR catalog ranked by **real SNR + antenna + region** — one
  click adds & tunes the best node for a band.
- **Per-band controls:** filter bandwidth + RF gain / AGC (KiwiSDR), live, no reconnect.
- **Logbook + export:** decodes/transcripts to **ADIF** (callsign/grid/band) and **CSV**.
- **Accessibility:** colorblind-safe palettes + a larger-controls option.
- **Plus:** favorites (star, sorts to top), antenna-aware memory, WAV recording, bookmarks, keyword
  alerts, a world map of decoded grids, a ⌘K command palette, and a scrollable band browser.

> Nothing is faked — every decoder and meter shows real data or nothing at all. Sources that report no
> signal level show "no meter" rather than a fake zero; SNR appears only when it's real. Filter / RF-gain
> settings survive a network drop (the snapshot is re-applied on every reconnect).

## Design system

The chassis is built on a small set of tokens so the geometry stays cohesive:

- **Spacing rhythm** — `--sp-xs/sm/md/lg/xl` (4 / 8 / 12 / 16 / 24 px)
- **Radii** — `--radius-sm/md/lg/xl` (6 / 8 / 12 / 16 px)
- **Elevation** — `--depth-rest/hover/active/glow-teal/bevel-inset/modal` shadow tokens
- **Motion** — one easing curve (`--ease-out`) + `--t-fast/base/modal` durations
- **Numerics** — every digit/freq/meter/clock uses `font-variant-numeric: tabular-nums` so the readout doesn't shift on tune
- **Focus** — `:focus-visible` rings on every interactive element (a11y); `prefers-reduced-motion` honored

📖 **[User's Manual](USER_MANUAL.md)** — full guide to the rig: dual receive, tuning, scanning, decoders, recording, and more.

## Build & run

```bash
npm install
cargo tauri dev      # or: npm run tauri dev
```

Voice transcription needs a ggml Whisper model at `~/.hamhawk/models/ggml-base.bin`. Open
**Settings** to see model status and **download** the base model (or pick your own file). Without a
model, audio + waterfall + digital decode still work; only voice transcription is disabled.

## Stack

Tauri 2 · React + TypeScript (Vite) · Rust core (Tokio, rusqlite, rustfft, rubato, whisper-rs) ·
vendored `ft8_lib` (C, FFI).

## Notes

- US municipal police (VHF/UHF/700/800 MHz, mostly P25 digital & often encrypted) is **not** receivable
  on HF SDR nodes; the in-app Police band entries are reference-only. A scanner-feed source is the path
  to that audio.
- FT4 and the OpenWebRX path are experimental; the KiwiSDR voice + HF digital paths are verified.
- The Best-RX catalog is a point-in-time snapshot of the public KiwiSDR registry; public nodes can be
  busy or offline.
