# Security

- Keep production credentials in a secret manager or workload identity, never in Git, issue reports, screenshots, or test fixtures.
- Use HTTPS, a trusted reverse proxy, and an allowlisted Clerk domain. Disable public sign-up or restrict enrollment if the instance is private.
- Use a dedicated PostgreSQL database and separate private/public object-storage buckets. Keep the private bucket non-public; do not grant `allUsers` access.
- Private file downloads are authenticated, owner-scoped, hash-verified, and returned as attachments with `nosniff` and a restrictive CSP.
- Never serve uploaded HTML as same-origin active content.
- Do not run schema changes or restore operations against a production database without a verified backup and maintenance plan.
- Run end-to-end migration tests only with a disposable database and a dedicated synthetic storage bucket.

Report suspected vulnerabilities privately to the repository maintainer; do not include personal backups, real account identifiers, or credentials in reports.
