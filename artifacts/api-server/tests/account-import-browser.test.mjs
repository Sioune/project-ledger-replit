import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { receiveBackup } from "../src/lib/account-import-upload.ts";

const chromiumPath = process.env.CHROMIUM_PATH ?? "chromium";

function runChromium(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(chromiumPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Chromium timed out. ${stderr}`));
    }, 45_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

test("Chromium FormData upload preserves Unicode, ASCII, mixed, and mojibake-like literal names", async () => {
  assert.ok(existsSync(chromiumPath), `Chromium is required for this regression test: ${chromiumPath}`);

  const fixtures = [
    { name: "方案-最终版.pdf", bytes: Buffer.from("%PDF-1.7 synthetic Chinese name") },
    { name: "report-2026-11.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    { name: "résumé_日本語-提案.docx", bytes: Buffer.from("synthetic mixed Unicode filename") },
    { name: "Ã©.txt", bytes: Buffer.from("valid literal name; do not decode twice") },
  ].map(({ name, bytes }) => ({
    name,
    base64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));

  const app = express();
  app.get("/browser-upload-test", (_req, res) => {
    res.type("html").send(`<!doctype html><meta charset="utf-8"><pre id="result"></pre><script>
      const fixtures = ${JSON.stringify(fixtures)};
      const form = new FormData();
      for (const item of fixtures) {
        const raw = atob(item.base64);
        const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
        form.append("attachments", new Blob([bytes], { type: "application/octet-stream" }), item.name);
      }
      const request = new XMLHttpRequest();
      request.open("POST", "/browser-upload-receive", false);
      request.send(form);
      document.querySelector("#result").textContent =
        JSON.stringify({ status: request.status, payload: JSON.parse(request.responseText) });
    </script>`);
  });
  app.post("/browser-upload-receive", receiveBackup, (req, res) => {
    const files = req.files?.attachments ?? [];
    res.json({
      files: files.map((file) => ({
        name: file.originalname,
        sha256: createHash("sha256").update(file.buffer).digest("hex"),
      })),
    });
  });

  const server = app.listen(0, "127.0.0.1");
  const profileDir = mkdtempSync(join(tmpdir(), "account-import-chromium-"));
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await runChromium([
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      "--dump-dom",
      `http://127.0.0.1:${address.port}/browser-upload-test`,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const resultText = result.stdout.match(/<pre id="result">([^<]*)<\/pre>/)?.[1];
    assert.ok(resultText, `Browser did not return upload results: ${result.stdout}`);
    const browserResult = JSON.parse(resultText);
    assert.equal(browserResult.status, 200);
    assert.deepEqual(browserResult.payload.files, fixtures.map(({ name, sha256 }) => ({ name, sha256 })));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(profileDir, { recursive: true, force: true });
  }
});
