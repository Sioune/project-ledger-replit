import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts";

export const imagesTable = pgTable(
  "images",
  {
    id: text("id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => accountsTable.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    objectPath: text("object_path").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.id], name: "images_owner_id" }),
    uniqueIndex("images_owner_hash").on(table.ownerId, table.sha256),
    index("images_owner_created").on(table.ownerId, table.uploadedAt.desc()),
  ],
);

export type ImageRow = typeof imagesTable.$inferSelect;
