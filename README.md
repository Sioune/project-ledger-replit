# 项目簿 | Project Ledger

A Chinese-language, account-isolated project and progress ledger. It supports projects, tasks, schedules, image intake, operation receipts, private attachments, and verified account backup/restore.

## Self-hosting at a glance

The app consists of a React/Vite web client, an Express API, PostgreSQL, Clerk authentication, and Google Cloud Storage for private files. This export uses Google Application Default Credentials instead of a platform storage sidecar.

Requirements: Node.js 22+, pnpm 10+, PostgreSQL 15+, a Clerk application, and Google Cloud Storage. Prefer workload identity; do not put service-account keys in this repository.

1. Copy `.env.example` to `.env` and fill it using a local secret manager.
2. Install: `pnpm install --frozen-lockfile`.
3. For a brand-new, dedicated database only, apply the schema: `pnpm --filter @workspace/db run push`. Never use this against an existing database without a reviewed migration and backup.
4. Start the API and web dev server in separate terminals using [docs/self-hosting.md](docs/self-hosting.md).
5. For production, build the web client and API, then configure a reverse proxy as described in the self-hosting guide.

## Checks

- `pnpm run typecheck`
- `pnpm run build`
- `pnpm --filter @workspace/api-server run test:account-import` (requires Chromium; set `CHROMIUM_PATH` if it is not on PATH)

The database/object-storage end-to-end import test is separate and must only run against disposable synthetic infrastructure.

## Backup and restore

Use the signed-in app's full account backup download to obtain the account snapshot and original attachments. Restore only through the authenticated import preview, inspect all counts and hashes, then explicitly confirm. Existing business data, incomplete file sets, mismatched hashes, and duplicate imports are rejected. See [docs/backup-restore.md](docs/backup-restore.md).

## Public release status

This is a source-only review copy. It contains no Git history, database, account data, private attachments, credentials, or deployment identifiers. Before publishing, review [docs/release-review.md](docs/release-review.md) and confirm copyright/third-party notices.
