import WebSocket from "ws";
import { defaultConfig, type WorkerConfig, type AISMessage, type Chokepoint } from "./types";
import { geometryToBounds, pointInBounds, type BoundingBox } from "./geofence";

export class AISClient {
  private ws: WebSocket | null = null;
  private reconnectDelay: number;
  private isStopped = false;
  private messageCount = 0;
  private lastLogAt = 0;
  private boundsByChokepoint: Map<number, { chokepoint: Chokepoint; bounds: BoundingBox }> = new Map();

  constructor(
    private readonly chokepoints: Chokepoint[],
    private readonly onMessage: (msg: AISMessage, chokepoint: Chokepoint) => void,
    private readonly config: WorkerConfig = defaultConfig
  ) {
    this.reconnectDelay = config.reconnectMs;
    for (const cp of chokepoints) {
      if (!cp.geometryGeojson) continue;
      try {
        this.boundsByChokepoint.set(cp.id, { chokepoint: cp, bounds: geometryToBounds(cp.geometryGeojson) });
      } catch {
        console.warn(`Skipping chokepoint ${cp.slug}: invalid geometry`);
      }
    }
  }

  private buildFilter() {
    const boxes = this.chokepoints
      .filter((cp) => cp.geometryGeojson)
      .map((cp) => {
        const { west, south, east, north } = geometryToBounds(cp.geometryGeojson!);
        return [[south, west], [north, east]];
      });
    return {
      APIKey: this.config.aisStreamApiKey,
      BoundingBoxes: boxes.length > 0 ? boxes : [[[0, 0], [0, 0]]],
      FilterMessageTypes: ["PositionReport"],
    };
  }

  start() {
    if (this.isStopped || !this.config.aisStreamApiKey) {
      console.warn("AISClient not started: missing API key or stopped");
      return;
    }
    this.connect();
  }

  private connect() {
    const url = "wss://stream.aisstream.io/v0/stream";
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log("AIS WebSocket connected");
      this.reconnectDelay = this.config.reconnectMs;
      const filter = this.buildFilter();
      this.ws?.send(JSON.stringify(filter));
    });

    this.ws.on("message", (data) => {
      try {
        const payload = JSON.parse(data.toString());
        this.handlePayload(payload);
      } catch (err) {
        // ignore malformed messages
      }
    });

    this.ws.on("error", (err) => {
      console.error("AIS WebSocket error:", err.message);
    });

    this.ws.on("close", () => {
      if (this.isStopped) return;
      const delay = Math.min(
        this.reconnectDelay + Math.random() * this.config.reconnectJitter,
        this.config.maxReconnectMs
      );
      console.log(`AIS WebSocket closed; reconnecting in ${Math.round(delay)}ms`);
      setTimeout(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.config.maxReconnectMs);
        this.connect();
      }, delay);
    });
  }

  private handlePayload(payload: Record<string, unknown>) {
    const message = payload.Message as Record<string, unknown> | undefined;
    const meta = payload.MetaData as Record<string, unknown> | undefined;
    if (!message || !meta) return;

    const lat = meta.latitude ?? message.Latitude;
    const lon = meta.longitude ?? message.Longitude;
    if (typeof lat !== "number" || typeof lon !== "number") return;

    const mmsi = meta.MMSI ?? message.UserID;
    const sog = message.Sog ?? message.SOG;
    const cog = message.Cog ?? message.COG;
    const heading = message.TrueHeading ?? message.Heading;

    const normalized: AISMessage = {
      MMSI: Number(mmsi || 0),
      timestamp: new Date().toISOString(),
      latitude: lat,
      longitude: lon,
      sog: typeof sog === "number" ? sog : undefined,
      cog: typeof cog === "number" ? cog : undefined,
      heading: typeof heading === "number" ? heading : undefined,
      shipType: typeof meta.ShipType === "string" ? meta.ShipType : undefined,
      navigationalStatus:
        typeof message.NavigationalStatus === "string"
          ? message.NavigationalStatus
          : undefined,
    };

    for (const { chokepoint, bounds } of this.boundsByChokepoint.values()) {
      if (pointInBounds(normalized.latitude, normalized.longitude, bounds)) {
        this.onMessage(normalized, chokepoint);
        break; // assign to first matching chokepoint
      }
    }

    this.messageCount++;
    const now = Date.now();
    if (now - this.lastLogAt > 60000) {
      console.log(`AIS messages received: ${this.messageCount}`);
      this.lastLogAt = now;
    }
  }

  stop() {
    this.isStopped = true;
    this.ws?.terminate();
  }
}
