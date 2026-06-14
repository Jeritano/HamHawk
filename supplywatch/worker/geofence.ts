import type { ChokepointGeometry } from "./types";

export type BoundingBox = { west: number; south: number; east: number; north: number };

export function geometryToBounds(geo: ChokepointGeometry): BoundingBox {
  if (geo.type !== "Polygon" || !geo.coordinates?.[0]?.length) {
    throw new Error("Unsupported geometry: expected Polygon");
  }
  const ring = geo.coordinates[0];
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return { west, south, east, north };
}

export function pointInBounds(lat: number, lon: number, bounds: BoundingBox): boolean {
  return (
    lat >= bounds.south &&
    lat <= bounds.north &&
    lon >= bounds.west &&
    lon <= bounds.east
  );
}
