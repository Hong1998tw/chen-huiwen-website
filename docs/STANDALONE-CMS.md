# Standalone website CMS

Owner decision (2026-09-27): independent website backend; initially only the owner, Google login (supersedes the first GitHub-login release). Preserve the option to add password accounts and roles later.

## Current implementation and ownership

- `admin.huiwen.tw`: Cloudflare Access, Google IdP only; policy restricts the exact personal Google email specified by the owner. Worker additionally verifies issuer, audience, expiration, signature, owner email hash and active owner role on every request, including static assets. Only the email hash is committed. An owner email change requires deliberate policy/config update. The stable internal account ID retains its legacy GitHub prefix so existing document and audit ownership do not change; it is not a second accepted login method.
- D1 contains drafts, immutable versions, immutable publication requests and source snapshots. Draft saves use optimistic version checks; conflict returns 409. Restore creates a new version. Duplicate publication clicks reuse the same request.
- First editing scope: public activities and the current legal consultation month. Structured forms, local preview, version restoration, publication receipts. Existing achievement evidence and private petition workflows are outside this first CMS release.
- GitHub remains the executable canonical source. Drafts are not published until the existing source builders, path allowlist and required GitHub checks pass. The adapter reuses `publish_from_notion.py`; the legacy `notion-publish/` technical branch prefix is intentionally preserved for its trusted gate.
- `SITE_CMS_AUTHORING=standalone` is the explicit events/legal authoring cutover. It disables the legacy Notion executor and enables queue consumption. `CMS_ENABLED=true` enables source sync/reconciliation. Before cutover, only sync runs. Notion is a status projection after cutover; do not edit it as a second source.
- Original excluded petition/Notion intake scope remains unchanged.

## Full-site deployment catalogue

The publisher derives every public HTML route from the same reviewed allowlist used by the Pages artifact builder. `scripts/page_authority.py` assigns each route a source file and an honest editor scope. The authenticated backend lists this catalogue with public and source links. It currently has 104 routes, including five historical redirects, 404, offline and the excluded petition page. New routes must receive an explicit source classification before the catalogue sync succeeds.

`/internal/sync` updates this read-only D1 projection after GitHub OIDC verification. The page list is committed-source metadata, not a new authoring authority; syncing it cannot change any public page. `none` means there is no backend editor for that page. `partial` means at least one source feeding the page is editable through the existing activities or legal-schedule editor; other text and sources still require their own reviewed authoring workflow. Composite pages use a primary source link for navigation, with other build inputs defined by `scripts/build_all.py` and its builders. The petition intake flow remains excluded.

## Deployment

Worker metadata, Access application, D1 and GitHub repository connection were provisioned for this named backend only. The named `huiwen-cms.lihong.workers.dev` origin is enabled for authenticated machine calls only; preview URLs are disabled. Its root, assets and admin API paths return 404. Main → Workers Builds runs checks, additive D1 migrations, and Worker deployment. No local production Wrangler deployment or deploy token is used. Cloudflare Build credential remains in Cloudflare.

`huiwen-cms.lihong.workers.dev` only accepts `/internal/*` with GitHub Actions OIDC: exact issuer, audience, repository and owner numeric IDs, main ref, `cms-publisher.yml`, environment `notion-publisher`, and schedule/manual event. It serves no UI or public data. The Worker holds no GitHub App private key. The existing repository-scoped App remains inside GitHub Actions.

Every 15 minutes (GitHub scheduling may delay), the job imports main snapshots, reconciles pending publications, and consumes at most one immutable request. A 30-minute lease protects each request; a crashed job retries the same content-derived PR. Stale source hashes fail closed and require loading the current published version. No direct merge API exists. GitHub auto-merge still requires repository rules and checks.

Status boundaries: saved draft → queued → building → PR/checks → merged → deployed → verified. A CI/network verification failure must not be displayed as fully verified. Existing external HTTP/snapshot/native verification layers are reused. Production no-op validation may verify queue handling without changing public bytes; it does not prove a changed-content release.

Every Pages release now also runs `scripts/verify_all_pages.py` against the exact HTML roster from `build_public.public_paths()`. It checks each published route's title, language, canonical URL, description, main heading, visible copy and critical facts, or the redirect target for legacy aliases. This verifies deployment coverage; it does not make every page editable from this CMS. The first authoring scope remains activities and the current legal month. Full-page authoring must preserve each page's canonical source and cannot be inferred from the deployed-page count.

## Future account/password support

`accounts` and `identities` separate account ownership from login provider. Roles reserve owner/editor/viewer; only the seeded owner is currently accepted. Password login, password creation, registration and invitations are **not enabled**. Add a reviewed identity provider or dedicated password credential/session/reset module before exposing these controls; do not store plaintext passwords, fabricate working account buttons, or weaken Access to enable them.

## Checks and limits

`npm ci --ignore-scripts --prefix admin`; `npm run check --prefix admin`; `npm test --prefix admin`; `node admin/tests/integration.mjs`; `python -m unittest discover -s tests -p test_standalone_cms.py`.

Local integration uses synthetic signing keys, local Worker/D1 and exact migration; it tests authentication, asset protection, CSRF, persistence, version conflict, restore and immutable publication snapshots. Synthetic tests are not evidence of real Google owner login. Closeout must separately record native owner login, real D1 readback, OIDC job, Worker build/deployment and public-site release.

## Initial deployment incident

The first source sync to `cms-publisher.huiwen.tw` returned HTTP 403. Cloudflare native Security Events identified `botFight` managed challenges at `/internal/sync`. The machine endpoint uses this Worker’s dedicated workers.dev origin, with the same strict signed OIDC checks; admin UI remains only on Access-protected `admin.huiwen.tw`. No zone bot protection, WAF, Access policy, or GitHub permission was disabled or widened. [Cloudflare documents that Bot Fight Mode cannot be skipped with custom rules](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/).

The repository OIDC customization readback is `use_default=true`, `use_immutable_subject=true`. Runner verification requires the exact signed immutable subject `repo:Hong1998tw@126787497/chen-huiwen-website@1360942570:environment:notion-publisher`, as well as matching repository and owner IDs, workflow, main ref, issuer, audience and expiry. A separate environment claim may be absent; if present, it must also match. Invalid claim diagnostics contain only fixed field names, never values or JWTs. [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).

## Google login cutover gate

Google Cloud project: `huiwen-website-cms-20260927` (Huiwen Website CMS). Use a dedicated web OAuth client with callback `https://twhong.cloudflareaccess.com/cdn-cgi/access/callback`. Client secret belongs only in Cloudflare identity-provider configuration; never in this repository, archives, logs or chat.

This code alone does not prove Google login is active. Before merging, provision and test the Google IdP. Coordinate the Worker email hash and app-specific Access policy: exact approved email, require Google IdP, allowed IdPs restricted to Google, four-hour sessions and HttpOnly retained. Revoke this app's old sessions after cutover; verify anonymous redirect, successful real owner login, preserved D1 ownership, and rejection of a non-owner. Do not widen other applications or reuse the separate office application OAuth client. If provisioning is incomplete, keep this branch unmerged and the existing production login operational.
