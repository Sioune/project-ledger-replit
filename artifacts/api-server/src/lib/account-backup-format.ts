const MAX_BYTES = 12_000_000;

export const LEGACY_BACKUP_SCHEMA = [
  { type: "table", name: "accounts", tbl_name: "accounts", sql: "CREATE TABLE `accounts` ( `id` text PRIMARY KEY NOT NULL, `display_name` text NOT NULL, `created_at` text NOT NULL, `status` text NOT NULL )" },
  { type: "table", name: "ledgers", tbl_name: "ledgers", sql: "CREATE TABLE `ledgers` ( `id` integer PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `revision` integer NOT NULL, `data` text NOT NULL, `last_operation` text NOT NULL )" },
  { type: "table", name: "operations", tbl_name: "operations", sql: "CREATE TABLE `operations` ( `id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `idempotency_key` text NOT NULL, `source_event_id` text NOT NULL, `payload_hash` text NOT NULL, `receipt` text NOT NULL, `created_at` text NOT NULL )" },
  { type: "table", name: "images", tbl_name: "images", sql: "CREATE TABLE `images` ( `id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `sha256` text NOT NULL, `mime_type` text NOT NULL, `byte_size` integer NOT NULL, `uploaded_at` text NOT NULL, `bytes` blob NOT NULL )" },
  { type: "table", name: "image_recognitions", tbl_name: "image_recognitions", sql: "CREATE TABLE `image_recognitions` ( `id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `fingerprint` text NOT NULL, `state` text NOT NULL, `result_json` text, `error_code` text, `created_at` text NOT NULL, `finished_at` text )" },
  { type: "index", name: "images_owner_hash", tbl_name: "images", sql: "CREATE UNIQUE INDEX `images_owner_hash` ON `images` (`owner_id`,`sha256`)" },
  { type: "index", name: "ledgers_owner", tbl_name: "ledgers", sql: "CREATE UNIQUE INDEX `ledgers_owner` ON `ledgers` (`owner_id`)" },
  { type: "index", name: "owner_key", tbl_name: "operations", sql: "CREATE UNIQUE INDEX `owner_key` ON `operations` (`owner_id`,`idempotency_key`)" },
  { type: "index", name: "owner_source", tbl_name: "operations", sql: "CREATE UNIQUE INDEX `owner_source` ON `operations` (`owner_id`,`source_event_id`)" },
  { type: "index", name: "recognitions_owner_created", tbl_name: "image_recognitions", sql: "CREATE INDEX `recognitions_owner_created` ON `image_recognitions` (`owner_id`,`created_at`)" },
  { type: "index", name: "recognitions_owner_fingerprint", tbl_name: "image_recognitions", sql: "CREATE INDEX `recognitions_owner_fingerprint` ON `image_recognitions` (`owner_id`,`fingerprint`)" },
  ...["accounts", "image_recognitions", "images", "operations"].map((name) => ({
    type: "index", name: `sqlite_autoindex_${name}_1`, tbl_name: name, sql: null,
  })),
];

const columnSpecs = {
  accounts: ["id", "display_name", "created_at", "status"],
  ledgers: ["id", "owner_id", "revision", "data", "last_operation"],
  operations: ["id", "owner_id", "idempotency_key", "source_event_id", "payload_hash", "receipt", "created_at"],
  images: ["id", "owner_id", "sha256", "mime_type", "byte_size", "uploaded_at", "bytes"],
  image_recognitions: ["id", "owner_id", "fingerprint", "state", "result_json", "error_code", "created_at", "finished_at"],
} as const;

type ExportCell = { type: "text" | "blob"; hex: string } | { type: "integer"; value: string } | { type: "null" };
type AnyRow = Record<string, unknown>;

export class AccountBackupTooLargeError extends Error {
  constructor() {
    super("账号备份超过 12,000,000 字节上限；未返回部分内容。");
    this.name = "AccountBackupTooLargeError";
  }
}

function textCell(value: unknown): ExportCell {
  if (typeof value !== "string") throw new Error("Invalid text value in account backup.");
  return { type: "text", hex: Buffer.from(value, "utf8").toString("hex").toUpperCase() };
}

function timestampCell(value: unknown): ExportCell {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid timestamp in account backup.");
  return textCell(date.toISOString());
}

function integerCell(value: unknown): ExportCell {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Invalid integer in account backup.");
  return { type: "integer", value: String(number) };
}

function nullableTextCell(value: unknown): ExportCell {
  return value == null ? { type: "null" } : textCell(String(value));
}

function blobCell(value: Buffer): ExportCell {
  return { type: "blob", hex: value.toString("hex").toUpperCase() };
}

function rowCells(table: keyof typeof columnSpecs, rows: unknown[][]): ExportCell[][] {
  return rows.map((row) => row.map((value, i) => {
    if ((table === "ledgers" && (i === 0 || i === 2)) || (table === "images" && i === 4)) return integerCell(value);
    if (table === "images" && i === 6) {
      if (!Buffer.isBuffer(value)) throw new Error("Image bytes are missing from account backup.");
      return blobCell(value);
    }
    if (table === "image_recognitions" && i === 7) return value == null ? { type: "null" } : timestampCell(value);
    if (table === "image_recognitions" && [4, 5].includes(i)) return nullableTextCell(value);
    if ((table === "accounts" && i === 2) || (table === "operations" && i === 6) || (table === "images" && i === 5) || (table === "image_recognitions" && i === 6)) return timestampCell(value);
    if ((table === "ledgers" && i === 3) || (table === "operations" && i === 5)) {
      const json = typeof value === "string" ? value : JSON.stringify(value);
      if (typeof json !== "string") throw new Error("Invalid JSON value in account backup.");
      return textCell(json);
    }
    return textCell(String(value));
  }));
}

function cellRawBytes(cell: ExportCell): number {
  return "hex" in cell ? cell.hex.length / 2 : "value" in cell ? Buffer.byteLength(cell.value) : 0;
}

export function buildAccountBackupSnapshot(input: {
  account: AnyRow;
  ledger?: AnyRow;
  operations: AnyRow[];
  images: Array<AnyRow & { bytes: Buffer }>;
  recognitions: AnyRow[];
}): Record<string, unknown> {
  const account = input.account;
  const rows = {
    accounts: rowCells("accounts", [[account.id, account.display_name, account.created_at, account.status]]),
    ledgers: rowCells("ledgers", input.ledger ? [[1, input.ledger.owner_id, input.ledger.revision, input.ledger.data_raw ?? input.ledger.data, input.ledger.last_operation]] : []),
    operations: rowCells("operations", input.operations.map((row) => [row.operation_id, row.owner_id, row.idempotency_key, row.source_event_id, row.payload_hash, row.receipt_raw ?? row.receipt, row.created_at])),
    images: rowCells("images", input.images.map((row) => [row.id, row.owner_id, row.sha256, row.mime_type, row.byte_size, row.uploaded_at, row.bytes])),
    image_recognitions: rowCells("image_recognitions", input.recognitions.map((row) => [row.id, row.owner_id, row.fingerprint, row.state, row.result_json, row.error_code, row.created_at, row.finished_at])),
  };
  const totalBytes = Object.values(rows).flat(2).reduce((sum, cell) => sum + cellRawBytes(cell), 0);
  if (totalBytes > MAX_BYTES) throw new AccountBackupTooLargeError();

  const counts = Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, values.length]));
  const tables = Object.fromEntries(Object.entries(rows).map(([name, values]) => [
    name,
    {
      columns: columnSpecs[name as keyof typeof columnSpecs].map((column, index) => ({ name: column, pk: index === 0 ? 1 : 0, hidden: 0 })),
      rows: values,
    },
  ]));
  return {
    format: "d1-account-snapshot-v1",
    captured_at: new Date().toISOString(),
    complete: true,
    scope: "authenticated-account",
    schema: LEGACY_BACKUP_SCHEMA,
    row_counts: counts,
    tables,
  };
}
