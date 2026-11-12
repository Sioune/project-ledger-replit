export type TaskStatus = "todo" | "doing" | "waiting" | "blocked" | "done" | "cancelled";
export type ItemType = "task" | "event" | "reference";
export type EventStatus = "reserved" | "planned" | "completed" | "cancelled";

export type Change = {
  type: "create" | "update" | "project" | "settings" | "document" | "pending" | "restore";
  id?: string;
  values: Record<string, unknown>;
};

export type Submit = {
  operation_id: string;
  idempotency_key: string;
  source_event_id: string;
  base_version: number;
  occurred_at: string;
  raw_text: string;
  changes: Change[];
  confirmed?: boolean;
  undo_of?: string;
};
