import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AccountImportError,
  LEGACY_ACCOUNT_BACKUP_COLUMNS,
  LEGACY_ACCOUNT_BACKUP_SCHEMA,
  commitAccountImport,
  parseAccountSnapshot,
} from "../src/lib/account-import-core.ts";
import { buildAccountBackupSnapshot } from "../src/lib/account-backup-format.ts";

const sourceAccount = "synthetic-source-account";
const timestamp = "2025-04-03T10:20:30.000Z";
const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const imageHash = createHash("sha256").update(imageBytes).digest("hex");
const imageId = `img_${imageHash}`;
const cellText = (value) => ({ type: "text", hex: Buffer.from(value).toString("hex").toUpperCase() });
const cellInteger = (value) => ({ type: "integer", value: String(value) });
const cellBlob = (value) => ({ type: "blob", hex: value.toString("hex").toUpperCase() });
const cellNull = () => ({ type: "null" });
const migrationTables = Object.keys(LEGACY_ACCOUNT_BACKUP_COLUMNS);

function snapshotWithFormalSchemaFixture() {
  const snapshot = syntheticSnapshot();
  snapshot.schema = structuredClone(LEGACY_ACCOUNT_BACKUP_SCHEMA);
  const accounts = snapshot.schema.find((entry) => entry.type === "table" && entry.name === "accounts");
  accounts.sql = [
    "CREATE TABLE `accounts` (",
    "  `id`\ttext PRIMARY KEY NOT NULL,",
    "  `display_name` text NOT NULL,",
    "  `created_at` text NOT NULL,",
    "  `status` text NOT NULL",
    ")",
  ].join("\n");
  for (const table of Object.keys(LEGACY_ACCOUNT_BACKUP_COLUMNS)) {
    snapshot.tables[table].columns = LEGACY_ACCOUNT_BACKUP_COLUMNS[table]
      .map((name, index) => ({ name, pk: index === 0 ? 1 : 0, hidden: 0 }));
  }
  return snapshot;
}
const libraryFiles = [
  ["proposal-v1.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK\u0003\u0004 [Content_Types].xml word/document.xml version one")],
  ["proposal-v2.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK\u0003\u0004 [Content_Types].xml word/document.xml version two")],
  ["invoice.pdf", "application/pdf", Buffer.from("%PDF-1.7 synthetic invoice")],
  ["archive.html", "text/html", Buffer.from("<!doctype html><script>not executed</script>")],
  ["notes.md", "text/markdown", Buffer.from("# synthetic markdown\n")],
  ["plain.txt", "text/plain", Buffer.from("synthetic plain text\n")],
  ["cover.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
  ["minutes.pdf", "application/pdf", Buffer.from("%PDF-1.7 synthetic minutes")],
  ["history.html", "text/html", Buffer.from("<html><body>historical attachment</body></html>")],
  ["old.txt", "text/plain", Buffer.from("older version\n")],
  ["scan.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd9])],
].map(([fileName, mimeType, bytes], index) => ({
  libraryId: `library-${index + 1}`,
  fileId: `source-file-${index + 1}`,
  version: index === 2 ? 3 : index === 9 ? 10 : String(index + 1),
  libraryRef: `libfile_source${index + 1}`,
  versionId: index < 9 ? `doc-version-${index + 1}` : null,
  fileName,
  mimeType,
  bytes,
  sha256: createHash("sha256").update(bytes).digest("hex"),
}));

function syntheticSnapshot({ withLibraryFiles = false } = {}) {
  const versions = withLibraryFiles ? [
    { id: libraryFiles[0].versionId, library_ref: libraryFiles[0].libraryRef, summary: "first version", created_at: timestamp, checksum: libraryFiles[0].sha256 },
    { id: libraryFiles[1].versionId, library_ref: libraryFiles[1].libraryRef, summary: "second version", created_at: timestamp, checksum: libraryFiles[1].sha256 },
  ] : [];
  const data = {
    projects: [{ id: "p-1", name: "Synthetic project", goal: "Preserve the fixture" }],
    tasks: [{ id: "t-1", project_id: "p-1", title: "Keep history", attachment_ids: [imageId] }],
    documents: withLibraryFiles ? [{
      id: "doc-1", project_id: "p-1", filename: "proposal.docx", versions,
      current_version: versions[1].id, accepted_version: versions[0].id,
    }] : [],
    pending: [],
    settings: { timezone: "Asia/Shanghai", intervalHours: 2, workStart: "09:00", workEnd: "19:00", enabled: false },
    reminderLog: [],
  };
  const receipt = {
    operation_id: "op-synthetic-1",
    state: "verified",
    changes: [{ type: "update", values: { attachment_ids: [imageId] } }],
    ...(withLibraryFiles ? {
      raw_text: `历史附件 ${libraryFiles[9].libraryRef} 和 ${libraryFiles[10].libraryRef}；重复引用 ${libraryFiles[9].libraryRef}`,
    } : {}),
    ...(withLibraryFiles ? {
      before: { documents: [{ id: "doc-1", versions: [versions[0]] }] },
      after: { documents: [{ id: "doc-1", versions }] },
    } : {}),
  };
  const dataRaw = JSON.stringify(data, null, 2);
  const receiptRaw = JSON.stringify(receipt, null, 2);
  const rows = {
    accounts: [[cellText(sourceAccount), cellText("Synthetic Account"), cellText(timestamp), cellText("active")]],
    ledgers: [[cellInteger(1), cellText(sourceAccount), cellInteger(7), cellText(dataRaw), cellText("op-synthetic-1")]],
    operations: [[cellText("op-synthetic-1"), cellText(sourceAccount), cellText("idem-1"), cellText("event-1"), cellText("payload-hash-1"), cellText(receiptRaw), cellText(timestamp)]],
    images: [[cellText(imageId), cellText(sourceAccount), cellText(imageHash), cellText("image/png"), cellInteger(imageBytes.length), cellText(timestamp), cellBlob(imageBytes)]],
    image_recognitions: [[cellText("recognition-1"), cellText(sourceAccount), cellText("fingerprint-1"), cellText("complete"), cellText(JSON.stringify({ text: "synthetic" })), cellNull(), cellText(timestamp), cellNull()]],
  };
  return {
    format: "d1-account-snapshot-v1",
    captured_at: timestamp,
    complete: true,
    scope: "authenticated-account",
    schema: LEGACY_ACCOUNT_BACKUP_SCHEMA,
    row_counts: Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, values.length])),
    tables: Object.fromEntries(Object.entries(rows).map(([name, values]) => [
      name,
      {
        columns: LEGACY_ACCOUNT_BACKUP_COLUMNS[name].map((column, index) => ({ name: column, pk: index === 0 ? 1 : 0, hidden: 0 })),
        rows: values,
      },
    ])),
  };
}

function manifestAndFile() {
  const entries = libraryFiles.map((file) => ({
    library_id: file.libraryId,
    file_id: file.fileId,
    version: file.version,
    library_ref: file.libraryRef,
    version_id: file.versionId,
    file_name: file.fileName,
    mime_type: file.mimeType,
    byte_size: file.bytes.length,
    sha256: file.sha256,
  }));
  return {
    manifest: {
      originalname: "library-files-manifest.json",
      buffer: Buffer.from(JSON.stringify({
        format: "project-ledger-complete-file-manifest-v1",
        images: [{ image_id: imageId, file_name: "source-image.png", sha256: imageHash, mime_type: "image/png", byte_size: imageBytes.length }],
        files: entries,
      })),
    },
    files: [
      { originalname: "source-image.png", buffer: imageBytes },
      ...libraryFiles.map((file) => ({ originalname: file.fileName, buffer: file.bytes })),
    ],
  };
}

function parseFixture({ manifest = false, withLibraryFiles = manifest } = {}) {
  const snapshot = syntheticSnapshot({ withLibraryFiles });
  const sidecar = manifest ? manifestAndFile() : undefined;
  return parseAccountSnapshot(
    JSON.stringify(snapshot),
    sidecar?.manifest,
    sidecar?.files ?? [],
  );
}

function counts(state) {
  return {
    accounts: state.account ? 1 : 0,
    ledgers: state.ledger ? 1 : 0,
    operations: state.operations.length,
    images: state.images.length,
    image_recognitions: state.recognitions.length,
    account_files: state.files.length,
    pending_uploads: 0,
    imports: state.imports.length,
  };
}

function conflictRow(state) {
  const current = counts(state);
  return [{
    ledgers: current.ledgers,
    operations: current.operations,
    images: current.images,
    image_recognitions: current.image_recognitions,
    account_files: current.account_files,
    pending_uploads: current.pending_uploads,
    imports: current.imports,
  }];
}

class FakeClient {
  constructor(database) { this.database = database; this.before = null; }
  async query(sql, params = []) {
    const state = this.database.state;
    if (sql === "BEGIN") { this.before = structuredClone(state); return { rows: [] }; }
    if (sql === "ROLLBACK") { this.database.state = this.before; return { rows: [] }; }
    if (sql === "COMMIT") { this.before = null; return { rows: [] }; }
    if (sql.includes("FOR UPDATE")) return { rows: state.account ? [{ id: state.account.id }] : [] };
    if (sql.startsWith("SELECT id, display_name, status, created_at FROM accounts")) return { rows: state.account ? [state.account] : [] };
    if (sql.includes("(SELECT count(*)::int FROM accounts")) {
      const current = counts(state);
      return { rows: [{ accounts: current.accounts, ledgers: current.ledgers, operations: current.operations, images: current.images, image_recognitions: current.image_recognitions, files: current.account_files, imports: current.imports }] };
    }
    if (sql.includes("FROM accounts WHERE id = $1")) return { rows: state.account ? [{ id: state.account.id }] : [] };
    if (sql.includes("(SELECT count(*)::int FROM ledgers")) return { rows: conflictRow(state) };
    if (sql.startsWith("INSERT INTO accounts")) { state.account = { id: params[0], display_name: params[1], status: "active", created_at: params[2] }; return { rows: [] }; }
    if (sql.startsWith("INSERT INTO ledgers")) { state.ledger = { owner_id: params[0], revision: params[1], data: JSON.parse(params[2]), data_raw: params[3], last_operation: params[4] }; return { rows: [] }; }
    if (sql.startsWith("INSERT INTO operations")) { if (this.database.failAt === "operations") throw new Error("synthetic insert failure"); state.operations.push({ owner_id: params[0], operation_id: params[1], idempotency_key: params[2], source_event_id: params[3], payload_hash: params[4], receipt: JSON.parse(params[5]), receipt_raw: params[6], created_at: params[7] }); return { rows: [] }; }
    if (sql.startsWith("INSERT INTO images")) { state.images.push({ id: params[0], owner_id: params[1], sha256: params[2], mime_type: params[3], byte_size: params[4], object_path: params[5], uploaded_at: params[6] }); return { rows: [] }; }
    if (sql.startsWith("INSERT INTO account_files")) { state.files.push({ id: params[0], owner_id: params[1], source_library_id: params[2], source_file_id: params[3], source_version: params[4], source_version_type: params[5], library_ref: params[6], version_id: params[7], file_name: params[8], mime_type: params[9], byte_size: params[10], sha256: params[11], object_path: params[12] }); return { rows: [] }; }
    if (sql.startsWith("INSERT INTO image_recognitions")) { if (this.database.failAt === "recognitions") throw new Error("synthetic insert failure"); state.recognitions.push({ id: params[0], owner_id: params[1], fingerprint: params[2], state: params[3], result_json: params[4], error_code: params[5], created_at: params[6], finished_at: params[7] }); return { rows: [] }; }
    if (sql.startsWith("INSERT INTO account_imports")) {
      state.imports.push({
        owner_id: params[0],
        import_id: params[1],
        snapshot_sha256: params[2],
        source_account_hash: params[3],
        row_counts: JSON.parse(params[4]),
      });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT owner_id, revision")) return { rows: state.ledger ? [state.ledger] : [] };
    if (sql.startsWith("SELECT owner_id, operation_id")) return { rows: state.operations };
    if (sql.startsWith("SELECT id, owner_id, sha256")) return { rows: state.images };
    if (sql.startsWith("SELECT id, owner_id, source_library_id")) return { rows: state.files };
    if (sql.startsWith("SELECT id, owner_id, fingerprint")) return { rows: state.recognitions };
    if (sql.startsWith("SELECT owner_id, import_id, snapshot_sha256")) return { rows: state.imports };
    throw new Error(`Unexpected synthetic SQL: ${sql}`);
  }
  release() {}
}

class FakePool {
  state = { account: null, ledger: null, operations: [], images: [], files: [], recognitions: [], imports: [] };
  failAt = null;
  async query(sql) {
    if (sql.includes("(SELECT count(*)::int FROM ledgers")) return { rows: conflictRow(this.state) };
    throw new Error(`Unexpected pool SQL: ${sql}`);
  }
  async connect() { return new FakeClient(this); }
}

class FakeStorage {
  objects = new Map();
  async writePrivateObject(path, bytes, mimeType, ownerId) {
    this.objects.set(path, { bytes: Buffer.from(bytes), mimeType, ownerId, visibility: "private" });
  }
  async writePrivateAccountFile(path, bytes, mimeType, ownerId) {
    this.objects.set(path, { bytes: Buffer.from(bytes), mimeType, ownerId, visibility: "private" });
  }
  async verifyPrivateObject(path, bytes, mimeType, ownerId) {
    const item = this.objects.get(path);
    return !!item && item.bytes.equals(bytes) && item.mimeType === mimeType && item.ownerId === ownerId && item.visibility === "private";
  }
  async verifyPrivateAccountFile(path, bytes, mimeType, ownerId) {
    const item = this.objects.get(path);
    return !!item && item.bytes.equals(bytes) && item.mimeType === mimeType && item.ownerId === ownerId && item.visibility === "private";
  }
  async deletePrivateObject(path) { this.objects.delete(path); }
}

test("validates complete synthetic snapshot, sidecar hash manifest, and attachment references", () => {
  const prepared = parseFixture({ manifest: true });
  assert.deepEqual(prepared.rowCounts, { accounts: 1, ledgers: 1, operations: 1, images: 1, image_recognitions: 1 });
  assert.equal(prepared.images[0].fileName, "source-image.png");
  assert.equal(prepared.ledger.data.tasks[0].attachment_ids[0], imageId);
  assert.equal(prepared.operations[0].operationId, "op-synthetic-1");
  assert.equal(prepared.files.length, 11);
  assert.equal(prepared.files.find((file) => file.libraryRef === libraryFiles[2].libraryRef).sourceVersionType, "number");
  assert.deepEqual(prepared.fileValidation.current_references, { total: 2, covered: 2 });
  assert.deepEqual(prepared.fileValidation.history_references, { total: 4, covered: 4 });
  assert.equal(prepared.fileValidation.can_import, true);
  assert.equal(prepared.files.filter((file) => file.versionId === null).length, 2);
  const unversionedLibraryVersion = prepared.files.find((file) => file.versionId === null);
  assert.equal(unversionedLibraryVersion.sourceVersion, "10");
  assert.equal(unversionedLibraryVersion.sourceVersionType, "number");
  assert.equal(prepared.fileValidation.unreferenced_files.length, 7);
});

test("accepts the supported synthetic schema fixture and rejects structural DDL tampering", () => {
  const original = snapshotWithFormalSchemaFixture();
  assert.equal(original.schema.length, 15);
  assert.equal(original.schema.filter((entry) => entry.sql === null).length, 4);
  assert.ok(original.schema.some((entry) => typeof entry.sql === "string" && /[\n\t]/.test(entry.sql)));
  assert.ok(original.schema.some((entry) => entry.name === "owner_key" && /`owner_id`,`idempotency_key`/.test(entry.sql)));
  assert.doesNotThrow(() => parseAccountSnapshot(JSON.stringify(original)));

  const equivalentFormatting = structuredClone(original);
  for (const entry of equivalentFormatting.schema) {
    entry.type = entry.type.toUpperCase();
    entry.name = entry.name.toUpperCase();
    entry.tbl_name = entry.tbl_name.toUpperCase();
    if (typeof entry.sql === "string") entry.sql = entry.sql.replaceAll("`", '"').toUpperCase();
  }
  for (const table of migrationTables) {
    for (const column of equivalentFormatting.tables[table].columns) {
      column.name = column.name.toUpperCase();
    }
  }
  assert.doesNotThrow(() => parseAccountSnapshot(JSON.stringify(equivalentFormatting)));

  const expectRejected = (mutate) => {
    const tampered = structuredClone(original);
    mutate(tampered);
    assert.throws(() => parseAccountSnapshot(JSON.stringify(tampered)), AccountImportError);
  };
  const tableSql = (snapshot, table) => snapshot.schema.find(
    (entry) => entry.type === "table" && entry.name === table,
  );
  const indexSql = (snapshot, name) => snapshot.schema.find(
    (entry) => entry.type === "index" && entry.name === name,
  );

  expectRejected((snapshot) => {
    tableSql(snapshot, "accounts").sql =
      tableSql(snapshot, "accounts").sql.replace(/(`display_name`\s+text)\s+NOT NULL/i, "$1");
  });
  expectRejected((snapshot) => {
    tableSql(snapshot, "ledgers").sql =
      tableSql(snapshot, "ledgers").sql.replace(/(`revision`\s+)integer/i, "$1text");
  });
  expectRejected((snapshot) => {
    tableSql(snapshot, "accounts").sql =
      tableSql(snapshot, "accounts").sql.replace(/(`id`\s+text)\s+PRIMARY KEY/i, "$1");
  });
  expectRejected((snapshot) => {
    indexSql(snapshot, "owner_key").sql =
      indexSql(snapshot, "owner_key").sql.replace(/CREATE UNIQUE INDEX/i, "CREATE INDEX");
  });
  expectRejected((snapshot) => {
    indexSql(snapshot, "owner_source").sql =
      indexSql(snapshot, "owner_source").sql.replace(/(`owner_id`)\s*,\s*(`source_event_id`)/i, "$2,$1");
  });
  expectRejected((snapshot) => {
    tableSql(snapshot, "accounts").sql += "; DROP TABLE accounts";
  });
  expectRejected((snapshot) => {
    snapshot.schema.push({
      type: "index",
      name: "unexpected",
      tbl_name: "accounts",
      sql: "CREATE INDEX `unexpected` ON `accounts` (`id`)",
    });
  });
  expectRejected((snapshot) => {
    snapshot.tables.accounts.columns[0].pk = 0;
  });
});

test("supports explicit null ledger versions for unique bare history references and rejects ambiguity", () => {
  const fixture = manifestAndFile();
  const snapshot = JSON.stringify(syntheticSnapshot({ withLibraryFiles: true }));
  const parsedManifest = JSON.parse(fixture.manifest.buffer.toString("utf8"));
  const noVersion = parsedManifest.files.find((file) => file.version_id === null);
  assert.ok(noVersion);

  const missingVersion = structuredClone(parsedManifest);
  delete missingVersion.files.find((file) => file.file_id === noVersion.file_id).version_id;
  const missingVersionResult = parseAccountSnapshot(
    snapshot,
    { ...fixture.manifest, buffer: Buffer.from(JSON.stringify(missingVersion)) },
    fixture.files,
  );
  assert.equal(missingVersionResult.fileValidation.can_import, false);
  assert.ok(missingVersionResult.fileValidation.mapping_errors.length > 0);

  const ambiguous = structuredClone(parsedManifest);
  const ambiguousBytes = Buffer.from("alternate version of an unversioned historical reference\n");
  ambiguous.files.push({
    ...noVersion,
    file_id: "source-file-ambiguous",
    version: "alternate-library-version",
    version_id: "alternate-document-version",
    file_name: "alternate-history.txt",
    mime_type: "text/plain",
    byte_size: ambiguousBytes.length,
    sha256: createHash("sha256").update(ambiguousBytes).digest("hex"),
  });
  const ambiguousResult = parseAccountSnapshot(
    snapshot,
    { ...fixture.manifest, buffer: Buffer.from(JSON.stringify(ambiguous)) },
    [...fixture.files, { originalname: "alternate-history.txt", buffer: ambiguousBytes }],
  );
  assert.equal(ambiguousResult.fileValidation.can_import, false);
  assert.ok(ambiguousResult.fileValidation.ambiguous_references.some(
    (ref) => ref.library_ref === noVersion.library_ref && ref.version_id === null,
  ));
});

test("full backup export matches the legacy snapshot contract and round-trips through import validation", () => {
  const base = syntheticSnapshot();
  const raw = (cell) => cell.type === "text" ? Buffer.from(cell.hex, "hex").toString("utf8") : cell.type === "integer" ? Number(cell.value) : cell.type === "blob" ? Buffer.from(cell.hex, "hex") : null;
  const accountRow = base.tables.accounts.rows[0].map(raw);
  const ledgerRow = base.tables.ledgers.rows[0].map(raw);
  const operationRow = base.tables.operations.rows[0].map(raw);
  const imageRow = base.tables.images.rows[0].map(raw);
  const recognitionRow = base.tables.image_recognitions.rows[0].map(raw);
  const exported = buildAccountBackupSnapshot({
    account: { id: accountRow[0], display_name: accountRow[1], created_at: new Date(accountRow[2]), status: accountRow[3] },
    ledger: { owner_id: ledgerRow[1], revision: ledgerRow[2], data: JSON.parse(ledgerRow[3]), data_raw: ledgerRow[3], last_operation: ledgerRow[4] },
    operations: [{ operation_id: operationRow[0], owner_id: operationRow[1], idempotency_key: operationRow[2], source_event_id: operationRow[3], payload_hash: operationRow[4], receipt: JSON.parse(operationRow[5]), receipt_raw: operationRow[5], created_at: new Date(operationRow[6]) }],
    images: [{ id: imageRow[0], owner_id: imageRow[1], sha256: imageRow[2], mime_type: imageRow[3], byte_size: imageRow[4], uploaded_at: new Date(imageRow[5]), bytes: imageRow[6] }],
    recognitions: [{ id: recognitionRow[0], owner_id: recognitionRow[1], fingerprint: recognitionRow[2], state: recognitionRow[3], result_json: recognitionRow[4], error_code: null, created_at: new Date(recognitionRow[6]), finished_at: null }],
  });
  const roundTrip = parseAccountSnapshot(JSON.stringify(exported));
  assert.equal(exported.format, "d1-account-snapshot-v1");
  assert.equal(exported.complete, true);
  assert.deepEqual(exported.row_counts, { accounts: 1, ledgers: 1, operations: 1, images: 1, image_recognitions: 1 });
  assert.deepEqual(roundTrip.rowCounts, exported.row_counts);
  assert.deepEqual(roundTrip.images[0].bytes, imageBytes);
  assert.equal(roundTrip.operations[0].operationId, "op-synthetic-1");
  assert.equal(raw(exported.tables.ledgers.rows[0][3]), ledgerRow[3]);
  assert.equal(raw(exported.tables.operations.rows[0][5]), operationRow[5]);
});

test("rejects tampered image hash, foreign ownership, and duplicate JSON keys", () => {
  const badHash = syntheticSnapshot();
  badHash.tables.images.rows[0][2] = cellText("0".repeat(64));
  assert.throws(() => parseAccountSnapshot(JSON.stringify(badHash)), AccountImportError);

  const foreignOwner = syntheticSnapshot();
  foreignOwner.tables.operations.rows[0][1] = cellText("other-account");
  assert.throws(() => parseAccountSnapshot(JSON.stringify(foreignOwner)), /归属/);

  assert.throws(() => parseAccountSnapshot('{"format":"d1-account-snapshot-v1","format":"d1-account-snapshot-v1"}'), /重复字段/);
});

test("preview parsing performs no database or storage writes before confirmation", () => {
  const database = new FakePool();
  const storage = new FakeStorage();
  const before = structuredClone(database.state);
  parseFixture({ manifest: true });
  assert.deepEqual(database.state, before);
  assert.equal(storage.objects.size, 0);
});

test("previews and blocks missing, extra, mismatched, and wrong-type Library attachments", () => {
  const fixture = manifestAndFile();
  const snapshot = JSON.stringify(syntheticSnapshot({ withLibraryFiles: true }));
  const missing = parseAccountSnapshot(snapshot, fixture.manifest, fixture.files.filter((file) => file.originalname !== "proposal-v2.docx"));
  assert.equal(missing.fileValidation.can_import, false);
  assert.ok(missing.fileValidation.missing_files.some((item) => item.file_name === "proposal-v2.docx"));

  const extra = parseAccountSnapshot(snapshot, fixture.manifest, [...fixture.files, { originalname: "unlisted.txt", buffer: Buffer.from("extra") }]);
  assert.equal(extra.fileValidation.can_import, false);
  assert.deepEqual(extra.fileValidation.extra_uploads, ["unlisted.txt"]);

  const sizeManifest = JSON.parse(fixture.manifest.buffer.toString("utf8"));
  sizeManifest.files[2].byte_size += 1;
  const sizeMismatch = parseAccountSnapshot(snapshot, { ...fixture.manifest, buffer: Buffer.from(JSON.stringify(sizeManifest)) }, fixture.files);
  assert.equal(sizeMismatch.fileValidation.can_import, false);
  assert.ok(sizeMismatch.fileValidation.size_errors.some((item) => item.file_name === "invoice.pdf"));

  const hashManifest = JSON.parse(fixture.manifest.buffer.toString("utf8"));
  hashManifest.files[3].sha256 = "0".repeat(64);
  const hashMismatch = parseAccountSnapshot(snapshot, { ...fixture.manifest, buffer: Buffer.from(JSON.stringify(hashManifest)) }, fixture.files);
  assert.equal(hashMismatch.fileValidation.can_import, false);
  assert.ok(hashMismatch.fileValidation.hash_errors.some((item) => item.file_name === "archive.html"));

  const typeManifest = JSON.parse(fixture.manifest.buffer.toString("utf8"));
  typeManifest.files[2].mime_type = "text/html";
  const wrongType = parseAccountSnapshot(snapshot, { ...fixture.manifest, buffer: Buffer.from(JSON.stringify(typeManifest)) }, fixture.files);
  assert.equal(wrongType.fileValidation.can_import, false);
  assert.ok(wrongType.fileValidation.type_errors.some((item) => item.file_name === "invoice.pdf"));
});

test("matches Unicode Library filenames exactly and rejects duplicate or mojibake-alias uploads", () => {
  const fixture = manifestAndFile();
  const snapshot = JSON.stringify(syntheticSnapshot({ withLibraryFiles: true }));
  const manifestData = JSON.parse(fixture.manifest.buffer.toString("utf8"));
  const sourceName = manifestData.files[0].file_name;
  const unicodeName = "方案-最终版.docx";
  manifestData.files[0].file_name = unicodeName;
  const manifest = { ...fixture.manifest, buffer: Buffer.from(JSON.stringify(manifestData)) };
  const target = fixture.files.find((file) => file.originalname === sourceName);
  assert.ok(target);
  const renamedFiles = fixture.files.map((file) =>
    file.originalname === sourceName ? { ...file, originalname: unicodeName } : file,
  );

  const valid = parseAccountSnapshot(snapshot, manifest, renamedFiles);
  assert.equal(valid.fileValidation.can_import, true);
  assert.equal(valid.files.length, 11);
  assert.equal(valid.files[0].fileName, unicodeName);
  assert.deepEqual(valid.fileValidation.missing_files, []);
  assert.deepEqual(valid.fileValidation.extra_uploads, []);
  assert.deepEqual(valid.fileValidation.size_errors, []);
  assert.deepEqual(valid.fileValidation.hash_errors, []);

  const mojibakeAlias = Buffer.from(unicodeName, "utf8").toString("latin1");
  const ambiguous = parseAccountSnapshot(snapshot, manifest, [
    ...renamedFiles,
    { originalname: mojibakeAlias, buffer: target.buffer },
  ]);
  assert.equal(ambiguous.fileValidation.can_import, false);
  assert.deepEqual(ambiguous.fileValidation.extra_uploads, [mojibakeAlias]);

  const aliasOnly = parseAccountSnapshot(snapshot, manifest, renamedFiles.map((file) =>
    file.originalname === unicodeName ? { ...file, originalname: mojibakeAlias } : file,
  ));
  assert.equal(aliasOnly.fileValidation.can_import, false);
  assert.ok(aliasOnly.fileValidation.missing_files.some((item) => item.file_name === unicodeName));
  assert.ok(aliasOnly.fileValidation.extra_uploads.includes(mojibakeAlias));

  const duplicate = parseAccountSnapshot(snapshot, manifest, [
    ...renamedFiles,
    { originalname: unicodeName, buffer: target.buffer },
  ]);
  assert.equal(duplicate.fileValidation.can_import, false);
  assert.deepEqual(duplicate.fileValidation.extra_uploads, [unicodeName]);

  const unsafeManifest = JSON.parse(manifest.buffer.toString("utf8"));
  unsafeManifest.files[0].file_name = "../方案-最终版.docx";
  const unsafe = parseAccountSnapshot(
    snapshot,
    { ...manifest, buffer: Buffer.from(JSON.stringify(unsafeManifest)) },
    renamedFiles.map((file) => file.originalname === unicodeName
      ? { ...file, originalname: "../方案-最终版.docx" }
      : file),
  );
  assert.equal(unsafe.fileValidation.can_import, false);
  assert.ok(unsafe.fileValidation.mapping_errors.length > 0);
});

test("imports all synthetic rows under the signed-in owner and verifies private attachment bytes", async () => {
  const database = new FakePool();
  const storage = new FakeStorage();
  const prepared = parseFixture({ manifest: true });
  const result = await commitAccountImport(database, storage, "clerk-user-1", prepared);
  assert.deepEqual(result, { imported: true, counts: prepared.rowCounts, verified: true });
  assert.equal(database.state.ledger.owner_id, "clerk-user-1");
  assert.equal(database.state.operations[0].owner_id, "clerk-user-1");
  assert.equal(database.state.images[0].owner_id, "clerk-user-1");
  assert.equal(database.state.files.length, 11);
  assert.equal(database.state.files.filter((file) => file.version_id === null).length, 2);
  assert.ok(database.state.files.every((file) => file.owner_id === "clerk-user-1"));
  assert.equal(database.state.recognitions[0].owner_id, "clerk-user-1");
  assert.equal(database.state.operations[0].operation_id, "op-synthetic-1");
  assert.equal(storage.objects.size, 12);
  assert.equal([...storage.objects.values()][0].visibility, "private");
});

test("rejects pre-existing data and duplicate imports without writing objects", async () => {
  const database = new FakePool();
  const storage = new FakeStorage();
  const prepared = parseFixture();
  database.state.ledger = { owner_id: "clerk-user-1" };
  await assert.rejects(commitAccountImport(database, storage, "clerk-user-1", prepared), (error) => error instanceof AccountImportError && error.status === 409);
  assert.equal(storage.objects.size, 0);

  database.state.ledger = null;
  await commitAccountImport(database, storage, "clerk-user-1", prepared);
  const writesBeforeRetry = storage.objects.size;
  await assert.rejects(commitAccountImport(database, storage, "clerk-user-1", prepared), (error) => error instanceof AccountImportError && error.status === 409);
  assert.equal(storage.objects.size, writesBeforeRetry);
});

test("rolls back database rows and deletes staged private files after a failed import", async () => {
  const database = new FakePool();
  database.failAt = "recognitions";
  const storage = new FakeStorage();
  await assert.rejects(commitAccountImport(database, storage, "clerk-user-1", parseFixture()));
  assert.equal(database.state.account, null);
  assert.equal(database.state.ledger, null);
  assert.equal(database.state.operations.length, 0);
  assert.equal(database.state.images.length, 0);
  assert.equal(database.state.imports.length, 0);
  assert.equal(storage.objects.size, 0);
});
