import { createHash, randomUUID } from "node:crypto";

type QueryResult<Row> = { rows: Row[] };
type ImportClient = {
  query<Row = Record<string, unknown>>(sql: string, values?: any[]): Promise<QueryResult<Row>>;
  release(): void;
};
type ImportPool = {
  query<Row = Record<string, unknown>>(sql: string, values?: any[]): Promise<QueryResult<Row>>;
  connect(): Promise<ImportClient>;
};

export const ACCOUNT_SNAPSHOT_FORMAT = "d1-account-snapshot-v1";
const TABLES = ["accounts", "ledgers", "operations", "images", "image_recognitions"] as const;
const MAX_SNAPSHOT_BYTES = 12_000_000;
const MAX_JSON_BYTES = 40_000_000;

type Cell =
  | { type: "text" | "blob"; hex: string }
  | { type: "integer" | "real"; value: string }
  | { type: "null" };
type SnapshotRow = Cell[];
type LegacySnapshot = {
  format: string;
  scope: string;
  complete: boolean;
  captured_at: string;
  schema: Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  row_counts: Record<string, number>;
  tables: Record<string, { columns: Array<{ name: string; pk: number; hidden: number }>; rows: SnapshotRow[] }>;
};

export class AccountImportError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = "AccountImportError";
  }
}

export type ImportImage = {
  id: string;
  sha256: string;
  mimeType: string;
  byteSize: number;
  uploadedAt: string;
  bytes: Buffer;
  fileName?: string;
};

export type ImportLibraryFile = {
  libraryId: string;
  sourceFileId: string;
  sourceVersion: string;
  sourceVersionType: "string" | "number";
  libraryRef: string;
  versionId: string | null;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  bytes: Buffer | null;
  documentId?: string;
};

export type FileReferencePreview = {
  library_ref: string;
  version_id: string | null;
  document_id?: string;
  origin?: "current" | "history";
};

export type AccountFileValidation = {
  current_references: { total: number; covered: number };
  history_references: { total: number; covered: number };
  missing_references: FileReferencePreview[];
  ambiguous_references: FileReferencePreview[];
  missing_image_references: string[];
  missing_files: Array<{ file_name: string; library_ref?: string; version_id?: string }>;
  extra_uploads: string[];
  unreferenced_files: Array<{ file_name: string; library_ref: string; version_id: string | null }>;
  size_errors: Array<{ file_name: string; expected: number; actual: number }>;
  hash_errors: Array<{ file_name: string; expected: string; actual: string }>;
  type_errors: Array<{ file_name: string; mime_type: string }>;
  mapping_errors: string[];
  can_import: boolean;
};

export type PreparedAccountImport = {
  importId: string;
  digest: string;
  sourceAccountId: string;
  sourceAccountHash: string;
  displayName: string;
  sourceAccountCreatedAt: string;
  capturedAt: string;
  rowCounts: Record<string, number>;
  snapshotBytes: number;
  ledger: null | { revision: number; data: Record<string, unknown>; dataRaw: string; lastOperation: string };
  operations: Array<{
    operationId: string;
    idempotencyKey: string;
    sourceEventId: string;
    payloadHash: string;
    receipt: Record<string, unknown>;
    receiptRaw: string;
    createdAt: string;
  }>;
  images: ImportImage[];
  files: ImportLibraryFile[];
  fileValidation: AccountFileValidation;
  recognitions: Array<{
    id: string;
    fingerprint: string;
    state: string;
    resultJson: string | null;
    errorCode: string | null;
    createdAt: string;
    finishedAt: string | null;
  }>;
};

const columns: Record<(typeof TABLES)[number], string[]> = {
  accounts: ["id", "display_name", "created_at", "status"],
  ledgers: ["id", "owner_id", "revision", "data", "last_operation"],
  operations: ["id", "owner_id", "idempotency_key", "source_event_id", "payload_hash", "receipt", "created_at"],
  images: ["id", "owner_id", "sha256", "mime_type", "byte_size", "uploaded_at", "bytes"],
  image_recognitions: ["id", "owner_id", "fingerprint", "state", "result_json", "error_code", "created_at", "finished_at"],
};

const trustedSchema = [
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
    type: "index",
    name: `sqlite_autoindex_${name}_1`,
    tbl_name: name,
    sql: null,
  })),
];
export const LEGACY_ACCOUNT_BACKUP_SCHEMA = trustedSchema;
export const LEGACY_ACCOUNT_BACKUP_COLUMNS = columns;

function fail(message: string, code = "INVALID_BACKUP", status = 400): never {
  throw new AccountImportError(status, code, message);
}

function checkNoDuplicateJsonKeys(text: string): void {
  let i = 0;
  let depth = 0;
  const ws = () => { while (/\s/.test(text[i] ?? "")) i++; };
  const stringToken = (): string => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i++] === '"') break;
    }
    if (text[i - 1] !== '"') fail("备份 JSON 字符串未闭合。");
    try { return JSON.parse(text.slice(start, i)) as string; }
    catch { return ""; }
  };
  const value = (): void => {
    ws();
    if (++depth > 100) fail("备份 JSON 嵌套过深。");
    if (text[i] === "{") {
      i++;
      ws();
      const keys = new Set<string>();
      if (text[i] !== "}") {
        while (i < text.length) {
          ws();
          if (text[i] !== '"') fail("备份 JSON 对象格式无效。");
          const key = stringToken();
          if (keys.has(key)) fail("备份 JSON 含有重复字段。");
          keys.add(key);
          ws();
          if (text[i++] !== ":") fail("备份 JSON 对象格式无效。");
          value();
          ws();
          if (text[i] === "}") break;
          if (text[i++] !== ",") fail("备份 JSON 对象格式无效。");
        }
      }
      if (text[i++] !== "}") fail("备份 JSON 对象未闭合。");
    } else if (text[i] === "[") {
      i++;
      ws();
      if (text[i] !== "]") {
        while (i < text.length) {
          value();
          ws();
          if (text[i] === "]") break;
          if (text[i++] !== ",") fail("备份 JSON 数组格式无效。");
        }
      }
      if (text[i++] !== "]") fail("备份 JSON 数组未闭合。");
    } else if (text[i] === '"') {
      stringToken();
    } else {
      const start = i;
      while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
      if (start === i) fail("备份 JSON 值格式无效。");
    }
    depth--;
  };
  value();
  ws();
  if (i !== text.length) fail("备份 JSON 含有额外内容。");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function decodeCell(cell: unknown, expected: "text" | "blob" | "integer" | "real" | "nullable-text"): string | Buffer | number | null {
  if (!isRecord(cell) || typeof cell.type !== "string") fail("备份单元格格式无效。");
  if (cell.type === "null" && Object.keys(cell).length === 1 && expected === "nullable-text") return null;
  if ((cell.type === "text" || cell.type === "blob") && typeof cell.hex === "string" && Object.keys(cell).length === 2) {
    if (!/^(?:[0-9A-F]{2})*$/.test(cell.hex)) fail("备份文本或附件的十六进制编码无效。");
    const bytes = Buffer.from(cell.hex, "hex");
    if (expected === "nullable-text" ? cell.type !== "text" : cell.type !== expected) fail("备份字段类型与已知格式不匹配。");
    if (cell.type === "blob") return bytes;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { fail("备份文本不是有效 UTF-8。"); }
  }
  if ((cell.type === "integer" || cell.type === "real") && typeof cell.value === "string" && Object.keys(cell).length === 2) {
    if (cell.type !== expected || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(cell.value)) fail("备份数字格式无效。");
    const number = Number(cell.value);
    if (!Number.isFinite(number) || (cell.type === "integer" && !Number.isSafeInteger(number))) fail("备份数字超出可安全迁移范围。");
    return number;
  }
  fail("备份单元格类型无效。");
}

function readRow(snapshot: LegacySnapshot, table: (typeof TABLES)[number], index: number): unknown[] {
  const row = snapshot.tables[table]?.rows[index];
  if (!Array.isArray(row) || row.length !== columns[table].length) fail(`备份 ${table} 行宽与格式不符。`);
  return row.map((cell, i) => {
    if (table === "images" && i === 6) return decodeCell(cell, "blob");
    if (table === "images" && i === 4 || table === "ledgers" && (i === 0 || i === 2)) return decodeCell(cell, "integer");
    if (table === "image_recognitions" && [4, 5, 7].includes(i)) return decodeCell(cell, "nullable-text");
    return decodeCell(cell, "text");
  });
}

function validDate(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > 80 || !Number.isFinite(Date.parse(value))) fail(`${label}时间格式无效。`);
  return value;
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string" || value.length > MAX_SNAPSHOT_BYTES) fail(`${label}不是有效 JSON。`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail(`${label}不是有效 JSON。`); }
  if (!isRecord(parsed)) fail(`${label}必须是对象。`);
  return parsed;
}

function hash(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function validImageBytes(bytes: Buffer, mime: string): boolean {
  if (mime === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/webp") return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

const FILE_MIME_BY_EXTENSION: Record<string, string[]> = {
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".pdf": ["application/pdf"],
  ".html": ["text/html"],
  ".htm": ["text/html"],
  ".md": ["text/markdown", "text/x-markdown", "text/plain"],
  ".markdown": ["text/markdown", "text/x-markdown", "text/plain"],
  ".txt": ["text/plain"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".png": ["image/png"],
  ".webp": ["image/webp"],
};

function safeUploadName(name: string): boolean {
  return name.length > 0 && name.length <= 300 && name !== "." && name !== ".." &&
    !name.includes("/") && !name.includes("\\") && !/[\u0000-\u001f\u007f]/.test(name);
}

function validLibraryFileBytes(bytes: Buffer, name: string, mime: string): boolean {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (!FILE_MIME_BY_EXTENSION[extension]?.includes(mime)) return false;
  if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp") return validImageBytes(bytes, mime);
  if (mime === "application/pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return bytes.length >= 32 &&
      bytes[0] === 0x50 && bytes[1] === 0x4b &&
      bytes.includes(Buffer.from("[Content_Types].xml")) &&
      bytes.includes(Buffer.from("word/document.xml"));
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

type SourceFileRef = FileReferencePreview;

function collectLibraryReferences(value: unknown): SourceFileRef[] {
  const refs: SourceFileRef[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, inVersions = false, documentId?: string): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, inVersions, documentId);
      return;
    }
    if (!isRecord(node)) return;
    const currentDocumentId = typeof node.id === "string" && Array.isArray(node.versions) ? node.id : documentId;
    if (typeof node.library_ref === "string" && /^libfile_[A-Za-z0-9]+$/.test(node.library_ref)) {
      const versionId = typeof node.version_id === "string"
        ? node.version_id
        : inVersions && typeof node.id === "string" ? node.id : null;
      const key = libraryFileKey(node.library_ref, versionId);
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ library_ref: node.library_ref, version_id: versionId, ...(currentDocumentId ? { document_id: currentDocumentId } : {}) });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      visit(child, key === "versions", currentDocumentId);
    }
  };
  visit(value);
  return refs;
}

function libraryFileKey(libraryRef: string, versionId: string | null): string {
  return JSON.stringify([libraryRef, versionId]);
}

function collectBareLibraryReferencesFromText(value: unknown): SourceFileRef[] {
  const refs = new Map<string, SourceFileRef>();
  const structuredIdentifierFields = new Set([
    "id",
    "version_id",
    "library_ref",
    "library_id",
    "file_id",
    "source_library_id",
    "source_file_id",
    "document_id",
    "operation_id",
    "filename",
    "file_name",
  ]);
  const visit = (node: unknown, key?: string): void => {
    if (typeof node === "string") {
      if (key && structuredIdentifierFields.has(key)) return;
      for (const match of node.matchAll(/\blibfile_[A-Za-z0-9]+\b/g)) {
        const ref = match[0];
        refs.set(libraryFileKey(ref, null), { library_ref: ref, version_id: null });
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child, key);
      return;
    }
    if (isRecord(node)) {
      for (const [childKey, child] of Object.entries(node)) visit(child, childKey);
    }
  };
  visit(value);
  return [...refs.values()];
}

function emptyFileValidation(): AccountFileValidation {
  return {
    current_references: { total: 0, covered: 0 },
    history_references: { total: 0, covered: 0 },
    missing_references: [],
    ambiguous_references: [],
    missing_image_references: [],
    missing_files: [],
    extra_uploads: [],
    unreferenced_files: [],
    size_errors: [],
    hash_errors: [],
    type_errors: [],
    mapping_errors: [],
    can_import: false,
  };
}

function validateManifestAndFiles(
  manifestFile: { originalname: string; buffer: Buffer } | undefined,
  attachments: Array<{ originalname: string; buffer: Buffer }>,
  images: ImportImage[],
  currentRefs: SourceFileRef[],
  historyRefs: SourceFileRef[],
): { files: ImportLibraryFile[]; validation: AccountFileValidation } {
  const validation = emptyFileValidation();
  const usedUploads = new Set<number>();
  const findUpload = (fileName: string, expectedHash: string, expectedSize: number): Buffer | null => {
    const candidates = attachments
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => item.originalname === fileName && !usedUploads.has(index));
    if (!candidates.length) {
      validation.missing_files.push({ file_name: fileName });
      return null;
    }
    const exact = candidates.find(({ item }) => item.buffer.length === expectedSize && hash(item.buffer) === expectedHash);
    const chosen = exact ?? candidates[0];
    usedUploads.add(chosen.index);
    const actualSize = chosen.item.buffer.length;
    const actualHash = hash(chosen.item.buffer);
    if (actualSize !== expectedSize) validation.size_errors.push({ file_name: fileName, expected: expectedSize, actual: actualSize });
    if (actualHash !== expectedHash) validation.hash_errors.push({ file_name: fileName, expected: expectedHash, actual: actualHash });
    return chosen.item.buffer;
  };

  let rawManifest: Record<string, unknown> | undefined;
  let manifestKind: "legacy-images" | "complete" | undefined;
  if (manifestFile) {
    if (manifestFile.buffer.length > 1_000_000) fail("附件清单超过 1 MB。");
    const text = manifestFile.buffer.toString("utf8");
    checkNoDuplicateJsonKeys(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed)) fail("附件清单格式无效。");
      if (parsed.format === "project-ledger-attachment-manifest-v1" &&
          Object.keys(parsed).sort().join(",") === "files,format" && Array.isArray(parsed.files)) {
        rawManifest = parsed;
        manifestKind = "legacy-images";
      } else if (parsed.format === "project-ledger-complete-file-manifest-v1" &&
          Object.keys(parsed).sort().join(",") === "files,format,images" &&
          Array.isArray(parsed.files) && Array.isArray(parsed.images)) {
        rawManifest = parsed;
        manifestKind = "complete";
      } else {
        fail("附件清单格式不受支持。");
      }
    } catch (error) {
      if (error instanceof AccountImportError) throw error;
      fail("附件清单 JSON 无法解析。");
    }
  } else if (attachments.length) {
    validation.extra_uploads.push(...attachments.map((item) => item.originalname));
  }

  const imageEntries = rawManifest
    ? (manifestKind === "legacy-images" ? rawManifest.files : rawManifest.images) as unknown[]
    : [];
  if (manifestKind === "legacy-images" && imageEntries.length !== images.length) {
    validation.mapping_errors.push("图片清单数量与快照图片数量不一致。");
  }
  const seenImages = new Set<string>();
  for (const rawEntry of imageEntries) {
    if (!isRecord(rawEntry) || Object.keys(rawEntry).sort().join(",") !== "byte_size,file_name,image_id,mime_type,sha256" ||
      typeof rawEntry.image_id !== "string" || typeof rawEntry.file_name !== "string" ||
      typeof rawEntry.sha256 !== "string" || typeof rawEntry.mime_type !== "string" ||
      !Number.isSafeInteger(rawEntry.byte_size)) {
      validation.mapping_errors.push("图片清单条目字段无效。");
      continue;
    }
    const image = images.find((candidate) => candidate.id === rawEntry.image_id);
    if (seenImages.has(rawEntry.image_id) || !image || !safeUploadName(rawEntry.file_name) ||
      rawEntry.sha256.toLowerCase() !== image.sha256 || rawEntry.mime_type !== image.mimeType ||
      rawEntry.byte_size !== image.byteSize) {
      validation.mapping_errors.push(`图片清单与快照不匹配：${rawEntry.file_name}`);
      continue;
    }
    seenImages.add(rawEntry.image_id);
    const bytes = findUpload(rawEntry.file_name, image.sha256, image.byteSize);
    if (bytes && !validImageBytes(bytes, image.mimeType)) {
      validation.type_errors.push({ file_name: rawEntry.file_name, mime_type: image.mimeType });
    }
    image.fileName = rawEntry.file_name;
  }
  if (manifestKind === "complete" && seenImages.size !== images.length) {
    const missing = images.filter((image) => !seenImages.has(image.id));
    for (const image of missing) validation.mapping_errors.push(`完整清单缺少快照图片：${image.id}`);
  }

  const files: ImportLibraryFile[] = [];
  const manifestEntries = rawManifest && manifestKind === "complete" ? rawManifest.files as unknown[] : [];
  const fileKeys = new Set<string>();
  for (const rawEntry of manifestEntries) {
    const requiredKeys = "byte_size,file_id,file_name,library_id,library_ref,mime_type,sha256,version,version_id";
    if (!isRecord(rawEntry) || Object.keys(rawEntry).sort().join(",") !== requiredKeys ||
      typeof rawEntry.library_id !== "string" || typeof rawEntry.file_id !== "string" ||
      typeof rawEntry.library_ref !== "string" ||
      (typeof rawEntry.version_id !== "string" && rawEntry.version_id !== null) ||
      typeof rawEntry.file_name !== "string" || typeof rawEntry.mime_type !== "string" ||
      typeof rawEntry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(rawEntry.sha256) ||
      !Number.isSafeInteger(rawEntry.byte_size) ||
      (typeof rawEntry.version !== "string" && typeof rawEntry.version !== "number")) {
      validation.mapping_errors.push("Library 文件清单条目字段无效。");
      continue;
    }
    const { library_id: libraryId, file_id: sourceFileId, library_ref: libraryRef, version_id: versionId, file_name: fileName, mime_type: mimeType } = rawEntry;
    const sourceVersionType = typeof rawEntry.version as "string" | "number";
    const sourceVersion = String(rawEntry.version);
    const fileHash = rawEntry.sha256.toLowerCase();
    const byteSize = rawEntry.byte_size as number;
    const identity = libraryFileKey(libraryRef, versionId);
    if (!libraryId || libraryId.length > 255 || !sourceFileId || sourceFileId.length > 255 ||
      !/^libfile_[A-Za-z0-9]+$/.test(libraryRef) ||
      (versionId !== null && (!versionId || versionId.length > 255)) ||
      !sourceVersion || sourceVersion.length > 100 || !safeUploadName(fileName) ||
      !/^[a-f0-9]{64}$/.test(fileHash) || byteSize < 0 || byteSize > 64_000_000) {
      validation.mapping_errors.push(`Library 文件清单标识或元数据无效：${fileName || "未命名文件"}`);
      continue;
    }
    if (fileKeys.has(identity)) {
      validation.mapping_errors.push(`Library 引用及版本重复：${libraryRef} / ${versionId ?? "无账本版本"}`);
      continue;
    }
    fileKeys.add(identity);
    const bytes = findUpload(fileName, fileHash, byteSize);
    if (!FILE_MIME_BY_EXTENSION[fileName.slice(fileName.lastIndexOf(".")).toLowerCase()]?.includes(mimeType) ||
      (bytes && !validLibraryFileBytes(bytes, fileName, mimeType))) {
      validation.type_errors.push({ file_name: fileName, mime_type: mimeType });
    }
    files.push({
      libraryId, sourceFileId, sourceVersion, sourceVersionType, libraryRef, versionId,
      fileName, mimeType, byteSize, sha256: fileHash, bytes,
    });
  }

  validation.extra_uploads.push(...attachments
    .map((item, index) => usedUploads.has(index) ? null : item.originalname)
    .filter((name): name is string => name !== null));

  const checkCoverage = (refs: SourceFileRef[], origin: "current" | "history") => {
    const covered = new Set<string>();
    for (const ref of refs) {
      const candidates = files.filter((file) => file.libraryRef === ref.library_ref &&
        (ref.version_id === null || file.versionId === ref.version_id));
      if (candidates.length === 1) {
        covered.add(libraryFileKey(ref.library_ref, ref.version_id));
      } else if (candidates.length === 0) {
        validation.missing_references.push({ ...ref, origin });
      } else {
        validation.ambiguous_references.push({ ...ref, origin });
      }
    }
    return { total: refs.length, covered: covered.size };
  };
  validation.current_references = checkCoverage(currentRefs, "current");
  validation.history_references = checkCoverage(historyRefs, "history");
  const referencedKeys = new Set([...currentRefs, ...historyRefs].flatMap((ref) =>
    files.filter((file) => file.libraryRef === ref.library_ref &&
      (ref.version_id === null || file.versionId === ref.version_id))
      .map((file) => libraryFileKey(file.libraryRef, file.versionId)),
  ));
  validation.unreferenced_files = files
    .filter((file) => !referencedKeys.has(libraryFileKey(file.libraryRef, file.versionId)))
    .map(({ fileName, libraryRef, versionId }) => ({ file_name: fileName, library_ref: libraryRef, version_id: versionId }));

  validation.can_import = validation.missing_references.length === 0 &&
    validation.ambiguous_references.length === 0 && validation.missing_files.length === 0 &&
    validation.missing_image_references.length === 0 &&
    validation.extra_uploads.length === 0 && validation.size_errors.length === 0 &&
    validation.hash_errors.length === 0 && validation.type_errors.length === 0 &&
    validation.mapping_errors.length === 0;
  return { files, validation };
}

function collectMissingImageReferences(value: unknown, imageIds: Set<string>, missing: Set<string>): void {
  if (Array.isArray(value)) { for (const child of value) collectMissingImageReferences(child, imageIds, missing); return; }
  if (!isRecord(value)) return;
  if (Object.hasOwn(value, "attachment_ids")) {
    const ids = value.attachment_ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) fail("备份中的图片附件引用格式无效。");
    for (const id of ids as string[]) if (!imageIds.has(id)) missing.add(id);
  }
  for (const child of Object.values(value)) collectMissingImageReferences(child, imageIds, missing);
}

type SchemaSqlToken = { kind: "word" | "identifier" | "string" | "symbol"; value: string };
type ParsedSchemaSql =
  | { kind: "table"; name: string; columns: Array<{ name: string; type: string; primaryKey: boolean; notNull: boolean }> }
  | { kind: "index"; name: string; table: string; unique: boolean; columns: string[] };

function tokenizeSchemaSql(sql: string): SchemaSqlToken[] | null {
  const tokens: SchemaSqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }

    if (char === "`" || char === '"' || char === "[") {
      const closing = char === "[" ? "]" : char;
      index++;
      let value = "";
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === closing) {
          if (sql[index + 1] === closing) {
            value += closing;
            index += 2;
            continue;
          }
          index++;
          closed = true;
          break;
        }
        value += sql[index++];
      }
      if (!closed || !value) return null;
      tokens.push({ kind: "identifier", value: value.toLowerCase() });
      continue;
    }

    if (char === "'") {
      index++;
      let value = "";
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          index++;
          closed = true;
          break;
        }
        value += sql[index++];
      }
      if (!closed) return null;
      tokens.push({ kind: "string", value });
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index++;
      tokens.push({ kind: "word", value: sql.slice(start, index).toLowerCase() });
      continue;
    }

    tokens.push({ kind: "symbol", value: char });
    index++;
  }
  return tokens;
}

function parseSchemaSql(sql: string): ParsedSchemaSql | null {
  const tokens = tokenizeSchemaSql(sql);
  if (!tokens) return null;
  let index = 0;
  const current = () => tokens[index];
  const takeWord = (word: string): boolean => {
    if (current()?.kind !== "word" || current()?.value !== word) return false;
    index++;
    return true;
  };
  const takeSymbol = (symbol: string): boolean => {
    if (current()?.kind !== "symbol" || current()?.value !== symbol) return false;
    index++;
    return true;
  };
  const takeIdentifier = (): string | null => {
    const token = current();
    if (!token || (token.kind !== "word" && token.kind !== "identifier")) return null;
    index++;
    return token.value;
  };
  const finish = (): boolean => {
    if (takeSymbol(";")) return index === tokens.length;
    return index === tokens.length;
  };

  if (!takeWord("create")) return null;
  let unique = false;
  if (takeWord("unique")) unique = true;

  if (takeWord("table")) {
    if (unique) return null;
    const name = takeIdentifier();
    if (!name || !takeSymbol("(")) return null;
    const columns: Array<{ name: string; type: string; primaryKey: boolean; notNull: boolean }> = [];
    while (index < tokens.length) {
      const columnName = takeIdentifier();
      const type = takeIdentifier();
      if (!columnName || !type) return null;
      let primaryKey = false;
      let notNull = false;
      while (current()?.kind === "word") {
        if (takeWord("primary")) {
          if (primaryKey || !takeWord("key")) return null;
          primaryKey = true;
        } else if (takeWord("not")) {
          if (notNull || !takeWord("null")) return null;
          notNull = true;
        } else {
          break;
        }
      }
      columns.push({ name: columnName, type, primaryKey, notNull });
      if (takeSymbol(",")) continue;
      if (!takeSymbol(")")) return null;
      break;
    }
    if (!columns.length || !finish()) return null;
    return { kind: "table", name, columns };
  }

  if (takeWord("index")) {
    const name = takeIdentifier();
    if (!name || !takeWord("on")) return null;
    const table = takeIdentifier();
    if (!table || !takeSymbol("(")) return null;
    const indexColumns: string[] = [];
    while (index < tokens.length) {
      const column = takeIdentifier();
      if (!column) return null;
      indexColumns.push(column);
      if (takeSymbol(",")) continue;
      if (!takeSymbol(")")) return null;
      break;
    }
    if (!indexColumns.length || !finish()) return null;
    return { kind: "index", name, table, unique, columns: indexColumns };
  }
  return null;
}

function validateSchema(snapshot: LegacySnapshot): void {
  if (!Array.isArray(snapshot.schema) || snapshot.schema.length !== trustedSchema.length) fail("快照数据库结构不是受支持的账号备份结构。");
  const expectedByKey = new Map(trustedSchema.map((entry) => [
    `${entry.type.toLowerCase()}\u0000${entry.name.toLowerCase()}`,
    entry,
  ]));
  const seen = new Set<string>();
  for (const entry of snapshot.schema) {
    if (!isRecord(entry) || Object.keys(entry).sort().join(",") !== "name,sql,tbl_name,type") fail("快照数据库结构记录格式无效。");
    if (typeof entry.type !== "string" || typeof entry.name !== "string" || typeof entry.tbl_name !== "string" ||
      (typeof entry.sql !== "string" && entry.sql !== null)) {
      fail("快照数据库结构记录格式无效。");
    }
    const key = `${entry.type.toLowerCase()}\u0000${entry.name.toLowerCase()}`;
    const expected = expectedByKey.get(key);
    if (!expected || seen.has(key) || entry.tbl_name.toLowerCase() !== expected.tbl_name.toLowerCase()) {
      fail("快照数据库结构与受支持的账号备份格式不一致。");
    }
    seen.add(key);

    if (expected.sql === null) {
      if (entry.sql !== null) fail("快照数据库结构与受支持的账号备份格式不一致。");
      continue;
    }
    if (typeof entry.sql !== "string") fail("快照数据库结构与受支持的账号备份格式不一致。");
    const actualDefinition = parseSchemaSql(entry.sql);
    const expectedDefinition = parseSchemaSql(expected.sql);
    if (!actualDefinition || !expectedDefinition ||
      JSON.stringify(actualDefinition) !== JSON.stringify(expectedDefinition) ||
      (actualDefinition.kind === "table" && (entry.type.toLowerCase() !== "table" || actualDefinition.name !== entry.name.toLowerCase())) ||
      (actualDefinition.kind === "index" && (entry.type.toLowerCase() !== "index" ||
        actualDefinition.name !== entry.name.toLowerCase() || actualDefinition.table !== entry.tbl_name.toLowerCase()))) {
      fail("快照数据库结构与受支持的账号备份格式不一致。");
    }
  }
  if (seen.size !== expectedByKey.size) fail("快照数据库结构与受支持的账号备份格式不一致。");

  for (const table of TABLES) {
    const cols = snapshot.tables[table]?.columns;
    const expectedCols = columns[table].map((name, i) => ({
      name,
      pk: i === 0 ? 1 : 0,
      hidden: 0,
    }));
    if (!Array.isArray(cols) || cols.length !== expectedCols.length ||
      cols.some((column, index) => !isRecord(column) ||
        Object.keys(column).sort().join(",") !== "hidden,name,pk" ||
        typeof column.name !== "string" ||
        column.name.toLowerCase() !== expectedCols[index].name.toLowerCase() ||
        column.pk !== expectedCols[index].pk ||
        column.hidden !== expectedCols[index].hidden)) {
      fail(`备份 ${table} 列结构不匹配。`);
    }
  }
}

export function parseAccountSnapshot(
  snapshotText: string,
  manifestFile?: { originalname: string; buffer: Buffer },
  attachmentFiles: Array<{ originalname: string; buffer: Buffer }> = [],
): PreparedAccountImport {
  if (Buffer.byteLength(snapshotText, "utf8") > MAX_JSON_BYTES) fail("账号快照超过 40 MB 上限。", "BACKUP_TOO_LARGE", 413);
  checkNoDuplicateJsonKeys(snapshotText);
  let raw: unknown;
  try { raw = JSON.parse(snapshotText); } catch { fail("账号快照 JSON 无法解析。"); }
  if (!isRecord(raw) || raw.format !== ACCOUNT_SNAPSHOT_FORMAT || raw.scope !== "authenticated-account" || raw.complete !== true) {
    fail("只支持完整的本人账号快照 d1-account-snapshot-v1。");
  }
  const rootKeys = ["captured_at", "complete", "format", "row_counts", "schema", "scope", "tables"].sort();
  if (Object.keys(raw).sort().join(",") !== rootKeys.join(",")) fail("账号快照包含未知字段，无法安全迁入。");
  const snapshot = raw as unknown as LegacySnapshot;
  if (typeof snapshot.captured_at !== "string" || !Number.isFinite(Date.parse(snapshot.captured_at))) fail("快照缺少有效的生成时间。");
  const expectedTableNames = [...TABLES].sort();
  if (!isRecord(snapshot.tables) || !isRecord(snapshot.row_counts) || Object.keys(snapshot.tables).sort().join(",") !== expectedTableNames.join(",") || Object.keys(snapshot.row_counts).sort().join(",") !== expectedTableNames.join(",")) fail("快照表清单不完整。");
  validateSchema(snapshot);

  let total = 0;
  for (const table of TABLES) {
    if (!isRecord(snapshot.tables[table]) || Object.keys(snapshot.tables[table]).sort().join(",") !== "columns,rows") fail(`备份 ${table} 表结构含有未知字段。`);
    const rows = snapshot.tables[table]?.rows;
    const count = snapshot.row_counts[table];
    if (!Array.isArray(rows) || !Number.isSafeInteger(count) || count !== rows.length) fail(`备份 ${table} 行数校验失败。`);
    for (const row of rows) {
      if (!Array.isArray(row)) fail(`备份 ${table} 行格式无效。`);
      for (const cell of row) {
        if (cell.type === "text" || cell.type === "blob") total += cell.hex.length / 2;
        else if (cell.type === "integer" || cell.type === "real") total += Buffer.byteLength(cell.value, "utf8");
      }
    }
  }
  if (total > MAX_SNAPSHOT_BYTES) fail("账号快照超过 12,000,000 字节上限。", "BACKUP_TOO_LARGE", 413);
  if (snapshot.row_counts.accounts !== 1 || snapshot.row_counts.ledgers > 1) fail("快照必须只包含一个账号和至多一个账本。");

  const account = readRow(snapshot, "accounts", 0);
  const sourceAccountId = account[0];
  const displayName = account[1];
  if (typeof sourceAccountId !== "string" || !sourceAccountId || sourceAccountId.length > 255 || typeof displayName !== "string" || typeof account[3] !== "string" || account[3] !== "active") fail("来源账号无效或已停用。");
  validDate(account[2], "账号创建");

  let ledger: PreparedAccountImport["ledger"] = null;
  if (snapshot.row_counts.ledgers) {
    const row = readRow(snapshot, "ledgers", 0);
    if (row[1] !== sourceAccountId || typeof row[0] !== "number" || !Number.isSafeInteger(row[0]) || typeof row[2] !== "number" || !Number.isSafeInteger(row[2]) || row[2] < 0 || typeof row[4] !== "string") fail("账本行归属或版本无效。");
    const data = parseJsonObject(row[3], "账本数据");
    if (!Array.isArray(data.projects) || !Array.isArray(data.tasks) || !Array.isArray(data.documents) || !Array.isArray(data.pending) || !isRecord(data.settings) || !Array.isArray(data.reminderLog)) fail("账本数据缺少受支持的项目簿字段。");
    ledger = { revision: row[2], data, dataRaw: row[3] as string, lastOperation: row[4] };
  }

  const operations: PreparedAccountImport["operations"] = [];
  const opIds = new Set<string>(); const idempotency = new Set<string>(); const sourceEvents = new Set<string>();
  for (let i = 0; i < snapshot.row_counts.operations; i++) {
    const row = readRow(snapshot, "operations", i);
    const [id, owner, idempotencyKey, sourceEventId, payloadHash, receiptValue, createdAt] = row;
    if (owner !== sourceAccountId || typeof id !== "string" || !id || typeof idempotencyKey !== "string" || !idempotencyKey || typeof sourceEventId !== "string" || !sourceEventId || typeof payloadHash !== "string" || typeof createdAt !== "string") fail("操作历史行归属或字段无效。");
    if (opIds.has(id) || idempotency.has(idempotencyKey) || sourceEvents.has(sourceEventId)) fail("操作历史中存在重复编号。");
    opIds.add(id); idempotency.add(idempotencyKey); sourceEvents.add(sourceEventId);
    validDate(createdAt, "操作创建");
    const receipt = parseJsonObject(receiptValue, "操作回执");
    operations.push({ operationId: id, idempotencyKey, sourceEventId, payloadHash, receipt, receiptRaw: receiptValue as string, createdAt });
  }

  const images: ImportImage[] = [];
  const imageIds = new Set<string>(); const imageHashes = new Set<string>();
  for (let i = 0; i < snapshot.row_counts.images; i++) {
    const row = readRow(snapshot, "images", i);
    const [id, owner, sha256, mimeType, byteSize, uploadedAt, bytes] = row;
    if (owner !== sourceAccountId || typeof id !== "string" || !/^img_[a-f0-9]{64}$/.test(id) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256) || typeof mimeType !== "string" || typeof byteSize !== "number" || !Number.isSafeInteger(byteSize) || !(bytes instanceof Buffer)) fail("图片行归属或字段无效。");
    const normalizedHash = sha256.toLowerCase();
    if (imageIds.has(id) || imageHashes.has(normalizedHash) || id !== `img_${normalizedHash}` || byteSize !== bytes.length || hash(bytes) !== normalizedHash || !validImageBytes(bytes, mimeType)) fail("图片大小、格式或 SHA-256 校验失败。");
    imageIds.add(id); imageHashes.add(normalizedHash);
    images.push({ id, sha256: normalizedHash, mimeType, byteSize, uploadedAt: validDate(uploadedAt, "图片上传")!, bytes });
  }
  const missingImageReferences = new Set<string>();
  if (ledger) collectMissingImageReferences(ledger.data, imageIds, missingImageReferences);
  for (const operation of operations) collectMissingImageReferences(operation.receipt, imageIds, missingImageReferences);
  const currentRefs = ledger ? collectLibraryReferences(ledger.data.documents) : [];
  const historyRefs = operations.flatMap((operation) => {
    const structuredRefs = collectLibraryReferences(operation.receipt);
    const bareTextRefs = collectBareLibraryReferencesFromText(operation.receipt);
    return [...structuredRefs, ...bareTextRefs];
  });
  const uniqueRefs = (refs: SourceFileRef[]) => [...new Map(refs.map((ref) =>
    [libraryFileKey(ref.library_ref, ref.version_id), ref],
  )).values()];
  const { files, validation: fileValidation } = validateManifestAndFiles(
    manifestFile,
    attachmentFiles,
    images,
    uniqueRefs(currentRefs),
    uniqueRefs(historyRefs),
  );
  fileValidation.missing_image_references = [...missingImageReferences].sort();
  if (fileValidation.missing_image_references.length) fileValidation.can_import = false;

  const recognitions: PreparedAccountImport["recognitions"] = [];
  const recognitionIds = new Set<string>();
  for (let i = 0; i < snapshot.row_counts.image_recognitions; i++) {
    const row = readRow(snapshot, "image_recognitions", i);
    const [id, owner, fingerprint, state, resultJson, errorCode, createdAt, finishedAt] = row;
    if (owner !== sourceAccountId || typeof id !== "string" || !id || typeof fingerprint !== "string" || typeof state !== "string" || typeof resultJson !== "string" && resultJson !== null || typeof errorCode !== "string" && errorCode !== null) fail("图片识别历史归属或字段无效。");
    if (recognitionIds.has(id)) fail("图片识别历史编号重复。");
    recognitionIds.add(id);
    if (resultJson !== null) { try { JSON.parse(resultJson); } catch { fail("图片识别结果 JSON 无效。"); } }
    recognitions.push({
      id, fingerprint, state, resultJson, errorCode,
      createdAt: validDate(createdAt, "图片识别创建")!,
      finishedAt: validDate(finishedAt, "图片识别完成", true),
    });
  }

  const snapshotBuffer = Buffer.from(snapshotText, "utf8");
  const digestHash = createHash("sha256")
    .update(snapshotBuffer)
    .update(manifestFile?.buffer ?? Buffer.alloc(0));
  for (const attachment of [...attachmentFiles].sort((a, b) => a.originalname.localeCompare(b.originalname))) {
    digestHash.update(attachment.originalname);
    digestHash.update(attachment.buffer);
  }
  const digest = digestHash.digest("hex");
  return {
    importId: randomUUID(),
    digest,
    sourceAccountId,
    sourceAccountHash: hash(Buffer.from(sourceAccountId, "utf8")),
    displayName,
    sourceAccountCreatedAt: validDate(account[2], "账号创建")!,
    capturedAt: snapshot.captured_at,
    rowCounts: { ...snapshot.row_counts },
    snapshotBytes: total,
    ledger,
    operations,
    images,
    files,
    fileValidation,
    recognitions,
  };
}

export type ImportStorage = {
  writePrivateObject(path: string, bytes: Buffer, mimeType: string, ownerId: string): Promise<void>;
  deletePrivateObject(path: string): Promise<void>;
  verifyPrivateObject(path: string, bytes: Buffer, mimeType: string, ownerId: string): Promise<boolean>;
  writePrivateAccountFile(path: string, bytes: Buffer, mimeType: string, ownerId: string): Promise<void>;
  verifyPrivateAccountFile(path: string, bytes: Buffer, mimeType: string, ownerId: string): Promise<boolean>;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameInstant(actual: unknown, expected: string): boolean {
  const actualDate = actual instanceof Date ? actual : new Date(String(actual));
  return Number.isFinite(actualDate.getTime()) && actualDate.getTime() === new Date(expected).getTime();
}

async function verifyImportedContent(
  client: ImportClient,
  storage: ImportStorage,
  ownerId: string,
  prepared: PreparedAccountImport,
  imagePaths: Map<string, string>,
  filePaths: Map<string, string>,
): Promise<void> {
  const counts = await client.query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM accounts WHERE id = $1) AS accounts,
       (SELECT count(*)::int FROM ledgers WHERE owner_id = $1) AS ledgers,
       (SELECT count(*)::int FROM operations WHERE owner_id = $1) AS operations,
       (SELECT count(*)::int FROM images WHERE owner_id = $1) AS images,
       (SELECT count(*)::int FROM image_recognitions WHERE owner_id = $1) AS image_recognitions,
       (SELECT count(*)::int FROM account_files WHERE owner_id = $1) AS files,
       (SELECT count(*)::int FROM account_imports WHERE owner_id = $1) AS imports`,
    [ownerId],
  );
  const expectedCounts = {
    accounts: 1,
    ledgers: prepared.rowCounts.ledgers,
    operations: prepared.rowCounts.operations,
    images: prepared.rowCounts.images,
    image_recognitions: prepared.rowCounts.image_recognitions,
    files: prepared.files.length,
    imports: 1,
  };
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (Number(counts.rows[0]?.[key]) !== expected) throw new AccountImportError(503, "VERIFY_FAILED", `迁入后 ${key} 数量核对失败。`);
  }
  const account = await client.query<Record<string, unknown>>(
    "SELECT id, display_name, status, created_at FROM accounts WHERE id = $1",
    [ownerId],
  );
  const accountRow = account.rows[0];
  if (!accountRow || accountRow.id !== ownerId || accountRow.display_name !== prepared.displayName || accountRow.status !== "active" || !sameInstant(accountRow.created_at, prepared.sourceAccountCreatedAt)) {
    throw new AccountImportError(503, "VERIFY_FAILED", "迁入后的账号绑定信息核对失败。");
  }
  const marker = await client.query<Record<string, unknown>>(
    "SELECT owner_id, import_id, snapshot_sha256, source_account_hash, row_counts FROM account_imports WHERE owner_id = $1",
    [ownerId],
  );
  const markerRow = marker.rows[0];
  if (!markerRow || markerRow.owner_id !== ownerId || markerRow.import_id !== prepared.importId || markerRow.snapshot_sha256 !== prepared.digest || markerRow.source_account_hash !== prepared.sourceAccountHash || canonical(markerRow.row_counts) !== canonical(prepared.rowCounts)) {
    throw new AccountImportError(503, "VERIFY_FAILED", "迁入回执、来源摘要或账号归属核对失败。");
  }

  if (prepared.ledger) {
    const result = await client.query<Record<string, unknown>>(
      "SELECT owner_id, revision, data, data_raw, last_operation FROM ledgers WHERE owner_id = $1",
      [ownerId],
    );
    const row = result.rows[0];
    if (!row || row.owner_id !== ownerId || Number(row.revision) !== prepared.ledger.revision || row.last_operation !== prepared.ledger.lastOperation || row.data_raw !== prepared.ledger.dataRaw || canonical(row.data) !== canonical(prepared.ledger.data)) {
      throw new AccountImportError(503, "VERIFY_FAILED", "迁入后的账本内容或账号归属核对失败。");
    }
  }

  const operations = await client.query<Record<string, unknown>>(
    "SELECT owner_id, operation_id, idempotency_key, source_event_id, payload_hash, receipt, receipt_raw, created_at FROM operations WHERE owner_id = $1",
    [ownerId],
  );
  const operationMap = new Map(operations.rows.map((row) => [String(row.operation_id), row]));
  for (const expected of prepared.operations) {
    const row = operationMap.get(expected.operationId);
    if (!row || row.owner_id !== ownerId || row.idempotency_key !== expected.idempotencyKey || row.source_event_id !== expected.sourceEventId || row.payload_hash !== expected.payloadHash || row.receipt_raw !== expected.receiptRaw || canonical(row.receipt) !== canonical(expected.receipt) || !sameInstant(row.created_at, expected.createdAt)) {
      throw new AccountImportError(503, "VERIFY_FAILED", "迁入后的操作回执或账号归属核对失败。");
    }
  }

  const images = await client.query<Record<string, unknown>>(
    "SELECT id, owner_id, sha256, mime_type, byte_size, object_path, uploaded_at FROM images WHERE owner_id = $1",
    [ownerId],
  );
  const imageMap = new Map(images.rows.map((row) => [String(row.id), row]));
  for (const expected of prepared.images) {
    const row = imageMap.get(expected.id);
    const path = imagePaths.get(expected.id);
    if (!row || !path || row.owner_id !== ownerId || row.sha256 !== expected.sha256 || row.mime_type !== expected.mimeType || Number(row.byte_size) !== expected.byteSize || row.object_path !== path || !sameInstant(row.uploaded_at, expected.uploadedAt)) {
      throw new AccountImportError(503, "VERIFY_FAILED", "迁入后的附件记录或账号归属核对失败。");
    }
    if (!(await storage.verifyPrivateObject(path, expected.bytes, expected.mimeType, ownerId))) {
      throw new AccountImportError(503, "VERIFY_FAILED", "私有原图哈希、内容或访问归属核对失败。");
    }
  }

  const files = await client.query<Record<string, unknown>>(
    "SELECT id, owner_id, source_library_id, source_file_id, source_version, source_version_type, library_ref, version_id, file_name, mime_type, byte_size, sha256, object_path FROM account_files WHERE owner_id = $1",
    [ownerId],
  );
  const fileMap = new Map(files.rows.map((row) => [
    libraryFileKey(String(row.library_ref), row.version_id === null ? null : String(row.version_id)),
    row,
  ]));
  for (const expected of prepared.files) {
    const key = libraryFileKey(expected.libraryRef, expected.versionId);
    const row = fileMap.get(key);
    const path = filePaths.get(key);
    if (!row || !path || row.owner_id !== ownerId || row.source_library_id !== expected.libraryId ||
      row.source_file_id !== expected.sourceFileId || row.source_version !== expected.sourceVersion ||
      row.source_version_type !== expected.sourceVersionType || row.library_ref !== expected.libraryRef ||
       (row.version_id === null ? null : String(row.version_id)) !== expected.versionId ||
       row.file_name !== expected.fileName || row.mime_type !== expected.mimeType ||
      Number(row.byte_size) !== expected.byteSize || row.sha256 !== expected.sha256 || row.object_path !== path) {
      throw new AccountImportError(503, "VERIFY_FAILED", "迁入后的 Library 原始引用、版本元数据或账号归属核对失败。");
    }
    if (!expected.bytes || !(await storage.verifyPrivateAccountFile(path, expected.bytes, expected.mimeType, ownerId))) {
      throw new AccountImportError(503, "VERIFY_FAILED", "私有 Library 文件字节、SHA-256 或账号归属核对失败。");
    }
  }

  const recognitions = await client.query<Record<string, unknown>>(
    "SELECT id, owner_id, fingerprint, state, result_json, error_code, created_at, finished_at FROM image_recognitions WHERE owner_id = $1",
    [ownerId],
  );
  const recognitionMap = new Map(recognitions.rows.map((row) => [String(row.id), row]));
  for (const expected of prepared.recognitions) {
    const row = recognitionMap.get(expected.id);
    const finishedMatches = expected.finishedAt === null ? row?.finished_at == null : !!row && sameInstant(row.finished_at, expected.finishedAt);
    if (!row || row.owner_id !== ownerId || row.fingerprint !== expected.fingerprint || row.state !== expected.state || row.result_json !== expected.resultJson || row.error_code !== expected.errorCode || !sameInstant(row.created_at, expected.createdAt) || !finishedMatches) {
      throw new AccountImportError(503, "VERIFY_FAILED", "迁入后的图片识别历史或账号归属核对失败。");
    }
  }
}

export async function getDestinationConflicts(pool: ImportPool, ownerId: string): Promise<string[]> {
  const result = await pool.query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM ledgers WHERE owner_id = $1) AS ledgers,
       (SELECT count(*)::int FROM operations WHERE owner_id = $1) AS operations,
       (SELECT count(*)::int FROM images WHERE owner_id = $1) AS images,
       (SELECT count(*)::int FROM image_recognitions WHERE owner_id = $1) AS image_recognitions,
       (SELECT count(*)::int FROM account_files WHERE owner_id = $1) AS account_files,
       (SELECT count(*)::int FROM pending_uploads WHERE owner_id = $1) AS pending_uploads,
       (SELECT count(*)::int FROM account_imports WHERE owner_id = $1) AS imports`,
    [ownerId],
  );
  const row = result.rows[0] ?? {};
  return Object.entries(row).filter(([, value]) => Number(value) > 0).map(([key]) => key);
}

export async function commitAccountImport(
  pool: ImportPool,
  storage: ImportStorage,
  ownerId: string,
  prepared: PreparedAccountImport,
): Promise<{ imported: true; counts: Record<string, number>; verified: true }> {
  if (!prepared.fileValidation.can_import || prepared.files.some((file) => !file.bytes)) {
    throw new AccountImportError(422, "ATTACHMENT_VALIDATION_FAILED", "文件引用、清单或附件校验未通过，不能导入。", prepared.fileValidation);
  }
  const conflicts = await getDestinationConflicts(pool, ownerId);
  if (conflicts.length) throw new AccountImportError(409, "DESTINATION_NOT_EMPTY", "目标账号已有数据，已拒绝覆盖。", { conflicts });

  const storedPaths: string[] = [];
  const imagePaths = new Map<string, string>();
  const filePaths = new Map<string, string>();
  const client = await pool.connect();
  let inTransaction = false;
  let commitAttempted = false;
  try {
    for (const image of prepared.images) {
      const path = `/objects/account-imports/${prepared.importId}/${image.id}`;
      await storage.writePrivateObject(path, image.bytes, image.mimeType, ownerId);
      storedPaths.push(path);
      imagePaths.set(image.id, path);
    }
    for (const file of prepared.files) {
      const path = `/objects/account-files/${prepared.importId}/${randomUUID()}`;
      if (!file.bytes) throw new AccountImportError(422, "ATTACHMENT_VALIDATION_FAILED", "Library 文件缺少已验证的原始字节。");
      await storage.writePrivateAccountFile(path, file.bytes, file.mimeType, ownerId);
      storedPaths.push(path);
      filePaths.set(libraryFileKey(file.libraryRef, file.versionId), path);
    }

    await client.query("BEGIN");
    inTransaction = true;
    await client.query(
      `INSERT INTO accounts (id, display_name, status, created_at)
       VALUES ($1, $2, 'active', $3)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, status = 'active', created_at = EXCLUDED.created_at`,
      [ownerId, prepared.displayName || "本人", new Date(prepared.sourceAccountCreatedAt)],
    );
    await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [ownerId]);
    const inTxConflicts = await client.query<Record<string, number>>(
      `SELECT
         (SELECT count(*)::int FROM ledgers WHERE owner_id = $1) AS ledgers,
         (SELECT count(*)::int FROM operations WHERE owner_id = $1) AS operations,
         (SELECT count(*)::int FROM images WHERE owner_id = $1) AS images,
         (SELECT count(*)::int FROM image_recognitions WHERE owner_id = $1) AS image_recognitions,
         (SELECT count(*)::int FROM account_files WHERE owner_id = $1) AS account_files,
         (SELECT count(*)::int FROM pending_uploads WHERE owner_id = $1) AS pending_uploads,
         (SELECT count(*)::int FROM account_imports WHERE owner_id = $1) AS imports`,
      [ownerId],
    );
    if (Object.values(inTxConflicts.rows[0] ?? {}).some((value) => Number(value) > 0)) {
      throw new AccountImportError(409, "DESTINATION_NOT_EMPTY", "目标账号在确认前出现了新数据，已拒绝覆盖。");
    }

    if (prepared.ledger) {
      await client.query(
        `INSERT INTO ledgers (owner_id, revision, data, data_raw, last_operation, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
        [ownerId, prepared.ledger.revision, JSON.stringify(prepared.ledger.data), prepared.ledger.dataRaw, prepared.ledger.lastOperation, new Date(prepared.capturedAt)],
      );
    }
    for (const operation of prepared.operations) {
      await client.query(
        `INSERT INTO operations (owner_id, operation_id, idempotency_key, source_event_id, payload_hash, receipt, receipt_raw, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [ownerId, operation.operationId, operation.idempotencyKey, operation.sourceEventId, operation.payloadHash, JSON.stringify(operation.receipt), operation.receiptRaw, new Date(operation.createdAt)],
      );
    }
    for (const image of prepared.images) {
      await client.query(
        `INSERT INTO images (id, owner_id, sha256, mime_type, byte_size, object_path, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [image.id, ownerId, image.sha256, image.mimeType, image.byteSize, imagePaths.get(image.id), new Date(image.uploadedAt)],
      );
    }
    for (const file of prepared.files) {
      await client.query(
        `INSERT INTO account_files (id, owner_id, source_library_id, source_file_id, source_version, source_version_type, library_ref, version_id, file_name, mime_type, byte_size, sha256, object_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          randomUUID(), ownerId, file.libraryId, file.sourceFileId, file.sourceVersion, file.sourceVersionType,
          file.libraryRef, file.versionId, file.fileName, file.mimeType, file.byteSize, file.sha256,
           filePaths.get(libraryFileKey(file.libraryRef, file.versionId)),
        ],
      );
    }
    for (const recognition of prepared.recognitions) {
      await client.query(
        `INSERT INTO image_recognitions (id, owner_id, fingerprint, state, result_json, error_code, created_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [recognition.id, ownerId, recognition.fingerprint, recognition.state, recognition.resultJson, recognition.errorCode, new Date(recognition.createdAt), recognition.finishedAt ? new Date(recognition.finishedAt) : null],
      );
    }
    await client.query(
      `INSERT INTO account_imports (owner_id, import_id, snapshot_sha256, source_account_hash, row_counts)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [ownerId, prepared.importId, prepared.digest, prepared.sourceAccountHash, JSON.stringify(prepared.rowCounts)],
    );
    await verifyImportedContent(client, storage, ownerId, prepared, imagePaths, filePaths);
    commitAttempted = true;
    await client.query("COMMIT");
    inTransaction = false;
    return { imported: true, counts: prepared.rowCounts, verified: true };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    if (commitAttempted) {
      try {
        const committed = await pool.query<{ import_id: string; snapshot_sha256: string }>(
          "SELECT import_id, snapshot_sha256 FROM account_imports WHERE owner_id = $1 AND import_id = $2",
          [ownerId, prepared.importId],
        );
        if (committed.rows[0]?.import_id === prepared.importId && committed.rows[0]?.snapshot_sha256 === prepared.digest) {
          return { imported: true, counts: prepared.rowCounts, verified: true };
        }
      } catch {
        throw new AccountImportError(503, "IMPORT_STATUS_UNKNOWN", "数据库暂时无法确认提交结果。请先重新读取账号状态，确认前不要重复导入。");
      }
    }
    const cleanup = await Promise.allSettled(storedPaths.map((path) => storage.deletePrivateObject(path)));
    const failedDeletes = cleanup.filter((item) => item.status === "rejected").length;
    if (failedDeletes) {
      throw new AccountImportError(503, "CLEANUP_INCOMPLETE", "数据库事务已回滚，但有私有临时附件未能自动清理；它们没有账号记录且仍为私有。", { cleanup_failed_count: failedDeletes });
    }
    throw error;
  } finally {
    client.release();
  }
}
