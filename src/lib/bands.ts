// Band / channel browser data.
//
// HF entries are genuinely receivable on the KiwiSDR nodes HamHawk uses, so they
// live-tune the active VFO. VHF/UHF/700/800 (real US public-safety / police)
// CANNOT be received on HF nodes — they're listed as a reference and flagged;
// actual audio needs a scanner-feed source (Broadcastify/OpenMHz), a separate
// feature. Nothing here fabricates reception.

export interface Band {
  name: string;
  sub: string;
  band: "HF" | "VHF" | "UHF" | "700" | "800";
  freqHz?: number; // present (and tunable) only for HF
  mode?: string;
  tunable: boolean;
}

export interface BandGroup {
  title: string;
  note?: string;
  items: Band[];
}

export const BAND_GROUPS: BandGroup[] = [
  {
    title: "Public Service · HF",
    note: "Tunes the active VFO live.",
    items: [
      { name: "WWV", sub: "10.000 · time", band: "HF", freqHz: 10_000_000, mode: "am", tunable: true },
      { name: "Coast Guard", sub: "2.182 · distress", band: "HF", freqHz: 2_182_000, mode: "am", tunable: true },
      { name: "Marine HF", sub: "4.125 · USB", band: "HF", freqHz: 4_125_000, mode: "usb", tunable: true },
      { name: "Hurricane Net", sub: "14.325 · USB", band: "HF", freqHz: 14_325_000, mode: "usb", tunable: true },
      { name: "Aero NAT", sub: "8.906 · USB", band: "HF", freqHz: 8_906_000, mode: "usb", tunable: true },
      { name: "VOLMET", sub: "8.957 · wx", band: "HF", freqHz: 8_957_000, mode: "usb", tunable: true },
      { name: "Aero", sub: "13.270 · USB", band: "HF", freqHz: 13_270_000, mode: "usb", tunable: true },
      { name: "CB Ch 9", sub: "27.065 · emergency", band: "HF", freqHz: 27_065_000, mode: "am", tunable: true },
      { name: "CB Ch 19", sub: "27.185 · highway", band: "HF", freqHz: 27_185_000, mode: "am", tunable: true },
      { name: "Ham Emcomm", sub: "7.268 · LSB", band: "HF", freqHz: 7_268_000, mode: "lsb", tunable: true },
      { name: "SHARES/MARS", sub: "5.330 · USB", band: "HF", freqHz: 5_330_000, mode: "usb", tunable: true },
    ],
  },
  {
    title: "Police · VHF / UHF / P25",
    note: "Reference only — VHF/UHF, mostly P25 digital & often encrypted. HF nodes can't receive these; needs a scanner feed.",
    items: [
      { name: "VHF Low", sub: "39–46 MHz", band: "VHF", tunable: false },
      { name: "VHF High", sub: "151–159 MHz", band: "VHF", tunable: false },
      { name: "VCALL10", sub: "155.7525 interop", band: "VHF", tunable: false },
      { name: "UHF", sub: "453–460 / 465–470", band: "UHF", tunable: false },
      { name: "UCALL40", sub: "453.2125 interop", band: "UHF", tunable: false },
      { name: "700 MHz P25", sub: "769–775 digital", band: "700", tunable: false },
      { name: "800 MHz", sub: "851–869 trunked", band: "800", tunable: false },
      { name: "8CALL90", sub: "851.0125 interop", band: "800", tunable: false },
    ],
  },
];
