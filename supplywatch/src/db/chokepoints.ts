import { db } from "./client";
import { chokepoints } from "./schema";

export const CHOKEPOINTS = [
  {
    slug: "bosporus",
    name: "Bosporus Strait",
    laneWidthM: 698,
    geometryGeojson: boxPolygon(29.05, 40.97, 29.2, 41.2),
  },
  {
    slug: "suez-canal",
    name: "Suez Canal",
    laneWidthM: 205,
    geometryGeojson: boxPolygon(32.3, 29.9, 32.65, 30.8),
  },
  {
    slug: "panama-canal",
    name: "Panama Canal",
    laneWidthM: 218,
    geometryGeojson: boxPolygon(-80.0, 8.8, -79.5, 9.3),
  },
  {
    slug: "strait-of-malacca",
    name: "Strait of Malacca",
    laneWidthM: 2500,
    geometryGeojson: boxPolygon(98.0, 1.1, 104.5, 7.8),
  },
  {
    slug: "strait-of-hormuz",
    name: "Strait of Hormuz",
    laneWidthM: 33000,
    geometryGeojson: boxPolygon(56.2, 25.7, 57.0, 26.7),
  },
  {
    slug: "english-channel",
    name: "English Channel",
    laneWidthM: 33000,
    geometryGeojson: boxPolygon(-1.8, 49.9, 1.7, 51.2),
  },
  {
    slug: "taiwan-strait",
    name: "Taiwan Strait",
    laneWidthM: 180000,
    geometryGeojson: boxPolygon(118.0, 22.5, 122.0, 25.5),
  },
  {
    slug: "kiel-canal",
    name: "Kiel Canal",
    laneWidthM: 162,
    geometryGeojson: boxPolygon(9.3, 53.9, 10.2, 54.5),
  },
];

function boxPolygon(west: number, south: number, east: number, north: number) {
  return {
    type: "Polygon",
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

export async function seedChokepoints() {
  for (const cp of CHOKEPOINTS) {
    await db
      .insert(chokepoints)
      .values(cp)
      .onConflictDoNothing({ target: chokepoints.slug });
  }
}
