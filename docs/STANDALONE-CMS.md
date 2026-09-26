# Standalone website CMS

Owner decision (2026-09-27): independent website backend; initially only Hong1998tw, GitHub login. Preserve the option to add password accounts and roles later.

## Current implementation and ownership

- `admin.huiwen.tw`: Cloudflare Access, GitHub IdP only; policy restricts the verified primary email observed on the signed-in owner's GitHub settings. Worker additionally verifies issuer, audience, expiration, signature, owner email hash and active owner role on every request, including static assets. Only the email hash is committed. An owner email change requires deliberate policy/config update.
- D1 contains drafts, immutable versions, immutable publication requests and source snapshots. Draft saves use optimistic version checks; conflict returns 409. Restore creates a new version. Duplicate publication clicks reuse the same request.
- First editing scope: public activities and the current legal consultation month. Structured forms, local preview, version restoration, publication receipts. Existing achievement evidence and private petition workflows are outside this first CMS release.
- GitHub remains the executable canonical source. Drafts are not published until the existing source builders, path allowlist and required GitHub checks pass. The adapter reuses `publish_from_notion.py`; the legacy `notion-publish/` technical branch prefix is intentionally preserved for its trusted gate.
- `SITE_CMS_AUTHORING=standalone` is the explicit events/legal authoring cutover. It disables the legacy Notion executor and enables queue consumption. `CMS_ENABLED=true` enables source sync/reconciliation. Before cutover, only sync runs. Notion is a status projection after cutover; do not edit it as a second source.
- Original excluded petition/Notion intake scope remains unchanged.

## Deployment

Worker metadata, Access application, D1 and GitHub repository connection were provisioned for this named backend only. `workers_dev` and preview URLs are disabled. Main → Workers Builds runs checks, additive D1 migrations, and Worker deployment. No local production Wrangler deployment or deploy token is used. Cloudflare Build credential remains in Cloudflare.

`cms-publisher.huiwen.tw` only accepts `/internal/*` with GitHub Actions OIDC: exact issuer, audience, repository and owner numeric IDs, main ref, `cms-publisher.yml`, environment `notion-publisher`, and schedule/manual event. It serves no UI or public data. The Worker holds no GitHub App private key. The existing repository-scoped App remains inside GitHub Actions.

Every 15 minutes (GitHub scheduling may delay), the job imports main snapshots, reconciles pending publications, and consumes at most one immutable request. A 30-minute lease protects each request; a crashed job retries the same content-derived PR. Stale source hashes fail closed and require loading the current published version. No direct merge API exists. GitHub auto-merge still requires repository rules and checks.

Status boundaries: saved draft → queued → building → PR/checks → merged → deployed → verified. A CI/network verification failure must not be displayed as fully verified. Existing external HTTP/snapshot/native verification layers are reused. Production no-op validation may verify queue handling without changing public bytes; it does not prove a changed-content release.

## Future account/password support

`accounts` and `identities` separate account ownership from login provider. Roles reserve owner/editor/viewer; only the seeded owner is currently accepted. Password login, password creation, registration and invitations are **not enabled**. Add a reviewed identity provider or dedicated password credential/session/reset module before exposing these controls; do not store plaintext passwords, fabricate working account buttons, or weaken Access to enable them.

## Checks and limits

`npm ci --ignore-scripts --prefix admin`; `npm run check --prefix admin`; `npm test --prefix admin`; `node admin/tests/integration.mjs`; `python -m unittest discover -s tests -p test_standalone_cms.py`.

Local integration uses synthetic signing keys, local Worker/D1 and exact migration; it tests authentication, asset protection, CSRF, persistence, version conflict, restore and immutable publication snapshots. Synthetic tests are not evidence of real GitHub owner login. Closeout must separately record native owner login, real D1 readback, OIDC job, Worker build/deployment and public-site release.
