import {
  pgTable,
  serial,
  varchar,
  integer,
  real,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";

export const chokepoints = pgTable("chokepoints", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 256 }).notNull(),
  laneWidthM: real("lane_width_m"),
  geometryGeojson: jsonb("geometry_geojson"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const vesselSnapshots = pgTable(
  "vessel_snapshots",
  {
    id: serial("id").primaryKey(),
    mmsi: varchar("mmsi", { length: 32 }).notNull(),
    chokepointId: integer("chokepoint_id")
      .notNull()
      .references(() => chokepoints.id, { onDelete: "cascade" }),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    sogKnots: real("sog_knots"),
    cogDegrees: real("cog_degrees"),
    heading: real("heading"),
    shipType: varchar("ship_type", { length: 64 }),
    navigationalStatus: varchar("navigational_status", { length: 64 }),
  },
  (table) => ({
    mmsiIdx: index("vessel_mmsi_idx").on(table.mmsi),
    tsIdx: index("vessel_ts_idx").on(table.timestamp),
    chokeIdx: index("vessel_choke_idx").on(table.chokepointId),
    mmsiTsUnique: uniqueIndex("vessel_mmsi_ts_unique").on(table.mmsi, table.timestamp),
  })
);

export const hourlyRollups = pgTable(
  "hourly_rollups",
  {
    id: serial("id").primaryKey(),
    chokepointId: integer("chokepoint_id")
      .notNull()
      .references(() => chokepoints.id, { onDelete: "cascade" }),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    vesselCount: integer("vessel_count").notNull(),
    avgSogKnots: real("avg_sog_knots"),
    medianSogKnots: real("median_sog_knots"),
    minSogKnots: real("min_sog_knots"),
    maxSogKnots: real("max_sog_knots"),
    weightedThroughput: real("weighted_throughput"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    cpHourUnique: uniqueIndex("rollup_cp_hour_unique").on(table.chokepointId, table.hour),
    hourIdx: index("rollup_hour_idx").on(table.hour),
  })
);

export const baseline = pgTable(
  "baselines",
  {
    id: serial("id").primaryKey(),
    chokepointId: integer("chokepoint_id")
      .notNull()
      .references(() => chokepoints.id, { onDelete: "cascade" }),
    hourOfWeek: integer("hour_of_week").notNull(), // 0..167, Monday 00 = 0
    meanVesselCount: real("mean_vessel_count").notNull(),
    stdVesselCount: real("std_vessel_count").notNull(),
    meanThroughput: real("mean_throughput"),
    stdThroughput: real("std_throughput"),
    sampleCount: integer("sample_count").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    cpHodUnique: uniqueIndex("baseline_cp_hod_unique").on(table.chokepointId, table.hourOfWeek),
  })
);

export const alerts = pgTable(
  "alerts",
  {
    id: serial("id").primaryKey(),
    chokepointId: integer("chokepoint_id")
      .notNull()
      .references(() => chokepoints.id, { onDelete: "cascade" }),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    type: varchar("type", { length: 32 }).notNull(), // AIS_SPIKE, AIS_DROP, SLOWDOWN, ECONOMIC_SPIKE, ECONOMIC_DROP
    severity: varchar("severity", { length: 16 }).notNull(), // low, medium, high, critical
    message: varchar("message", { length: 1024 }).notNull(),
    metricValue: real("metric_value"),
    baselineValue: real("baseline_value"),
    zScore: real("z_score"),
    acknowledged: boolean("acknowledged").default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    chokeIdx: index("alert_choke_idx").on(table.chokepointId),
    hourIdx: index("alert_hour_idx").on(table.hour),
    createdIdx: index("alert_created_idx").on(table.createdAt),
  })
);

export const marketPrices = pgTable(
  "market_prices",
  {
    id: serial("id").primaryKey(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    price: real("price").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    symSrcTsUnique: uniqueIndex("price_sym_src_ts_unique").on(table.symbol, table.source, table.recordedAt),
    symIdx: index("price_sym_idx").on(table.symbol),
  })
);
