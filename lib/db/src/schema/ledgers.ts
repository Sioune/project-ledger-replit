import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts";

export const ledgersTable = pgTable("ledgers", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => accountsTable.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(0),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  dataRaw: text("data_raw"),
  lastOperation: text("last_operation").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LedgerRow = typeof ledgersTable.$inferSelect;
