<p align="center">
  <img src="assets/ham.png" alt="HamHawk" width="320" />
</p>

<h1 align="center">HamHawk — User's Manual</h1>

<p align="center">
  An internet-SDR monitoring workstation styled as an IC-7760-class rig.
  Listen to KiwiSDR / OpenWebRX receivers worldwide, transcribe &amp; translate voice,
  and decode digital modes — with true dual receive.
</p>

> **Core principle:** nothing is faked. Every meter, decoder, and readout shows **real data or nothing at all**. If a panel is blank, there's genuinely no signal — HamHawk never invents one.

---

## Contents

1. [What HamHawk is](#1-what-hamhawk-is)
2. [The rig at a glance](#2-the-rig-at-a-glance)
3. [Quick start](#3-quick-start)
4. [The core idea: the item is the switch](#4-the-core-idea-the-item-is-the-switch)
5. [Dual receive — MAIN & SUB](#5-dual-receive--main--sub)
6. [Left rail controls](#6-left-rail-controls)
7. [Tuning & the right-hand knobs](#7-tuning--the-right-hand-knobs)
8. [Recording](#8-recording)
9. [Scanning](#9-scanning)
10. [The LCD views](#10-the-lcd-views)
11. [Memory channels](#11-memory-channels)
12. [Bands browser](#12-bands-browser)
13. [Adding receivers](#13-adding-receivers)
14. [Decoders & modes](#14-decoders--modes)
15. [Voice: transcription & translation](#15-voice-transcription--translation)
16. [Bookmarks & alerts](#16-bookmarks--alerts)
17. [Settings](#17-settings)
18. [Keyboard shortcuts](#18-keyboard-shortcuts)
19. [Troubleshooting](#19-troubleshooting)
20. [Honesty & limits](#20-honesty--limits)

---

## 1. What HamHawk is

HamHawk connects to **internet-connected software-defined radios** (SDRs) — public KiwiSDR and OpenWebRX nodes — and turns them into a monitoring desk on your Mac. You can:

- Tune HF frequencies and hear live audio.
- Run **several receivers at once** — each decoding, transcribing, plotting, and recording in parallel.
- Hear **two of them simultaneously** in stereo (MAIN left, SUB right), like a flagship dual-receive transceiver.
- Decode **CW, RTTY, PSK31, and FT8** from the real signal.
- **Transcribe and translate** voice with a local Whisper model.

It is a **receive-only monitor**. There is no transmit.

---

## 2. The rig at a glance

The window is laid out like a radio face, in three columns:

```
┌──────────────┬───────────────────────────────────────┬──────────────┐
│  LEFT RAIL   │              CENTER LCD                │  RIGHT KNOBS │
│              │                                        │              │
│  POWER       │  MAIN S-meter    SUB meter / decodes   │  MULTI·STEP  │
│  SCAN ◀DN UP▶│  MAIN freq                             │  MAIN TUNING │
│  SEARCH ⌘K   │  ─────────────────────────────────────│   (REC ⬤)    │
│  ADD   SET   │  Scope / Text / Map / Log / ...        │  AF / VOLUME │
│  BEST RX     │                                        │  SQUELCH     │
│              │  [SCOPE][AF SCOPE][TEXT][MAP]          │  FILTER      │
│  BANDS list  │  [ACTIVITY][LOG][BMARKS][ALERTS]       │  RF GAIN/AGC │
│              │              (soft-keys)               │  MEMORY list │
└──────────────┴───────────────────────────────────────┴──────────────┘
```

- **POWER** is a real on/off toggle: off → starts + listens to the selected station; on → stops all.
- The **SUB cell** (top-right of the LCD) shows the SUB meter when a SUB is assigned, otherwise a live
  **recent-decode ribbon**.
- **FILTER** and **RF GAIN / AGC** (right column) appear for KiwiSDR receivers.

- **Left rail** — the main function buttons and a scrollable **Bands** browser.
- **Center LCD** — twin **MAIN** and **SUB** displays (S-meter + frequency), a large content area that switches between views via the soft-keys along the bottom.
- **Right column** — the tuning knob and audio controls, plus your scrollable **Memory** channel list.

---

## 3. Quick start

1. **Add a receiver** (or use the seeded ones). Click **ADD** → choose **KiwiSDR**, paste a node URL, give it a label/frequency/mode, save. HamHawk also ships with ~20 real public channels in **Memory**.
2. **Click a Memory channel** (right column) or a **Band** (left rail). That single click starts the receiver and you hear it — it becomes **MAIN**. The channel shows an **ON AIR** tag.
3. **Tune** with the big **MAIN TUNING** knob — drag up/down or scroll the wheel. The frequency retunes live (no reconnect).
4. **Adjust** loudness with **AF / VOLUME**; set the scanner threshold with **SQUELCH**.
5. **Click the channel again** to stop it.

To hear a *second* station at the same time, **right-click** another Memory channel — see [Dual receive](#5-dual-receive--main--sub).

---

## 4. The core idea: the item is the switch

There are **no Start / Stop / Listen buttons**. The thing you want to hear *is* the switch:

- **Click** a Memory channel or an HF Band → it starts and you hear it (MAIN).
- **Click it again** → it stops.
- Starting one station does **not** stop the others — they keep running in the background (decoding, transcribing, recording). Clicking only changes **what you hear**.

**POWER** is a master on/off toggle: when idle it powers **on** (starts + listens to the selected, or first, station); when anything is running it powers **off** (stops every receiver at once). The LED and the on/idle label track the state.

---

## 5. Dual receive — MAIN & SUB

HamHawk does **true dual receive**, like an IC-7760: two independent signals at the same time, split across your speakers.

- **MAIN** plays in the **left** channel.
- **SUB** plays in the **right** channel.
- With no SUB assigned, MAIN plays **centered** (mono to both speakers).

**Assign a SUB:**

- **Right-click** any Memory channel → it becomes **SUB** (auto-starting it if it wasn't running). An amber **SUB** tag appears, and the SUB meter goes live.
- **Right-click it again**, or click the **✕** on the SUB cell, → clears SUB.

**The SUB cell adapts:**

- **SUB assigned** → the top-right cell shows a SUB VFO meter (S-meter + frequency + mode/lane + a live **S/N** readout when the signal reports one) with a **✕ clear** button.
- **No SUB** → the same cell shows a **recent-decode ribbon**: the newest digital decodes (callsign · grid · S/N). Click a row to make MAIN listen to the receiver that heard it. The slot is never dead.

**Rules:**

- A channel can't be both MAIN and SUB. Assigning one clears the other.
- **POWER (off)** clears both MAIN and SUB and stops everything.

> Under the hood, *many* receivers can run at once (decode/transcribe/record). MAIN and SUB are simply the two you've chosen to **hear**.

---

## 6. Left rail controls

| Button | What it does |
| --- | --- |
| **POWER** | On/off toggle. Idle → starts + listens to the selected station; running → **stops all**. Lit when on. |
| **SCAN** | Split button: **◀ DN** scans down, **UP ▶** scans up. See [Scanning](#9-scanning). |
| **SEARCH (⌘K)** | Open the command palette to jump to any action or channel. |
| **ADD** | Open the **Add receiver** dialog (KiwiSDR / OpenWebRX / Broadcastify / scanner feed). |
| **SET** | Open **Settings** (color theme, Whisper model + download, recordings folder, ASR workers). |
| **BEST RX** | Auto-pick the best KiwiSDR for a band — a curated catalog ranked by real SNR + antenna + region. See [Best receiver](#65-best-receiver-auto-pick). |
| **BANDS** | A scrollable browser of HF public-service frequencies and reference police bands. |

### 6.5 Best receiver (auto-pick)

**BEST RX** opens a picker of curated **KiwiSDR** nodes pulled from the public registry, ranked by **reported SNR** (higher = clearer) then antenna quality. Choose a **region** and a **band**, then either:

- **⚡ Auto-pick best** — adds & tunes the top-ranked node for that band, or
- **Add & Tune** on any row — each row shows the node's **antenna**, location, region, and SNR.

The chosen node is added to Memory (with its antenna noted) and starts listening on MAIN. KiwiSDRs are wideband HF, so ranking is by signal quality + antenna, not coverage. The catalog is a point-in-time snapshot — public nodes can be busy or offline.

---

## 7. Tuning & the right-hand knobs

- **MAIN TUNING** (large knob) — **drag up/down** or **scroll** to change the MAIN frequency. Tuning is live: it retunes the open connection rather than reconnecting. The readout below shows the current frequency.
- **MULTI · STEP** (small knob) — click to cycle the tuning step: **10 Hz → 100 Hz → 1 kHz → 5 kHz**. Each knob detent / scroll click moves by this amount.
- **REC** (round button on the lower-right of the MAIN TUNING knob) — latches in/out to record MAIN to a WAV file. See [Recording](#8-recording).
- **AF / VOLUME** — playback loudness.
- **SQUELCH** — the dBm threshold the scanner uses to decide a frequency is "busy."
- **FILTER** *(KiwiSDR)* — receiver passband width. Narrow to cut adjacent-channel noise, widen for fidelity. Applied live (no reconnect) and preserved across retunes **and reconnects** (a network drop won't silently revert your filter).
- **RF GAIN / AGC** *(KiwiSDR)* — leftmost = **AGC** (automatic); raise for manual RF gain. The **AGC** button snaps back to automatic. Also re-applied on every reconnect.

Feeds (scanner streams) aren't tunable, and FILTER / RF GAIN apply only to KiwiSDR VFOs.

---

## 8. Recording

The **round REC button** sits on the lower-right face of the MAIN TUNING knob.

- Click it to **start** recording the MAIN receiver to a **WAV** file — the button presses in and glows red.
- Click again to **stop** — the file is finalized.
- Recordings are written to the folder set in **Settings → Recordings folder** (a sensible default is used if you don't set one). Use **Reveal** in Settings to open it.

---

## 9. Scanning

A **squelch-based band scanner** sweeps the MAIN VFO looking for activity.

- **◀ DN** sweeps **down**, **UP ▶** sweeps **up** — ±100 kHz around the starting frequency, in 1 kHz steps.
- It **stops automatically** when the S-meter rises above your **SQUELCH** threshold (i.e. it finds a signal).
- Press the same direction again, or any channel/band, to stop scanning.
- The SCAN button shows **SCANNING** and lights the active direction while it runs.

Scanning needs a **tunable SDR** VFO — it doesn't apply to scanner feeds.

---

## 10. The LCD views

The soft-keys along the bottom of the LCD switch the center display:

| Soft-key | Shows |
| --- | --- |
| **SCOPE** | Spectrum + waterfall for MAIN (and SUB, if assigned). |
| **AF SCOPE** | Audio-scope: live waveform + 0–6 kHz audio spectrum of what you're hearing. |
| **TEXT** | Live transcripts / decoded text for the MAIN receiver. |
| **MAP** | World map plotting decoded Maidenhead grid locators. |
| **ACTIVITY** | Recent digital-decode activity. |
| **LOG** | Logbook of decodes/transcripts (callsign · grid · mode · S/N), with **Export ADIF** / **Export CSV**. |
| **BMARKS** | Saved bookmarks. |
| **ALERTS** | Keyword alert rules and hits. |

Only on-screen waterfalls compute their FFT, so off-screen receivers don't waste CPU on spectrum. The spectrum trace and waterfall keep headroom above strong signals, so peaks show their shape instead of clipping flat at the top.

**Exporting your log:** in **LOG**, **Export ADIF** writes an `.adi` (with parsed CALL / GRIDSQUARE / BAND, digital lane only) and **Export CSV** writes everything (time, station, freq, mode, S/N, callsign, grid, text) to `~/.hamhawk/exports/`. The file opens after export. Callsign/grid are best-effort parses of decoded text — useful for a glance, not authoritative.

---

## 11. Memory channels

The **Memory** list lives in the right column and is scrollable.

- **Click** a channel → listen on **MAIN** (ON AIR tag).
- **Right-click** a channel → assign as **SUB** (amber SUB tag).
- **★ star** → mark a **favorite**; favorites sort to the top of the list for quick access. Click again to unstar.
- **Antenna line** → channels that carry an antenna description (anything added via **BEST RX**, or with the antenna field filled in **ADD**) show it under the name (📡), so you can pick a station by its antenna.
- **✎ (pencil)** → open the **Edit** dialog to fine-tune label, frequency, mode, and lane. Changes save immediately; if the channel is running it restarts. Your star and antenna are preserved across edits.
- The colored dot shows session state (stopped / connecting / running). A struggling receiver shows a reason line under the MAIN/SUB name (⟳ reconnecting / ✕ error) that persists until it recovers.

HamHawk ships seeded with ~20 real public channels (VOLMET aviation weather, time stations, shortwave, etc.).

---

## 12. Bands browser

The **BANDS** list (left rail) has two groups:

- **Public Service · HF** — genuinely receivable on the KiwiSDR nodes HamHawk uses. Clicking one **applies that frequency/mode to the active VFO and tunes it live**. Includes WWV (time), Coast Guard distress, Marine HF, Hurricane Net, Aero (NAT/oceanic), VOLMET, CB emergency/highway channels, ham emcomm, and SHARES/MARS.
- **Police · VHF / UHF / P25** — **reference only**. US municipal police runs on VHF/UHF/700/800 MHz, mostly **P25 digital and often encrypted**. These frequencies **cannot** be received on an HF SDR node, so they're listed for reference and flagged as non-tunable. To get that audio you'd add a **scanner-feed** source (e.g. a Broadcastify/stream URL).

---

## 13. Adding receivers

**ADD** opens the dialog. Choose a **kind**:

- **KiwiSDR** — paste a node URL (host:port). Live-verified path; supports live tuning and the full decode/voice pipeline.
- **OpenWebRX** — protocol ported from the official client (experimental).
- **Broadcastify (scanner)** — paste a feed ID or listen-link; HamHawk resolves it to the free public stream.
- **Scanner feed** — any audio **stream URL** (MP3/AAC). Plays and records, but is **not tunable** (it's a fixed stream, not an SDR).

Set a **label**, optional **antenna** (shown in Memory so you can pick by antenna), **frequency**, **mode** (AM / USB / LSB / etc.), and **lane**:

- **Voice** — routes audio to the Whisper transcription/translation engine.
- **Digital** — routes audio to the CW/RTTY/PSK31/FT8 decoders. (Digital modes are demodulated as USB under the hood and fed to the decoder.)

---

## 14. Decoders & modes

All decoders work on the **real** received audio. They emit text only when they actually decode something.

| Mode | Engine |
| --- | --- |
| **CW (Morse)** | Goertzel tone detection → Morse timing → text. |
| **RTTY** | Baudot/ITA2 FSK demodulation. |
| **PSK31** | BPSK demodulation + varicode decode. |
| **FT8** | Vendored [`ft8_lib`](https://github.com/kgoba/ft8_lib) (MIT) over FFI — real decode, including grid locators plotted on the MAP. |

> FT4 and the OpenWebRX path are **experimental**. The KiwiSDR voice path and the HF digital decoders are verified.

---

## 15. Voice: transcription & translation

The **Voice** lane uses a **local** Whisper model (`whisper.cpp`) — nothing is sent to the cloud:

- **Transcribe** speech to text (shown in the **TEXT** view and searchable).
- **Translate** non-English speech to English.
- **Language ID**.

Place a ggml model at **`~/.hamhawk/models/ggml-base.bin`**, or point to one in **Settings**. Without a model, **audio and waterfall still work** — only transcription is disabled.

A single shared Whisper context serves **all** receivers; the number of worker threads is set in Settings.

---

## 16. Bookmarks & alerts

- **Bookmarks (BMARKS)** — save a running VFO's frequency/mode for one-click recall later.
- **Alerts (ALERTS)** — define **keyword rules**; when a transcript matches, you get a toast and the hit is logged in the Alerts view.

---

## 17. Settings

Open with **SET**:

- **Accessibility — color theme** — choose **Default** or a colorblind-safe palette (Deuteranopia / Protanopia / Tritanopia) or **High contrast**. Applies instantly and is remembered. **Larger controls** bumps button/slider sizes.
- **Whisper model** — a status row shows **Ready / Not installed**. **Download base model** fetches `ggml-base.en` into `~/.hamhawk/models/` with a progress bar, or **Choose…** points to a model file you already have. The path is also editable directly.
- **ASR worker count** — Whisper decode threads (trade speed vs. CPU).
- **Recordings folder** — where WAV files are written. **Choose** picks a folder; **Reveal** opens the current one in Finder.

---

## 18. Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| **⌘K** | Open the command palette (SEARCH). |

The palette is the fastest way to jump to a channel or run an action without hunting through the UI.

---

## 19. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| **No audio when I click a channel** | Check **AF / VOLUME** isn't at zero and **POWER** is on. Confirm the channel reached *running* (green dot). Public nodes can be full/offline — try another, or use **BEST RX**. |
| **It "sounds like multiple stations"** | Only MAIN + SUB are ever audible. If you're on an FT8 sub-band (e.g. 14.074), that one frequency carries *dozens* of simultaneous signals — that's the band, not multiple channels. Switch MAIN to a voice channel for a single voice. |
| **Meter says "no meter"** | OpenWebRX / scanner-feed sources don't report a signal level, so the S-meter shows "no meter" rather than a fake zero. Audio/decode still work. |
| **A receiver shows a reason under its name** | ⟳ = reconnecting (transient — public nodes are busy/time-limited); ✕ = a permanent error (e.g. auth) and it has stopped retrying. The reason persists until it recovers or you restart it. |
| **SUB cell shows "RECENT DECODES"** | That's the no-SUB state — it lists recent digital decodes. **Right-click** a Memory channel to assign a SUB and the cell becomes the SUB meter. |
| **No transcripts** | No Whisper model. Open **Settings** → **Download base model**, or **Choose…** an existing `ggml` file. Audio / waterfall / digital decode still work without it. |
| **Recording stopped on its own** | A toast reports a write failure (disk full / folder removed) — HamHawk stops + finalizes rather than silently truncating. A startup toast also flags recordings a crash left incomplete. |
| **Police bands won't tune** | They're **reference only** — HF SDR nodes can't receive VHF/UHF/P25. Add a scanner-feed source instead. |
| **A scanner feed won't tune** | Feeds are fixed streams, not SDRs — tuning/scan don't apply. |
| **Scan won't start** | Scanning needs a tunable SDR VFO selected as MAIN (not a feed). |
| **A node keeps reconnecting** | Public KiwiSDR nodes limit concurrent users and time slots; it may be full. HamHawk caps itself at 8 concurrent sessions. |

---

## 20. Honesty & limits

HamHawk is built on one rule: **it never fabricates data.**

- Meters move only from real S-meter telemetry; a source that reports no level shows **"no meter"**, never a fake zero.
- **S/N** is shown only when the signal actually reports it — otherwise it's hidden, not zeroed.
- Decoders print only what they actually decode.
- **"Live"** means audio/data is genuinely flowing; a struggling link shows its real reason.
- Blank panels mean *no signal*, not *broken* — that distinction is intentional.

**Limits:**

- **Receive only** — no transmit.
- Depends on **public SDR nodes**, which can be busy, rate-limited, or offline.
- **HF only** for live tuning; VHF/UHF/P25 (real police/public-safety) is **not** receivable on HF nodes — use a scanner feed.
- **FT4 / OpenWebRX** are experimental.

---

<p align="center"><i>73 — happy monitoring.</i></p>
