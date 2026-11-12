import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts";

export const accountImportsTable = pgTable("account_imports", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => accountsTable.id, { onDelete: "cascade" }),
  importId: uuid("import_id").notNull().unique(),
  snapshotSha256: text("snapshot_sha256").notNull(),
  sourceAccountHash: text("source_account_hash").notNull(),
  rowCounts: jsonb("row_counts").$type<Record<string, number>>().notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AccountImportRow = typeof accountImportsTable.$inferSelect;
