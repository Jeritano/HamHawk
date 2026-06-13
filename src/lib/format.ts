export function formatFreq(hz: number): string {
  return (hz / 1e6).toFixed(3) + " MHz";
}

export function formatTimeHMS(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const VOICE_MODES = ["usb", "lsb", "am"];
export const DIGITAL_MODES = ["ft8", "ft4", "cw", "psk31", "rtty"];

/** Common HF band center-ish presets (Hz) for the add dialog. */
export const BANDS: { label: string; hz: number; mode: string }[] = [
  { label: "160m", hz: 1_840_000, mode: "lsb" },
  { label: "80m", hz: 3_573_000, mode: "lsb" },
  { label: "40m", hz: 7_074_000, mode: "lsb" },
  { label: "30m", hz: 10_136_000, mode: "usb" },
  { label: "20m", hz: 14_074_000, mode: "usb" },
  { label: "17m", hz: 18_100_000, mode: "usb" },
  { label: "15m", hz: 21_074_000, mode: "usb" },
  { label: "10m", hz: 28_074_000, mode: "usb" },
  { label: "WWV", hz: 10_000_000, mode: "am" },
];
