import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts";

export const pendingUploadsTable = pgTable(
  "pending_uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => accountsTable.id, { onDelete: "cascade" }),
    objectPath: text("object_path").notNull(),
    fileName: text("file_name").notNull(),
    byteSize: integer("byte_size").notNull(),
    mimeType: text("mime_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("pending_uploads_path").on(table.objectPath)],
);
