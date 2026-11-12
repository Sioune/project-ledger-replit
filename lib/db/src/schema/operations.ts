import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts";

export const operationsTable = pgTable(
  "operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => accountsTable.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull(),
    receiptRaw: text("receipt_raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operations_owner_operation").on(table.ownerId, table.operationId),
    uniqueIndex("operations_owner_idempotency").on(table.ownerId, table.idempotencyKey),
    uniqueIndex("operations_owner_source").on(table.ownerId, table.sourceEventId),
    index("operations_owner_created").on(table.ownerId, table.createdAt.desc()),
  ],
);

export type OperationRow = typeof operationsTable.$inferSelect;
