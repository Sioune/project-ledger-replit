import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import express from "express";
import { clerkMiddleware } from "@clerk/express";
import { pool } from "@workspace/db";
import {
  AccountImportError,
  LEGACY_ACCOUNT_BACKUP_COLUMNS,
  LEGACY_ACCOUNT_BACKUP_SCHEMA,
  commitAccountImport,
  parseAccountSnapshot,
} from "../src/lib/account-import-core.ts";
import { exportAccountBackupArchive } from "../src/lib/account-backup.ts";
import { ObjectNotFoundError, ObjectStorageService } from "../src/lib/objectStorage.ts";
import { getAccountScope } from "../src/lib/auth.ts";
import accountFilesRouter from "../src/routes/account-files.ts";

if (process.env.NODE_ENV !== "development" || process.env.ACCOUNT_IMPORT_E2E_CONFIRM !== "synthetic-only") {
  throw new Error("Run this only against the development database with ACCOUNT_IMPORT_E2E_CONFIRM=synthetic-only.");
}

const storage = new ObjectStorageService();
const suffix = randomUUID();
const owners = [
  `synthetic-e2e-a-${suffix}`,
  `synthetic-e2e-b-${suffix}`,
  `synthetic-e2e-occupied-${suffix}`,
  `synthetic-e2e-rollback-${suffix}`,
];
const [ownerA, ownerB, occupiedOwner, rollbackOwner] = owners;
const eligibleOwners = [];
const createdOwners = new Set();
const writtenPaths = [];
const timestamp = "2025-04-03T10:20:30.000Z";
const sourceOwner = "synthetic-source-account";
const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const imageHash = createHash("sha256").update(imageBytes).digest("hex");
const imageId = `img_${imageHash}`;

const textCell = (value) => ({ type: "text", hex: Buffer.from(value).toString("hex").toUpperCase() });
const integerCell = (value) => ({ type: "integer", value: String(value) });
const blobCell = (value) => ({ type: "blob", hex: value.toString("hex").toUpperCase() });
const nullCell = () => ({ type: "null" });

const fileSpecs = [
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
  fileId: `original-file-${index + 1}`,
  version: index === 2 ? 3 : index === 9 ? 10 : String(index + 1),
  libraryRef: `libfile_e2e${index + 1}`,
  versionId: index < 9 ? `doc-version-${index + 1}` : null,
  fileName,
  mimeType,
  bytes,
  sha256: createHash("sha256").update(bytes).digest("hex"),
}));

function createSourceBackup() {
  const versions = [0, 1].map((index) => ({
    id: fileSpecs[index].versionId,
    library_ref: fileSpecs[index].libraryRef,
    summary: `synthetic version ${index + 1}`,
    created_at: timestamp,
    checksum: fileSpecs[index].sha256,
  }));
  const data = {
    projects: [{ id: "p-e2e", name: "Synthetic project", goal: "No user data" }],
    tasks: [{ id: "t-e2e", project_id: "p-e2e", title: "Synthetic task", attachment_ids: [imageId] }],
    documents: [{
      id: "doc-e2e",
      project_id: "p-e2e",
      filename: "proposal.docx",
      versions,
      current_version: versions[1].id,
      accepted_version: versions[0].id,
    }],
    pending: [],
    settings: { timezone: "Asia/Shanghai", intervalHours: 2, workStart: "09:00", workEnd: "19:00", enabled: false },
    reminderLog: [],
  };
  const receipt = {
    operation_id: "op-e2e-1",
    state: "verified",
    raw_text: `Synthetic historical receipt cites ${fileSpecs[9].libraryRef} and ${fileSpecs[10].libraryRef}; repeat ${fileSpecs[9].libraryRef}`,
    before: { documents: [{ id: "doc-e2e", versions: [versions[0]] }] },
    after: { documents: [{ id: "doc-e2e", versions }] },
    changes: [{ type: "document", values: { library_ref: fileSpecs[1].libraryRef, version_id: fileSpecs[1].versionId } }],
  };
  const dataRaw = JSON.stringify(data, null, 2);
  const receiptRaw = JSON.stringify(receipt, null, 2);
  const rows = {
    accounts: [[textCell(sourceOwner), textCell("Synthetic Source"), textCell(timestamp), textCell("active")]],
    ledgers: [[integerCell(1), textCell(sourceOwner), integerCell(9), textCell(dataRaw), textCell("op-e2e-1")]],
    operations: [[textCell("op-e2e-1"), textCell(sourceOwner), textCell("idem-e2e"), textCell("event-e2e"), textCell("payload-e2e"), textCell(receiptRaw), textCell(timestamp)]],
    images: [[textCell(imageId), textCell(sourceOwner), textCell(imageHash), textCell("image/png"), integerCell(imageBytes.length), textCell(timestamp), blobCell(imageBytes)]],
    image_recognitions: [[textCell("recognition-e2e"), textCell(sourceOwner), textCell("fingerprint-e2e"), textCell("complete"), textCell('{"result":"synthetic"}'), nullCell(), textCell(timestamp), nullCell()]],
  };
  const snapshot = {
    format: "d1-account-snapshot-v1",
    captured_at: timestamp,
    complete: true,
    scope: "authenticated-account",
    schema: LEGACY_ACCOUNT_BACKUP_SCHEMA,
    row_counts: Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.length])),
    tables: Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, {
      columns: LEGACY_ACCOUNT_BACKUP_COLUMNS[key].map((name, index) => ({ name, pk: index === 0 ? 1 : 0, hidden: 0 })),
      rows: value,
    }])),
  };
  const manifest = {
    format: "project-ledger-complete-file-manifest-v1",
    images: [{ image_id: imageId, file_name: "source-image.png", mime_type: "image/png", byte_size: imageBytes.length, sha256: imageHash }],
    files: fileSpecs.map((file) => ({
      library_id: file.libraryId,
      file_id: file.fileId,
      version: file.version,
      library_ref: file.libraryRef,
      version_id: file.versionId,
      file_name: file.fileName,
      mime_type: file.mimeType,
      byte_size: file.bytes.length,
      sha256: file.sha256,
    })),
  };
  const attachments = [
    { originalname: "source-image.png", buffer: imageBytes },
    ...fileSpecs.map((file) => ({ originalname: file.fileName, buffer: file.bytes })),
  ];
  return { snapshot, manifest, attachments, dataRaw, receiptRaw };
}

function preparedFromSource(source = createSourceBackup()) {
  return parseAccountSnapshot(
    JSON.stringify(source.snapshot),
    { originalname: "library-files-manifest.json", buffer: Buffer.from(JSON.stringify(source.manifest)) },
    source.attachments,
  );
}

function trackingStorage(failGenericVerification = false) {
  return {
    async writePrivateObject(path, ...args) {
      await storage.writePrivateObject(path, ...args);
      writtenPaths.push(path);
    },
    async writePrivateAccountFile(path, ...args) {
      await storage.writePrivateAccountFile(path, ...args);
      writtenPaths.push(path);
    },
    deletePrivateObject: (path) => storage.deletePrivateObject(path),
    verifyPrivateObject: (...args) => storage.verifyPrivateObject(...args),
    verifyPrivateAccountFile: failGenericVerification
      ? async () => false
      : (...args) => storage.verifyPrivateAccountFile(...args),
  };
}

async function ownerCounts(owner) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM accounts WHERE id = $1) AS accounts,
       (SELECT count(*)::int FROM ledgers WHERE owner_id = $1) AS ledgers,
       (SELECT count(*)::int FROM operations WHERE owner_id = $1) AS operations,
       (SELECT count(*)::int FROM images WHERE owner_id = $1) AS images,
       (SELECT count(*)::int FROM image_recognitions WHERE owner_id = $1) AS recognitions,
       (SELECT count(*)::int FROM account_files WHERE owner_id = $1) AS files,
       (SELECT count(*)::int FROM account_imports WHERE owner_id = $1) AS imports`,
    [owner],
  );
  return result.rows[0];
}

async function verifyFiles(owner, expectedFiles) {
  const result = await pool.query(
    `SELECT source_library_id, source_file_id, source_version, source_version_type, library_ref, version_id,
            file_name, mime_type, byte_size, sha256, object_path
     FROM account_files WHERE owner_id = $1 ORDER BY library_ref`,
    [owner],
  );
  assert.equal(result.rows.length, 11);
  const byRef = new Map(result.rows.map((row) => [row.library_ref, row]));
  for (const expected of expectedFiles) {
    const row = byRef.get(expected.libraryRef);
    assert.ok(row, `missing mapping ${expected.libraryRef}`);
    assert.equal(row.source_library_id, expected.libraryId);
    assert.equal(row.source_file_id, expected.fileId);
    assert.equal(row.source_version, String(expected.version));
    assert.equal(row.source_version_type, typeof expected.version);
    assert.equal(row.version_id, expected.versionId);
    assert.equal(row.file_name, expected.fileName);
    assert.equal(Number(row.byte_size), expected.bytes.length);
    assert.equal(row.sha256, expected.sha256);
    const owned = await storage.getOwnedPrivateAccountFile(row.object_path, owner);
    const [bytes] = await owned.file.download();
    assert.equal(bytes.length, expected.bytes.length);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
    assert.deepEqual(bytes, expected.bytes);
  }
  return result.rows;
}

const passed = [];
try {
  for (const owner of owners) {
    const counts = await ownerCounts(owner);
    assert.ok(Object.values(counts).every((count) => Number(count) === 0), "synthetic owner ID unexpectedly exists");
    eligibleOwners.push(owner);
  }

  const source = createSourceBackup();
  const prepared = preparedFromSource(source);
  assert.equal(prepared.files.length, 11);
  assert.equal(prepared.fileValidation.can_import, true);
  assert.deepEqual(prepared.fileValidation.current_references, { total: 2, covered: 2 });
  assert.deepEqual(prepared.fileValidation.history_references, { total: 4, covered: 4 });
  await commitAccountImport(pool, trackingStorage(), ownerA, prepared);
  createdOwners.add(ownerA);
  assert.equal(Number((await ownerCounts(ownerA)).files), 11);
  assert.equal((await pool.query("SELECT data_raw FROM ledgers WHERE owner_id = $1", [ownerA])).rows[0].data_raw, source.dataRaw);
  assert.equal((await pool.query("SELECT receipt_raw FROM operations WHERE owner_id = $1", [ownerA])).rows[0].receipt_raw, source.receiptRaw);
  const importedFiles = await verifyFiles(ownerA, fileSpecs);
  const oldVersion = importedFiles.find((row) => row.library_ref === fileSpecs[0].libraryRef && row.version_id === fileSpecs[0].versionId);
  assert.ok(oldVersion, "historical version mapping retained");
  const unversionedHistoryFile = importedFiles.find((row) =>
    row.library_ref === fileSpecs[9].libraryRef && row.version_id === null);
  assert.ok(unversionedHistoryFile, "bare historical Library reference retained with a real NULL version");
  assert.equal(unversionedHistoryFile.source_library_id, fileSpecs[9].libraryId);
  assert.equal(unversionedHistoryFile.source_file_id, fileSpecs[9].fileId);
  assert.equal(unversionedHistoryFile.source_version, String(fileSpecs[9].version));
  assert.equal(unversionedHistoryFile.source_version_type, "number");
  await assert.rejects(
    storage.getOwnedPrivateAccountFile(oldVersion.object_path, ownerB),
    (error) => error instanceof ObjectNotFoundError,
  );
  assert.equal(
    (await pool.query("SELECT id FROM account_files WHERE owner_id = $1 AND library_ref = $2 AND version_id = $3", [ownerB, oldVersion.library_ref, oldVersion.version_id])).rows.length,
    0,
  );
  const app = express();
  app.use(clerkMiddleware());
  app.use((req, _res, next) => {
    const userId = req.get("x-test-user");
    const clerkAuth = req.auth;
    const syntheticAuth = (options) => ({ ...clerkAuth(options), userId: userId || null });
    syntheticAuth[Symbol.for("@clerk/express.auth")] = true;
    req.auth = syntheticAuth;
    next();
  });
  app.use(accountFilesRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    const routeUrl = `http://127.0.0.1:${address.port}/account-files/reference/${encodeURIComponent(fileSpecs[3].libraryRef)}/${encodeURIComponent(fileSpecs[3].versionId)}/download`;
    const allowed = await fetch(routeUrl, {
      headers: { "x-test-user": ownerA, "X-Ledger-Account-Scope": getAccountScope(ownerA) },
    });
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get("content-disposition"), /attachment/i);
    assert.equal(allowed.headers.get("content-type"), "application/octet-stream");
    assert.equal(allowed.headers.get("x-content-type-options"), "nosniff");
    assert.match(allowed.headers.get("content-security-policy"), /sandbox/);
    const downloaded = Buffer.from(await allowed.arrayBuffer());
    assert.deepEqual(downloaded, fileSpecs[3].bytes);
    assert.equal(createHash("sha256").update(downloaded).digest("hex"), fileSpecs[3].sha256);

    const bareRef = fileSpecs[9].libraryRef;
    const bareHeaders = {
      "x-test-user": ownerA,
      "X-Ledger-Account-Scope": getAccountScope(ownerA),
    };
    const resolved = await fetch(
      `http://127.0.0.1:${address.port}/account-files/resolve?library_ref=${encodeURIComponent(bareRef)}`,
      { headers: bareHeaders },
    );
    assert.equal(resolved.status, 200);
    const resolvedBody = await resolved.json();
    assert.equal(resolvedBody.files.length, 1);
    assert.equal(resolvedBody.files[0].version_id, null);
    assert.equal(resolvedBody.files[0].source_version, String(fileSpecs[9].version));
    const localDownloadPath = resolvedBody.files[0].download_path.replace(/^\/api/, "");
    assert.match(localDownloadPath, new RegExp(`${encodeURIComponent(bareRef)}/download$`));
    const bareDownload = await fetch(`http://127.0.0.1:${address.port}${localDownloadPath}`, { headers: bareHeaders });
    assert.equal(bareDownload.status, 200);
    assert.equal(bareDownload.headers.get("content-type"), "application/octet-stream");
    assert.match(bareDownload.headers.get("content-disposition"), /attachment/i);
    const bareBytes = Buffer.from(await bareDownload.arrayBuffer());
    assert.deepEqual(bareBytes, fileSpecs[9].bytes);
    assert.equal(createHash("sha256").update(bareBytes).digest("hex"), fileSpecs[9].sha256);

    const ambiguousRowId = randomUUID();
    await pool.query(
      `INSERT INTO account_files
         (id, owner_id, source_library_id, source_file_id, source_version, source_version_type,
          library_ref, version_id, file_name, mime_type, byte_size, sha256, object_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        ambiguousRowId, ownerA, "synthetic-library-extra", "synthetic-file-extra",
        "alternate", "string", bareRef, "alternate-document-version",
        "alternate-history.txt", "text/plain", 1, "0".repeat(64),
        `/objects/account-files/${randomUUID()}`,
      ],
    );
    try {
      const ambiguousResolution = await fetch(
        `http://127.0.0.1:${address.port}/account-files/resolve?library_ref=${encodeURIComponent(bareRef)}`,
        { headers: bareHeaders },
      );
      assert.equal(ambiguousResolution.status, 409);
      const ambiguousDownload = await fetch(
        `http://127.0.0.1:${address.port}/account-files/reference/${encodeURIComponent(bareRef)}/download`,
        { headers: bareHeaders },
      );
      assert.equal(ambiguousDownload.status, 409);
    } finally {
      await pool.query("DELETE FROM account_files WHERE owner_id = $1 AND id = $2", [ownerA, ambiguousRowId]);
    }

    const denied = await fetch(routeUrl, {
      headers: { "x-test-user": ownerB, "X-Ledger-Account-Scope": getAccountScope(ownerB) },
    });
    assert.equal(denied.status, 404);
    const anonymous = await fetch(routeUrl);
    assert.equal(anonymous.status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  await assert.rejects(
    commitAccountImport(pool, trackingStorage(), ownerA, preparedFromSource()),
    (error) => error instanceof AccountImportError && error.status === 409,
  );
  assert.equal(Number((await ownerCounts(ownerA)).files), 11);
  passed.push("11-file import, original and historical mapping, private bytes and hashes, raw receipt/ledger preservation, cross-owner denial, duplicate rejection");

  const occupiedData = { projects: [], tasks: [], documents: [], pending: [], settings: {}, reminderLog: [] };
  await pool.query(
    "INSERT INTO accounts (id, display_name, status, created_at) VALUES ($1, $2, $3, $4)",
    [occupiedOwner, "Synthetic occupied", "active", new Date(timestamp)],
  );
  createdOwners.add(occupiedOwner);
  await pool.query(
    "INSERT INTO ledgers (owner_id, revision, data, last_operation, updated_at) VALUES ($1, 0, $2::jsonb, $3, $4)",
    [occupiedOwner, JSON.stringify(occupiedData), "", new Date(timestamp)],
  );
  await assert.rejects(
    commitAccountImport(pool, trackingStorage(), occupiedOwner, preparedFromSource()),
    (error) => error instanceof AccountImportError && error.status === 409 && error.code === "DESTINATION_NOT_EMPTY",
  );
  assert.equal(Number((await ownerCounts(occupiedOwner)).files), 0);
  passed.push("pre-existing synthetic target rejected before attachment writes");

  const rollbackPrepared = preparedFromSource();
  await assert.rejects(
    commitAccountImport(pool, trackingStorage(true), rollbackOwner, rollbackPrepared),
    (error) => error instanceof AccountImportError && error.code === "VERIFY_FAILED",
  );
  createdOwners.add(rollbackOwner);
  assert.deepEqual(await ownerCounts(rollbackOwner), {
    accounts: 0, ledgers: 0, operations: 0, images: 0, recognitions: 0, files: 0, imports: 0,
  });
  for (const path of writtenPaths.filter((value) => value.includes(rollbackPrepared.importId))) {
    let exists = false;
    try {
      const file = await storage.getObjectEntityFile(path);
      [exists] = await file.exists();
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }
    assert.equal(exists, false, "rollback left a staged private object");
  }
  passed.push("injected verification failure rolled back database rows and removed staged private objects");

  const archive = await exportAccountBackupArchive(ownerA);
  const zip = unzipSync(new Uint8Array(archive));
  const snapshotText = Buffer.from(zip["account-snapshot.json"]).toString("utf8");
  const manifestBytes = zip["library-files-manifest.json"];
  assert.ok(snapshotText && manifestBytes);
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  assert.equal(manifest.files.length, 11);
  assert.equal(manifest.files.filter((file) => file.version_id === null).length, 2);
  assert.equal(manifest.files.find((file) => file.library_ref === fileSpecs[9].libraryRef).version, 10);
  const attachments = Object.entries(zip)
    .filter(([path]) => path.startsWith("files/") || path.startsWith("images/"))
    .map(([path, bytes]) => ({ originalname: path.split("/").at(-1), buffer: Buffer.from(bytes) }));
  const roundTrip = parseAccountSnapshot(
    snapshotText,
    { originalname: "library-files-manifest.json", buffer: Buffer.from(manifestBytes) },
    attachments,
  );
  assert.equal(roundTrip.fileValidation.can_import, true);
  assert.equal(roundTrip.files.length, 11);
  assert.equal(roundTrip.operations[0].receiptRaw, source.receiptRaw);
  await commitAccountImport(pool, trackingStorage(), ownerB, roundTrip);
  createdOwners.add(ownerB);
  await verifyFiles(ownerB, fileSpecs);
  assert.equal(Number((await ownerCounts(ownerB)).files), 11);
  passed.push(`complete ZIP export and re-import to a second synthetic owner; 11 files verified (${archive.length} bytes)`);

  console.log(JSON.stringify({ result: "PASS", passed }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    result: "FAIL",
    passed,
    error: { name: error?.name, code: error?.code, message: error?.message, stack: error?.stack },
  }, null, 2));
  process.exitCode = 1;
} finally {
  const ownersToClean = [...new Set([...eligibleOwners, ...createdOwners])];
  const dbPaths = ownersToClean.length
    ? await pool.query(
      "SELECT object_path FROM images WHERE owner_id = ANY($1::text[]) UNION SELECT object_path FROM account_files WHERE owner_id = ANY($1::text[])",
      [ownersToClean],
    ).catch(() => ({ rows: [] }))
    : { rows: [] };
  const paths = [...new Set([...writtenPaths, ...dbPaths.rows.map((row) => row.object_path)])];
  const deleteResults = await Promise.allSettled(paths.map((path) => storage.deletePrivateObject(path)));
  const failedDeletes = deleteResults.filter((result) => result.status === "rejected");
  if (ownersToClean.length) {
    await pool.query("DELETE FROM accounts WHERE id = ANY($1::text[])", [ownersToClean]);
  }
  const remaining = [];
  for (const owner of ownersToClean) {
    const counts = await ownerCounts(owner);
    if (Object.values(counts).some((count) => Number(count) !== 0)) remaining.push({ owner, counts });
  }
  await pool.end();
  if (failedDeletes.length || remaining.length) {
    console.error(JSON.stringify({ cleanup: "INCOMPLETE", failed_object_deletes: failedDeletes.length, remaining }, null, 2));
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify({
      cleanup: "PASS",
      synthetic_owners_removed: ownersToClean.length,
      private_objects_removed: paths.length,
    }));
  }
}
