import { describe, it, expect } from "vitest";
import { KIWI_CATALOG, CATALOG_REGIONS } from "./kiwicatalog";

describe("KIWI_CATALOG", () => {
  it("is non-empty and every entry is well-formed", () => {
    expect(KIWI_CATALOG.length).toBeGreaterThan(0);
    const regions = new Set(CATALOG_REGIONS);
    for (const e of KIWI_CATALOG) {
      expect(e.url).toMatch(/^https?:\/\//);
      expect(e.name.length).toBeGreaterThan(0);
      expect(Number.isFinite(e.snr)).toBe(true);
      expect(regions.has(e.region)).toBe(true);
      expect(e.lat).toBeGreaterThanOrEqual(-90);
      expect(e.lat).toBeLessThanOrEqual(90);
      expect(e.lon).toBeGreaterThanOrEqual(-180);
      expect(e.lon).toBeLessThanOrEqual(180);
    }
  });
});
