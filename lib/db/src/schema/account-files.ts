import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accountsTable } from "./accounts";

export const accountFilesTable = pgTable(
  "account_files",
  {
    id: uuid("id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => accountsTable.id, { onDelete: "cascade" }),
    sourceLibraryId: text("source_library_id").notNull(),
    sourceFileId: text("source_file_id").notNull(),
    sourceVersion: text("source_version").notNull(),
    sourceVersionType: text("source_version_type").notNull(),
    libraryRef: text("library_ref").notNull(),
    versionId: text("version_id"),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    objectPath: text("object_path").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.id], name: "account_files_owner_id" }),
    uniqueIndex("account_files_owner_reference_versioned")
      .on(table.ownerId, table.libraryRef, table.versionId)
      .where(sql`${table.versionId} IS NOT NULL`),
    uniqueIndex("account_files_owner_reference_unversioned")
      .on(table.ownerId, table.libraryRef)
      .where(sql`${table.versionId} IS NULL`),
    uniqueIndex("account_files_owner_source_version").on(table.ownerId, table.sourceLibraryId, table.sourceFileId, table.sourceVersion, table.sourceVersionType),
    index("account_files_owner_library_ref").on(table.ownerId, table.libraryRef),
  ],
);

export type AccountFileRow = typeof accountFilesTable.$inferSelect;
