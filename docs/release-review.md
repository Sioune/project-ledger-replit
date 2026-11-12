# Release review checklist

This source copy was assembled from the current workspace checkout. Deployment metadata confirms an active successful deployment but does not expose a source revision, so the owner must confirm that this checkout matches the published version intended for release.

Before creating the new public repository, manually confirm:

- The current workspace checkout is the desired released feature set.
- The MIT license holder and each vendored UI/style asset's required notices are correct.
- Clerk, Google Cloud, database, DNS, and TLS settings are supplied by the new operator, not copied from the private project.
- No newly added private examples, source maps, test reports, or credentials are present.
- The archive is reviewed independently before pushing to GitHub.

No repository was created, no Git remote was added, and no commit or push was made.
