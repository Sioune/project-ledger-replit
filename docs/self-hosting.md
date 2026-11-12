# Self-hosting

## Required services

- PostgreSQL 15+, dedicated to this instance.
- A Clerk application configured for the deployment hostname, sign-in methods, and allowed origins.
- Google Cloud Storage with separate private and optional public buckets. The API uses Application Default Credentials; workload identity is preferred. The identity needs object read/write/delete and signing rights. Signed upload URLs may require IAM Credentials `signBlob` or a supported service-account signer.
- A TLS reverse proxy routing `/api/*` to the API and other paths to the built SPA.

## Environment

Start from `.env.example`. Required values are `DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `VITE_CLERK_PUBLISHABLE_KEY`. Set `VITE_CLERK_PROXY_URL=/api/__clerk` for a same-origin Clerk proxy. `PRIVATE_OBJECT_DIR` must be `/bucket-name/private-prefix`; keep that bucket private. `PUBLIC_OBJECT_SEARCH_PATHS` must point only to a separate bucket/prefix intended for public assets. `GOOGLE_APPLICATION_CREDENTIALS` is optional when workload identity is available; if used, keep that file outside the repository.

`VITE_*` values are embedded into the browser build; never put a secret key behind a `VITE_` name.

## Local development

On Bash, load `.env` in each terminal without adding it to Git. Start the API:

```sh
set -a; source .env; set +a
PORT=8080 pnpm --filter @workspace/api-server run dev
```

In a second terminal start the web client:

```sh
set -a; source .env; set +a
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/spoken-project-ledger run dev
```

Vite proxies `/api` to `127.0.0.1:8080`.

## Production build and routing

```sh
set -a; source .env; set +a
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/spoken-project-ledger run build
PORT=8080 NODE_ENV=production pnpm --filter @workspace/api-server run start
```

Serve `artifacts/spoken-project-ledger/dist/public` as an SPA and reverse-proxy `/api/*` to the API. Forward the original `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`. Terminate TLS at a trusted proxy, limit upload body sizes, and restrict API origins. Keep PostgreSQL and GCS access on private network paths.

For an initial empty database only, `pnpm --filter @workspace/db run push` creates the schema. Review schema diffs and take a recoverable backup before changing an existing database.

## Storage safety

Set `PRIVATE_OBJECT_DIR` to a private bucket/prefix. Do not make that bucket public. Bucket-level IAM controls access; the app also checks owner policy metadata before returning private files. Configure bucket CORS only for the app origin and required methods/headers. Keep public assets in a separate bucket and never put account exports or imported files there.
