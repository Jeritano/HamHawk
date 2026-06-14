import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { vesselSnapshots } from "../src/db/schema";
import { chokepoints } from "../src/db/chokepoints";
import type { AISMessage, Chokepoint } from "./types";

const BATCH_SIZE = 100;
const flushMs = 1000;

export class SnapshotWriter {
  private buffer: {
    mmsi: string;
    chokepointId: number;
    timestamp: Date;
    latitude: number;
    longitude: number;
    sogKnots: number | null;
    cogDegrees: number | null;
    heading: number | null;
    shipType: string | null;
    navigationalStatus: string | null;
  }[] = [];

  private timer: NodeJS.Timeout | null = null;
  private readonly chokepointMap: Map<number, Chokepoint>;

  constructor(chokepointsList: Chokepoint[]) {
    this.chokepointMap = new Map(chokepointsList.map((c) => [c.id, c]));
  }

  async ingest(msg: AISMessage, chokepoint: Chokepoint) {
    this.buffer.push({
      mmsi: String(msg.MMSI || 0),
      chokepointId: chokepoint.id,
      timestamp: new Date(msg.timestamp),
      latitude: msg.latitude,
      longitude: msg.longitude,
      sogKnots: msg.sog ?? null,
      cogDegrees: msg.cog ?? null,
      heading: msg.heading ?? null,
      shipType: msg.shipType ?? null,
      navigationalStatus: msg.navigationalStatus ?? null,
    });

    if (this.buffer.length >= BATCH_SIZE) {
      await this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), flushMs);
    }
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    try {
      await db.insert(vesselSnapshots).values(batch).onConflictDoNothing({
        target: [vesselSnapshots.mmsi, vesselSnapshots.timestamp],
      });
    } catch (err) {
      console.error("Failed to insert vessel snapshots:", err);
    }
  }

  async healthCheck(): Promise<{ ok: boolean; chokepointsLoaded: number; lastSnapshotAt?: Date }> {
    const loaded = await db.select().from(chokepoints);
    const row = await db
      .select({ max: vesselSnapshots.timestamp })
      .from(vesselSnapshots)
      .orderBy(vesselSnapshots.timestamp)
      .limit(1);
    return { ok: loaded.length > 0, chokepointsLoaded: loaded.length, lastSnapshotAt: row[0]?.max };
  }

  listChokepoints() {
    return Array.from(this.chokepointMap.values());
  }
}
