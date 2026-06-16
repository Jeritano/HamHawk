import { describe, it, expect } from "vitest";
import { formatFreq, formatTimeHMS, BANDS, VOICE_MODES, DIGITAL_MODES } from "./format";

describe("formatFreq", () => {
  it("formats Hz as MHz", () => {
    expect(formatFreq(14_074_000)).toBe("14.074 MHz");
    expect(formatFreq(0)).toBe("0.000 MHz");
  });
  it("guards non-finite", () => {
    expect(formatFreq(NaN)).toBe("—");
  });
});

describe("formatTimeHMS", () => {
  it("guards invalid input", () => {
    expect(formatTimeHMS(-1)).toBe("—");
    expect(formatTimeHMS(NaN)).toBe("—");
  });
  it("returns HH:MM:SS for a valid ms timestamp", () => {
    expect(formatTimeHMS(0)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("BANDS presets", () => {
  it("every band has a positive frequency and a known mode", () => {
    const modes = new Set([...VOICE_MODES, ...DIGITAL_MODES]);
    for (const b of BANDS) {
      expect(b.hz).toBeGreaterThan(0);
      expect(modes.has(b.mode)).toBe(true);
    }
  });
});
