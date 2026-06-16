# HamScope — Engineering Design Document

> **Audience:** an autonomous coding model (e.g. Claude Code) that will implement this project.
> **Working name:** HamScope (rename freely; it is referenced only as the repo/app id `hamscope`).
> **Goal of this doc:** be precise and unambiguous enough that the implementer can build phase-by-phase without re-deriving decisions. Where a detail is intentionally deferred, it is marked `OPEN`.

---

## 1. Product summary

HamScope is a **local desktop application** that connects to **internet-accessible SDR (software-defined radio) receivers**, listens to multiple receivers at once, and presents a live **dashboard**. For each receiver it:

- streams live audio from the remote SDR,
- for **voice** signals (SSB/AM): transcribes speech and **translates to English**, plus reports the **detected source language**,
- for **digital** signals (FT8/FT4, CW/Morse, PSK31/RTTY): decodes the mode into text,
- displays per-receiver telemetry (frequency, band, mode, signal strength, mini-waterfall) and a live, searchable transcript.

**Receive-only. No transmit. No control actions that could affect a remote node beyond normal listener use.**

---

## 2. Locked decisions (constraints — do not change without explicit approval)

| # | Decision | Value |
|---|----------|-------|
| D1 | ASR + language ID | **Local**, via whisper.cpp (no cloud ASR) |
| D2 | Translation | **English only**, via Whisper `translate` task (no separate MT layer in v1) |
| D3 | Source scope | **KiwiSDR + OpenWebRX + digital modes** (FT8/FT4, CW, PSK31/RTTY) |
| D4 | Deployment | **Local desktop app** (single user's machine) |
| D5 | App framework | **Tauri 2 + React** (mirror the Froglips project pattern) |
| D6 | Core language | **Rust** for the backend/core; React/TypeScript for UI |
| D7 | Persistence | **SQLite** (local file) |

### Derived engineering choices (chosen to satisfy the above; change only with reason)

| # | Choice | Rationale |
|---|--------|-----------|
| E1 | ASR via **`whisper-rs`** (Rust binding to whisper.cpp) running in a dedicated worker pool in the Rust core | Satisfies D1+D6 in-process; no Python sidecar for ASR |
| E2 | Audio (IMA-ADPCM) decode, resampling, VAD, framing all in **Rust** | Single runtime, fewer moving parts |
| E3 | Resampling via **`rubato`** crate (KiwiSDR audio ~12 kHz → 16 kHz for Whisper) | Standard, high quality |
| E4 | VAD: start with **energy/RMS gate**; upgrade path to **Silero VAD** via `ort` (ONNX Runtime) | Ship P1 fast, improve later |
| E5 | FT8/FT4 decode via **`ft8_lib`** (C, kgoba/ft8_lib) compiled through `build.rs` (or invoked as a bundled helper binary) | Reference decoder, permissive license |
| E6 | CW/Morse decode: **custom Rust** Goertzel tone-detector + adaptive timing | Small, no external dep |
| E7 | PSK31/RTTY: **`fldigi`** controlled headless via its XML-RPC API (P4; treat as optional external dependency) `OPEN` | Mature decoder; alternative = pure-Rust decoder |

---

## 3. Non-goals (v1)

- No transmit / no rig control / no CAT.
- No translation to languages other than English.
- No account system, no multi-user, no cloud hosting.
- No mobile build.
- No WebSDR (PA3FWM, the `websdr.org` Java/proprietary type) source — only KiwiSDR and OpenWebRX. (May revisit later.)
- No automatic legal/identity attribution of operators.

---

## 4. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  React UI (webview)                                                    │
│  - Receiver tile grid   - Transcript pane   - Add-receiver   - Search  │
└───────────────▲───────────────────────────────┬───────────────────────┘
                │ Tauri events (push)            │ Tauri commands (call)
┌───────────────┴───────────────────────────────▼───────────────────────┐
│  Rust core (Tauri backend)                                             │
│                                                                        │
│  Orchestrator ── manages Receiver Sessions, scheduling, lifecycle      │
│      │                                                                  │
│      ├─ Source Adapter (per receiver)                                   │
│      │     KiwiSDR | OpenWebRX  → raw audio frames + telemetry          │
│      │                                                                  │
│      ├─ Audio Pipeline (per receiver)                                   │
│      │     decode → resample(16k) → VAD → segment buffer               │
│      │                                                                  │
│      ├─ Voice lane → ASR Worker Pool (whisper-rs) → transcript+lang     │
│      │                                                                  │
│      ├─ Digital lane → Decoder (FT8 | CW | PSK31/RTTY) → text          │
│      │                                                                  │
│      └─ Store (SQLite) ← writes transcripts, telemetry snapshots        │
└────────────────────────────────────────────────────────────────────────┘
```

**Threading model:** Tokio async runtime. Each receiver session owns its own async tasks for networking and a bounded channel feeding the shared ASR worker pool. ASR is CPU/GPU-bound → runs on a dedicated `rayon`/blocking thread pool sized to hardware (see R2). Digital decoders run on blocking tasks.

---

## 5. Repository layout

```
hamscope/
├─ DESIGN.md                  # this file
├─ README.md
├─ package.json              # frontend deps + tauri scripts
├─ src/                      # React + TypeScript frontend
│  ├─ main.tsx
│  ├─ App.tsx
│  ├─ components/
│  │  ├─ ReceiverTile.tsx
│  │  ├─ TileGrid.tsx
│  │  ├─ TranscriptPane.tsx
│  │  ├─ AddReceiverDialog.tsx
│  │  ├─ Waterfall.tsx
│  │  └─ SearchBar.tsx
│  ├─ lib/
│  │  ├─ ipc.ts              # typed wrappers over Tauri invoke/listen
│  │  └─ types.ts            # mirrors Rust types (keep in sync)
│  └─ state/                 # store (zustand or React context)
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  ├─ build.rs               # compiles ft8_lib if vendored
│  └─ src/
│     ├─ main.rs             # Tauri setup, command/event registration
│     ├─ commands.rs         # #[tauri::command] handlers
│     ├─ events.rs           # event names + emit helpers
│     ├─ orchestrator.rs     # ReceiverSession lifecycle, scheduler
│     ├─ model.rs            # shared structs/enums (serde)
│     ├─ store/
│     │  ├─ mod.rs
│     │  ├─ schema.sql
│     │  └─ db.rs            # sqlx or rusqlite access
│     ├─ source/
│     │  ├─ mod.rs           # `Source` trait
│     │  ├─ kiwisdr.rs
│     │  └─ openwebrx.rs
│     ├─ audio/
│     │  ├─ mod.rs
│     │  ├─ adpcm.rs         # IMA-ADPCM decode
│     │  ├─ resample.rs
│     │  ├─ vad.rs
│     │  └─ segment.rs       # silence-bounded segmentation
│     ├─ asr/
│     │  ├─ mod.rs           # worker pool
│     │  ├─ whisper.rs       # whisper-rs wrapper
│     │  └─ model_dl.rs      # ggml model download/verify
│     └─ digital/
│        ├─ mod.rs           # `Decoder` trait + dispatch
│        ├─ ft8.rs
│        ├─ cw.rs
│        └─ psk_rtty.rs
└─ models/                   # downloaded ggml whisper models (gitignored)
```

---

## 6. Data model (SQLite)

`src-tauri/src/store/schema.sql`:

```sql
-- A configured remote receiver the user has added.
CREATE TABLE IF NOT EXISTS receiver (
  id            TEXT PRIMARY KEY,          -- uuid
  kind          TEXT NOT NULL,             -- 'kiwisdr' | 'openwebrx' | 'feed'
  url           TEXT NOT NULL,             -- base ws/http url of the node (or stream URL for feeds)
  label         TEXT,                      -- user-facing name
  freq_hz       INTEGER NOT NULL,          -- tuned center freq
  mode          TEXT NOT NULL,             -- 'usb'|'lsb'|'am'|'cw'|'ft8'|'ft4'|'psk31'|'rtty'
  lane          TEXT NOT NULL,             -- 'voice' | 'digital'
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,          -- unix ms
  favorite      INTEGER NOT NULL DEFAULT 0,-- quick-connect star (added by migration)
  antenna       TEXT,                      -- free-text antenna desc (catalog or user); added by migration
  region        TEXT                       -- coarse region label; added by migration
);
-- New columns (favorite/antenna/region) are added by an idempotent ALTER migration
-- in db.rs (Db::migrate) so existing databases upgrade in place. add_receiver upserts
-- with ON CONFLICT that preserves favorite + created_at across edits.

-- One row per decoded/transcribed utterance or digital message.
CREATE TABLE IF NOT EXISTS transcript (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  receiver_id   TEXT NOT NULL REFERENCES receiver(id) ON DELETE CASCADE,
  ts_start      INTEGER NOT NULL,          -- unix ms, audio segment start
  ts_end        INTEGER NOT NULL,
  lane          TEXT NOT NULL,             -- 'voice' | 'digital'
  mode          TEXT NOT NULL,
  src_lang      TEXT,                      -- ISO 639-1 from Whisper; NULL for digital
  text_en       TEXT NOT NULL,            -- English (translated for voice; raw decode for digital)
  text_native   TEXT,                      -- original-language transcript (voice only, optional)
  confidence    REAL,                      -- 0..1 if available
  snr_db        REAL                       -- signal estimate at capture, if known
);

CREATE INDEX IF NOT EXISTS idx_transcript_receiver ON transcript(receiver_id, ts_start);

-- Full-text search over decoded text.
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
  text_en, text_native, content='transcript', content_rowid='id'
);

-- Periodic telemetry snapshot (for sparklines / S-meter history).
CREATE TABLE IF NOT EXISTS telemetry (
  receiver_id   TEXT NOT NULL REFERENCES receiver(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  s_meter_dbm   REAL,
  snr_db        REAL,
  PRIMARY KEY (receiver_id, ts)
);

-- App settings (key/value).
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Storage location:** `~/.hamscope/db.sqlite` (create dir on first run; mirror Froglips' `~/.local-llm-app/` convention). Models in `~/.hamscope/models/`.

---

## 7. Shared types (`src-tauri/src/model.rs`, mirrored in `src/lib/types.ts`)

```rust
#[derive(Clone, Serialize, Deserialize)]
pub enum ReceiverKind { Kiwisdr, Openwebrx }

#[derive(Clone, Serialize, Deserialize)]
pub enum Lane { Voice, Digital }

#[derive(Clone, Serialize, Deserialize)]
pub struct ReceiverConfig {
    pub id: String,
    pub kind: ReceiverKind,
    pub url: String,
    pub label: Option<String>,
    pub freq_hz: u64,
    pub mode: String,      // see schema CHECK list
    pub lane: Lane,
    pub enabled: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub enum SessionStatus { Connecting, Live, Reconnecting, Error, Stopped }

#[derive(Clone, Serialize, Deserialize)]
pub struct TranscriptRow {
    pub id: i64,
    pub receiver_id: String,
    pub ts_start: i64,
    pub ts_end: i64,
    pub lane: Lane,
    pub mode: String,
    pub src_lang: Option<String>,
    pub text_en: String,
    pub text_native: Option<String>,
    pub confidence: Option<f32>,
    pub snr_db: Option<f32>,
}

// Pushed to UI ~1–4 Hz per receiver.
#[derive(Clone, Serialize, Deserialize)]
pub struct TelemetryFrame {
    pub receiver_id: String,
    pub status: SessionStatus,
    pub s_meter_dbm: Option<f32>,
    pub snr_db: Option<f32>,
    pub waterfall_row: Option<Vec<u8>>, // optional compact spectrum row
}
```

> **Invariant:** `src/lib/types.ts` must be kept structurally identical to `model.rs`. When you change one, change the other in the same commit.

---

## 8. Module specifications

### 8.1 Source adapters (`source/`)

Define a trait every source implements:

```rust
#[async_trait]
pub trait Source: Send {
    /// Connect, tune, and begin streaming. Returns once the stream is established.
    async fn start(&mut self, cfg: &ReceiverConfig) -> Result<()>;

    /// Yields decoded PCM frames (f32, mono) at the source's native sample rate,
    /// plus periodic telemetry. Implemented as channels, not a single return.
    fn audio_rx(&self) -> mpsc::Receiver<AudioFrame>;
    fn telemetry_rx(&self) -> mpsc::Receiver<TelemetryFrame>;

    async fn stop(&mut self) -> Result<()>;
    fn native_sample_rate(&self) -> u32;
}

pub struct AudioFrame { pub samples: Vec<f32>, pub sample_rate: u32, pub ts_ms: i64 }
```

#### KiwiSDR (`source/kiwisdr.rs`)
- Protocol: WebSocket. **Ground truth = the `kiwiclient`/`kiwirecorder.py` reference implementation** (jks-prv/kiwiclient). Port its handshake, not a guess.
- Key facts to implement:
  - Connect to `ws://<host>:<port>/<timestamp>/SND` (sound) and optionally `/W/F` (waterfall).
  - Send auth: `SET auth t=kiwi p=<password-or-empty>`.
  - Configure: `SET mod=<usb|lsb|am|cw> low_cut=<hz> high_cut=<hz> freq=<khz>` (note: **freq in kHz**), AGC params, `SET squelch=...`.
  - Audio arrives as binary frames tagged `SND`; payload is **IMA-ADPCM** compressed, mono, ~12 kHz → decode in `audio/adpcm.rs`.
  - S-meter (RSSI) arrives inline in sound frames → map to `s_meter_dbm`.
  - Send periodic keepalive per reference client.
- Filter bandwidth per mode: SSB ~300–2700 Hz; AM wider; CW ~200–500 Hz around the CW pitch.

#### OpenWebRX (`source/openwebrx.rs`)
- Protocol: WebSocket. Ground truth = OpenWebRX client source (`openwebrx`/`openwebrx-plus` repo, `htdocs/` JS).
- Implement handshake, demodulator selection, frequency set, and the audio framing it uses (Opus or raw depending on server config — handle the negotiated format). `OPEN`: confirm audio codec negotiation during P2.

> If a node requires a password or is full, surface a clear `SessionStatus::Error` with reason; do not crash the session.

### 8.2 Audio pipeline (`audio/`)

Per receiver, voice lane only:

```
AudioFrame(native rate)
  → resample.rs  → 16 kHz mono f32
  → vad.rs       → voiced/unvoiced flag per 20–30 ms frame
  → segment.rs   → accumulate voiced frames; close a segment after
                   `silence_ms >= 700` OR `len >= max_segment_s (e.g. 25s)`;
                   drop segments shorter than `min_segment_s (e.g. 1.2s)`
  → emit AsrJob{ receiver_id, pcm16k, ts_start, ts_end, snr_est }
```

- `adpcm.rs`: IMA-ADPCM decoder (standard 4-bit, with KiwiSDR's framing/step-index init per reference client). Unit-test against a captured KiwiSDR frame fixture.
- `resample.rs`: `rubato` SincFixedIn, native→16000.
- `vad.rs`: P1 = RMS threshold with hysteresis + noise-floor tracking. Provide a trait so Silero can drop in later.
- `segment.rs`: state machine (Idle → Voiced → trailing-silence → Emit). Carry `ts_start/ts_end` in unix ms.

### 8.3 ASR worker pool (`asr/`)

- `whisper.rs`: wrap `whisper-rs`. Load a ggml model once; reuse the context per worker thread (whisper context is not cheap to create).
  - Params: `task = translate` (→ English), `translate = true`, `detect_language = true` (so `src_lang` is reported), greedy or small beam, `no_context = true` per segment (segments are independent overs), single-segment audio.
  - Output → `{ text_en, src_lang, avg_logprob→confidence }`.
- `mod.rs`: bounded MPSC of `AsrJob`. Worker count = `clamp(physical_cores - 2, 1, 4)` by default; expose as a setting (see R2). Backpressure: if the queue is full, **drop oldest** voice segments and increment a dropped-segment counter surfaced in telemetry (never block the network task).
- `model_dl.rs`: on first run, download a default ggml model to `~/.hamscope/models/`, verify size/sha, record path in `setting`. Default model: `ggml-small` (good multilingual/translate vs. speed) `OPEN` — allow user to pick `base`/`small`/`medium` in settings.

> **Spending note:** all ASR is local; no API spend. (Honors the user's standing rule to flag API spend — there is none here.)

### 8.4 Digital decoders (`digital/`)

```rust
pub trait Decoder: Send {
    /// Feed native-rate audio; emit zero or more decoded messages.
    fn push(&mut self, frame: &AudioFrame) -> Vec<DigitalMsg>;
}
pub struct DigitalMsg { pub text: String, pub ts_ms: i64, pub snr_db: Option<f32>, pub meta: serde_json::Value }
```

- **FT8/FT4 (`ft8.rs`)** — windowed: FT8 = 15 s cycles, FT4 = 7.5 s. Buffer one cycle of audio, run `ft8_lib` `decode_ft8` over the window, emit all decoded lines. Use `ft8_lib` via FFI (`build.rs` compiles the vendored C) or call a tiny helper binary. Each decoded line → `DigitalMsg` (store raw `CALL CALL GRID`/report in `text_en`).
- **CW (`cw.rs`)** — Goertzel at the CW tone (auto-detect peak in passband), envelope → adaptive dot/dash/space timing (WPM tracking) → Morse table → text. Emit on word/idle boundaries.
- **PSK31/RTTY (`psk_rtty.rs`)** — P4. Either drive `fldigi` headless over XML-RPC (`text` poll) or a pure-Rust BPSK31/Baudot decoder. Decide during P4. `OPEN`.

Digital messages bypass the ASR pool and write straight to `store` with `lane = digital`, `src_lang = NULL`.

### 8.5 Orchestrator (`orchestrator.rs`)

- Owns a `HashMap<receiver_id, ReceiverSession>`.
- `ReceiverSession` = the source adapter + its pipeline tasks + a cancellation token.
- Responsibilities: start/stop sessions, reconnect with backoff on drop, route audio to the correct lane, fan telemetry to the UI (throttled to ≤4 Hz/receiver), enforce the global ASR concurrency cap, persist transcripts/telemetry.
- Reconnect policy: exponential backoff (1s → 30s cap), status events on each transition.

### 8.6 Store (`store/`)
- `rusqlite` (simple, sync, fine for one local user) or `sqlx` (async). Pick `rusqlite` behind a small async-friendly wrapper unless a reason emerges. `OPEN` (default: rusqlite).
- On insert into `transcript`, also insert into `transcript_fts`.
- Provide: `add_receiver`, `list_receivers`, `update_receiver`, `delete_receiver`, `insert_transcript`, `query_transcripts(receiver_id?, time_range?, text_query?)`, `insert_telemetry`, `get/set_setting`.

---

## 9. IPC contract (Tauri)

### Commands (UI → core), in `commands.rs`
```
add_receiver(cfg: ReceiverConfig) -> Result<ReceiverConfig>
update_receiver(cfg: ReceiverConfig) -> Result<()>
remove_receiver(id: String) -> Result<()>
set_favorite(id: String, favorite: bool) -> Result<()>
list_receivers() -> Vec<ReceiverConfig>
start_receiver(id: String) -> Result<()>
stop_receiver(id: String) -> Result<()>
tune(id: String, freq_hz: u64) -> Result<()>           // live retune, no reconnect
set_radio_ctl(id: String, ctl: RadioCtl) -> Result<()> // live filter/RF-gain (KiwiSDR)
set_monitor(id) / set_monitor_sub(id) / set_watched(ids)
start_recording(id) / stop_recording(id) / recording_ids() / recordings_dir()
partial_recordings() -> Vec<String>                    // crash-left unfinalized WAVs
export_log(format: "adif"|"csv", digital_only: bool) -> String   // returns file path
query_transcripts(filter: TranscriptFilter) -> Vec<TranscriptRow>
list_bookmarks/add_bookmark/remove_bookmark; list_alert_rules/add/remove; list_alert_hits
get_settings() -> Settings
set_settings(s: Settings) -> Result<()>
model_status() -> ModelStatus                // present? + path + source
list_model_options() -> Vec<ModelInfo>
download_model() -> Result<()>               // background; emits model_dl progress, atomic install
```

### Events (core → UI), in `events.rs`
```
"telemetry"   payload: TelemetryFrame        // throttled per receiver (s_meter_dbm, snr_db)
"spectrum"    payload: { receiver_id, bins }  // waterfall row (watched receivers only)
"audio"       payload: { receiver_id, sample_rate, pcm_b64 }  // MAIN/SUB monitored audio
"transcript"  payload: TranscriptRow         // new decoded line
"session"     payload: { receiver_id, status: SessionStatus, reason?: string }  // Error = permanent
"recording"   payload: { receiver_id, recording, error? }    // honest REC state
"alert"       payload: AlertHit
"model_dl"    payload: { received, total, done, error? }
```

> Note: digital lanes are demodulated as **USB** (see §8.1 `sdr_demod`) and fed to the in-app decoder;
> the SDR is never sent an invalid `mod=ft8`.

`src/lib/ipc.ts` wraps each command (`invoke`) and event (`listen`) with the TS types from `types.ts`.

---

## 10. Frontend behavior (`src/`)

- **TileGrid** renders one **ReceiverTile** per enabled receiver. Tile shows: label, freq/band, mode badge, lane badge, `SessionStatus` dot, S-meter bar (from `telemetry`), mini **Waterfall** (if `waterfall_row` provided), and the last 1–2 transcript lines.
- **TranscriptPane**: full scrollback for the selected receiver; voice rows show `🌐 <src_lang>` badge + English text (and native text on expand); digital rows show the raw decode + mode.
- **AddReceiverDialog**: fields = URL, kind (auto-detect from URL if possible), freq, mode; mode selection sets `lane` automatically (cw/ft8/ft4/psk31/rtty → digital; usb/lsb/am → voice).
- **SearchBar**: calls `query_transcripts` with FTS text → filtered transcript view across receivers.
- State store (zustand). UI never holds audio; only metadata + text + telemetry.

---

## 11. Build phases (implement in order; each has an acceptance gate)

### Phase 1 — KiwiSDR voice end-to-end (proves the core + the #1 risk)
**Scope:** one KiwiSDR receiver → ADPCM decode → resample → VAD/segment → whisper-rs translate → SQLite → single tile + transcript in UI.
**Acceptance:**
- Add a public KiwiSDR URL + SSB freq; tile shows `Live`; S-meter moves.
- A spoken over on a clear signal produces a `transcript` row with English text and a `src_lang`.
- ADPCM decoder has a passing unit test against a captured frame fixture.
- **SNR gate:** evaluate transcription quality on real signals. Record findings in `README.md`. If weak-signal accuracy is unusable, raise it before P3 (this is the documented kill-or-continue checkpoint).

### Phase 2 — OpenWebRX + multi-receiver concurrency
**Scope:** OpenWebRX source adapter; run ≥3 receivers at once; ASR worker pool + backpressure; reconnect with backoff; throttled telemetry; tile grid.
**Acceptance:** 3 simultaneous receivers stay `Live`; dropped-segment counter is exposed; killing one node's connection triggers visible reconnect without affecting others.

### Phase 3 — FT8/FT4 digital lane
**Scope:** digital lane plumbing + `ft8.rs` via `ft8_lib`. Cycle-windowed buffering.
**Acceptance:** tuned to an active FT8 watering-hole freq, decoded `CALL CALL GRID` lines appear and persist; mode badge = FT8/FT4.

### Phase 4 — CW + PSK31/RTTY
**Scope:** `cw.rs` (Goertzel/Morse) and `psk_rtty.rs` (fldigi-XMLRPC or pure-Rust — decide here).
**Acceptance:** CW from a clear beacon decodes to readable text; PSK31/RTTY decodes a clear signal. Document accuracy limits.

> Do not start a later phase until the prior phase's acceptance gate passes. Commit at each gate. (No `Co-Authored-By` trailer; do not push without explicit instruction.)

---

## 12. Risks & mitigations

| # | Risk | Mitigation |
|---|------|-----------|
| R1 | **SSB/AM SNR** — weak, noisy, narrowband voice degrades Whisper badly | P1 SNR gate decides go/no-go; tune VAD + bandpass; allow larger model; show confidence so users discount low-quality lines |
| R2 | **Concurrent ASR cost** — each voice stream loads CPU/GPU | Shared worker pool with hard cap (`cores-2`, max 4 default, user-settable); drop-oldest backpressure; digital lanes are cheap and unaffected |
| R3 | **KiwiSDR/OpenWebRX protocol drift** — undocumented/changing WS protocol | Port from the reference clients, not from memory; isolate behind the `Source` trait; fixture-test the decoders |
| R4 | **Public node limits/etiquette** — nodes have listener slots & time limits | Respect node limits; clear error states; do not hammer reconnects (backoff); single connection per node |
| R5 | **Model download** — large ggml files on first run | Progress events; verify sha/size; let user pick model size |

---

## 13. Conventions for the implementer

- Keep `model.rs` and `types.ts` in lock-step.
- Each module owns its errors via `thiserror`; surface user-meaningful reasons in `SessionStatus::Error`.
- Network and decode tasks must **never panic** the session; log + transition to `Error`/`Reconnecting`.
- Write unit tests for: ADPCM decode, resample length math, VAD state machine, Morse timing, FT8 line parse.
- Data dir: `~/.hamscope/` (db + models). Gitignore `models/` and any runtime data.
- Match the existing Froglips desktop conventions where they apply (Tauri 2 setup, data-dir style).

---

## 14. Open questions (resolve at the marked phase)

- `OPEN` Default Whisper model size (`base`/`small`/`medium`) — pick in P1 from the SNR gate results.
- `OPEN` OpenWebRX audio codec negotiation (Opus vs raw) — confirm in P2.
- `OPEN` PSK31/RTTY implementation (fldigi-XMLRPC vs pure-Rust) — decide in P4.
- `OPEN` Store layer crate (`rusqlite` default vs `sqlx`).
- `OPEN` Whether to persist/render full waterfall or just S-meter history in v1.
