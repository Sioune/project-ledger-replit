import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const accountsTable = pgTable("accounts", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull().default("本人"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Account = typeof accountsTable.$inferSelect;
