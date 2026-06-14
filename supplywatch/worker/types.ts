export interface AISMessage {
  MMSI: number;
  timestamp: string;
  latitude: number;
  longitude: number;
  sog?: number;
  cog?: number;
  heading?: number;
  shipType?: string;
  navigationalStatus?: string;
}

export interface ChokepointGeometry {
  type: "Polygon";
  coordinates: number[][][];
}

export interface Chokepoint {
  id: number;
  slug: string;
  name: string;
  laneWidthM?: number | null;
  geometryGeojson: ChokepointGeometry | null;
}

export type AlertType =
  | "AIS_SPIKE"
  | "AIS_DROP"
  | "SLOWDOWN"
  | "ECONOMIC_SPIKE"
  | "ECONOMIC_DROP";

export interface WorkerConfig {
  aisStreamApiKey: string;
  reconnectMs: number;
  maxReconnectMs: number;
  reconnectJitter: number;
  rollupCron: string;
  financialCron: string;
  baselineMinWeeks: number;
  zSpike: number;
  zDrop: number;
  zSlowdown: number;
  holidays: string[]; // ISO date strings YYYY-MM-DD
  watchSymbols: string[];
}

export const defaultConfig: WorkerConfig = {
  aisStreamApiKey: process.env.AISSTREAM_API_KEY || "",
  reconnectMs: 2000,
  maxReconnectMs: 60000,
  reconnectJitter: 1000,
  rollupCron: "0 * * * *",
  financialCron: "*/10 * * * *",
  baselineMinWeeks: 4,
  zSpike: 3,
  zDrop: -2.5,
  zSlowdown: 2,
  holidays: [],
  watchSymbols: ["WTI", "BRENT", "LNG", "BDIY"],
};
