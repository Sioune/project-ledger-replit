import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts";

export const imageRecognitionsTable = pgTable(
  "image_recognitions",
  {
    id: text("id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => accountsTable.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    state: text("state").notNull(),
    resultJson: text("result_json"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.id], name: "image_recognitions_owner_id" }),
    index("recognitions_owner_created").on(table.ownerId, table.createdAt),
    index("recognitions_owner_fingerprint").on(table.ownerId, table.fingerprint),
  ],
);

export type ImageRecognitionRow = typeof imageRecognitionsTable.$inferSelect;
