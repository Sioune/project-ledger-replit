# Backup and restore

## Account-level archive

A signed-in user can download a complete account archive from the app's account/data controls. It contains a JSON snapshot, Library file manifest, and original image and Library file bytes. The manifest records source identifiers, Library version, optional ledger document version, filename, MIME type, byte size, and SHA-256. Keep the archive encrypted and private.

To restore, sign in to the intended destination account, open the private import dialog, select the snapshot, manifest, and every original file (or the supported complete ZIP), review all counts and file checks, then explicitly confirm. Import refuses to overwrite business records, rejects missing/extra/ambiguous files and hash/size mismatches, scopes the result to the signed-in account, and protects against duplicate execution. HTML attachments download as files and are never run as same-origin pages.

Do not edit original receipts or invent missing version IDs. An unversioned Library file must remain explicitly unversioned in the manifest.

## Service-level disaster recovery

Account archives are not a substitute for infrastructure backup. Schedule encrypted PostgreSQL backups (for example `pg_dump --format=custom`) and enable object versioning/retention or a separately encrypted object-store backup for private and public buckets. Store backups outside the application repository and web-served directories; restrict access and periodically test restores in isolation. Record the schema version and object-store inventory with each backup.

Restore sequence: provision an isolated replacement, restore PostgreSQL and matching object-store versions, validate counts and hashes, verify login and account isolation, then switch traffic only after owner approval. Never restore a database dump or object archive over a live instance without an approved maintenance plan.
