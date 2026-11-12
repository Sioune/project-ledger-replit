import type { Request } from "express";
import multer from "multer";

type ImportRequest = Request & { importUploadBytes?: number };
export type StoredImportFile = Express.Multer.File & { buffer: Buffer };

const MAX_MULTIPART_BYTES = 128_000_000;
const MAX_SINGLE_FILE_BYTES = 64_000_000;

const boundedMemoryStorage: multer.StorageEngine = {
  _handleFile(req, file, callback) {
    const request = req as ImportRequest;
    const chunks: Buffer[] = [];
    let fileBytes = 0;
    let completed = false;
    const failUpload = (error: Error) => {
      if (completed) return;
      completed = true;
      file.stream.resume();
      callback(error);
    };
    file.stream.on("data", (chunk: Buffer) => {
      if (completed) return;
      fileBytes += chunk.length;
      request.importUploadBytes = (request.importUploadBytes ?? 0) + chunk.length;
      if (fileBytes > MAX_SINGLE_FILE_BYTES || request.importUploadBytes > MAX_MULTIPART_BYTES) {
        failUpload(new multer.MulterError("LIMIT_FILE_SIZE", file.fieldname));
        return;
      }
      chunks.push(chunk);
    });
    file.stream.on("error", failUpload);
    file.stream.on("end", () => {
      if (completed) return;
      completed = true;
      callback(null, { buffer: Buffer.concat(chunks), size: fileBytes });
    });
  },
  _removeFile(_req, file, callback) {
    delete (file as Partial<StoredImportFile>).buffer;
    callback(null);
  },
};

// Browser FormData emits filename parameter bytes as UTF-8. Decode them at the
// multipart parser boundary; never heuristically decode the resulting Unicode
// names again, which could corrupt valid names that resemble mojibake.
export const receiveBackup = multer({
  storage: boundedMemoryStorage,
  defParamCharset: "utf8",
  limits: { files: 66, fields: 0, parts: 66, fileSize: MAX_SINGLE_FILE_BYTES },
}).fields([
  { name: "snapshot", maxCount: 1 },
  { name: "manifest", maxCount: 1 },
  { name: "attachments", maxCount: 64 },
]);
