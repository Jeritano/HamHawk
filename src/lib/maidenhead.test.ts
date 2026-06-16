import { describe, it, expect } from "vitest";
import { gridToLatLon, extractGrid, extractCallsigns } from "./maidenhead";

describe("gridToLatLon", () => {
  it("maps a 4-char grid to its cell center", () => {
    const ll = gridToLatLon("FN42");
    expect(ll).not.toBeNull();
    const [lat, lon] = ll!;
    expect(lat).toBeCloseTo(42.5, 5);
    expect(lon).toBeCloseTo(-71, 5);
  });
  it("accepts 6-char grids (case-insensitive)", () => {
    expect(gridToLatLon("jo62ai")).not.toBeNull();
  });
  it("rejects non-grids", () => {
    expect(gridToLatLon("9999")).toBeNull();
    expect(gridToLatLon("HELLO")).toBeNull();
  });
});

describe("extractGrid", () => {
  it("finds a grid token in decoded text", () => {
    expect(extractGrid("CQ K1ABC FN42")).toBe("FN42");
    expect(extractGrid("no grid here")).toBeNull();
  });
});

describe("extractCallsigns", () => {
  it("pulls callsigns from text", () => {
    expect(extractCallsigns("CQ K1ABC FN42")).toContain("K1ABC");
  });
});
