# Standalone website CMS

Owner decision (2026-09-27): independent website backend; initially only the owner, Google login (supersedes the first GitHub-login release). Preserve the option to add password accounts and roles later.

## Current implementation and ownership

- `admin.huiwen.tw`: Cloudflare Access, Google IdP only; policy restricts the exact personal Google email specified by the owner. Worker additionally verifies issuer, audience, expiration, signature, owner email hash and active owner role on every request, including static assets. Only the email hash is committed. An owner email change requires deliberate policy/config update. The stable internal account ID retains its legacy GitHub prefix so existing document and audit ownership do not change; it is not a second accepted login method.
- D1 contains drafts, immutable versions, immutable publication requests and source snapshots. Draft saves use optimistic version checks; conflict returns 409. Restore creates a new version. Duplicate publication clicks reuse the same request.
- The authenticated dashboard is page-first: it lists the public page tree, opens the selected production page in an in-context iframe, and marks editable copy in place. General page text edits are stored in `data/page-content.json`, rebuilt from the page's canonical source, and released through the guarded GitHub PR/Pages pipeline. Shared layout, navigation, and styles remain source-controlled. The structured achievement editor updates reviewed fields in `data/achievements.json`, including the order of optional sections, paragraphs, history, sources, public media links, and existing local photos. The existing structured activity and legal-schedule forms stay available below the page editor.
- GitHub remains the executable canonical source. Drafts are not published until the existing source builders, path allowlist and required GitHub checks pass. The adapter reuses `publish_from_notion.py`; the legacy `notion-publish/` technical branch prefix is intentionally preserved for its trusted gate.
- `SITE_CMS_AUTHORING=standalone` is the explicit events/legal authoring cutover. It disables the legacy Notion executor and enables queue consumption. `CMS_ENABLED=true` enables source sync/reconciliation. Before cutover, only sync runs. Notion is a status projection after cutover; do not edit it as a second source.
- Original excluded petition/Notion intake scope remains unchanged.

## Full-site deployment catalogue

The publisher derives every public HTML route from the same reviewed allowlist used by the Pages artifact builder. `scripts/page_authority.py` assigns each route a source file and editor scope. The authenticated backend lists the route tree, including its child pages, and shows publication and draft status. The existing 104-route catalogue includes historical redirects, 404, offline and the excluded petition page; those special routes remain read-only. New root-level routes require source classification before catalogue sync; nested static pages are treated as their own canonical HTML source.

`/internal/sync` updates this D1 projection after GitHub OIDC verification. The page list is committed-source metadata, not a new authoring authority; syncing it cannot change any public page. The authenticated `/api/page-preview` endpoint fetches only a currently published path in this catalogue and returns its deployed HTML with the original page URL as the base. This lets the editor render the actual published design while avoiding the browser's failing direct cross-origin iframe navigation. The preview response is not cached, has a page-specific Content Security Policy, and runs inside a sandbox without `allow-same-origin`; page scripts cannot access the authenticated dashboard. It removes Cloudflare's Rocket Loader wrapper and marks JavaScript as `data-cfasync="false"` only in the CMS response, preserving the site's normal script order inside the sandbox; the editor runtime also announces readiness before the parent sends its nonce-bound initialization message. The 96 editable routes support plain-text leaf blocks inside `<main>`; achievement detail pages additionally use structured fields for dates, sources, sections and media. Scripts, arbitrary markup, shared navigation and styling cannot be edited from the CMS. The other eight special routes remain visible as read-only previews. Selector and source-hash data ship as per-page JSON sidecars in the Pages artifact and are fetched only when the CMS opens a page in its editor iframe; they do not inflate public page HTML or load for ordinary visitors. The Pages build applies approved text from `data/page-content.json` to the artifact without rewriting canonical page source. Unsupported or stale text selectors fail closed and require source review. The petition intake flow remains excluded.

The achievement editor offers keyboard-accessible up/down and direct-position controls for repeatable items, plus section up/down controls. Empty optional groups remain visible for editing and disappear from the public page until populated. Existing local photos may only be reordered, not added or deleted from this editor; the publisher checks the photo set and original source version before accepting the draft. The left page catalogue can be sorted by URL, title, draft presence, or edit time without changing public navigation.

Page drafts and immutable edit versions are held in D1. Publishing, unpublishing, moving a page to the trash, and restoring it each create an immutable publication request. “Delete” is a recoverable lifecycle status: it removes the page from the public sitemap and Pages artifact but preserves its Git source and D1 history. Restoring it rebuilds the page and sitemap entry. These actions use the same queue, path guard, required checks, auto-merge rules and Production verification as other CMS updates; the editor has no direct Production write path.

## Deployment

Worker metadata, Access application, D1 and GitHub repository connection were provisioned for this named backend only. The named `huiwen-cms.lihong.workers.dev` origin is enabled for authenticated machine calls only; preview URLs are disabled. Its root, assets and admin API paths return 404. Main → Workers Builds runs checks, additive D1 migrations, and Worker deployment. No local production Wrangler deployment or deploy token is used. Cloudflare Build credential remains in Cloudflare.

`huiwen-cms.lihong.workers.dev` only accepts `/internal/*` with GitHub Actions OIDC: exact issuer, audience, repository and owner numeric IDs, main ref, `cms-publisher.yml`, environment `notion-publisher`, and schedule/manual event. It serves no UI or public data. The Worker holds no GitHub App private key. The existing repository-scoped App remains inside GitHub Actions.

Every 15 minutes (GitHub scheduling may delay), the job imports main snapshots, reconciles pending publications, and consumes at most one immutable request. A 30-minute lease protects each request; a crashed job retries the same content-derived PR. Stale source hashes fail closed and require loading the current published version. No direct merge API exists. GitHub auto-merge still requires repository rules and checks.

Status boundaries: saved draft → queued → building → PR/checks → merged → deployed → verified. A CI/network verification failure must not be displayed as fully verified. Existing external HTTP/snapshot/native verification layers are reused. Production no-op validation may verify queue handling without changing public bytes; it does not prove a changed-content release.

Every Pages release also runs `scripts/verify_all_pages.py` against the exact HTML roster from `build_public.public_paths()`. It checks each published route's title, language, canonical URL, description, main heading, visible copy and critical facts, or the redirect target for legacy aliases. This verifies deployment coverage separately from the editor's plain-text scope.

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

## Monthly consultation calendar and card

The existing legal-current document remains the single versioned CMS editing slot. In Activities and services → Legal consultation, choose the month, assign each Tuesday–Saturday date to a lawyer or “none/cancelled”, and edit the weekday start/end times. A month change rebuilds the correct dates and leaves assignments unconfirmed; it never guesses a rotation. Pending dates can be saved as a private versioned draft, but cannot enter the publication queue. Preview publication still reads the saved version and compares it with the published source.

The publisher projects the confirmed sessions, professional lawyer names, explicit non-service dates and weekday times into data/legal-schedule.json. Date times must agree with the weekday settings. Moving to a later published month archives the previous schedule without nested history; published history is preserved and cannot overwrite the current month backwards. The public page and print sheet read this same source. Public visitors see calendar/list/card controls and can download a 1920×1080 PNG; the staff editor is never included in the public artifact. The public past-month accordion and Canva embed were removed at the owner’s request on 2026-10-02 (Asia/Taipei). Source history and the external Canva original remain intact; only the current monthly calendar/list/card is displayed.

The renderer and licensed assets have one reviewed source and deterministic copies in the authenticated admin bundle; tests compare every byte. Font and portrait assets load when the card is opened or downloaded. Existing private drafts remain preserved: if the source has advanced, use “Load website version” after preserving any desired draft before editing or publishing. No new identity, role, credential, database or publication route is introduced.

## 首頁最新資訊與置頂（2026-10）

首頁「最新資訊」是衍生清單，不是另一份手動維護的清單。`scripts/latest_info.py` 讀取既有正本（`news.html` 的媒體報導、`press.html` 的新聞稿、新增專頁中 `news`／`press`／新增的 `daily` 分類，以及 `data/events.json`），產生 `data/latest-info.json` 與首頁列表。自然順序依可驗證的刊登或整理日期由新到舊：報導日期、發稿日期、專頁的 `updated`（整理日期），或活動固定不變的 `publishedAt`（不是活動開始時間）。同一天的項目依固定來源順序與來源內位置排列，結果可重現，建置不讀取當下時間。

置頂沿用既有首頁草稿欄位（`index.html` → `data/civic-home.json`）。選填的 `latestPinned` 最多三則；置頂項目依同一自然順序排在最前，新聞／日常／活動分頁只過濾同一順序。草稿沒有這個欄位時，代表保留已發布或草稿中已存的置頂；明確送 `[]` 才是清空；清單為空時不寫入，檔案維持原本三個欄位。版本衝突（409）規則不變，發布器會拒絕不存在、重複或超過三則的置頂與基準漂移（`BASE_DRIFT`）。

日常貼文使用同一套新增專頁模型（`page-daily-<slug>.html`），可填公開來源連結與直接圖片網址；由首頁最新資訊列出，不另外插入索引區。活動、新增專頁、首頁草稿與頁面上下架（`page-copy`）都可能改動 `index.html`、`data/latest-info.json` 與字型產物；path guard 只在以可信 base 程式碼重建該 PR 的來源檔，並逐一比對路徑、內容與權限後才接受。

已置頂的新聞或日常專頁不能直接下架或刪除：後台在排入佇列前就回覆「請先到首頁取消置頂並發布」，發布器也做同樣的權威檢查；`page-copy` 不會改寫首頁設定。沒有置頂的專頁可直接下架、刪除或恢復。

### 首頁編輯來源與有界讀取（2026-10-30）

`/api/home` 從 `published_pages` 記錄的 `index.html` 那一個 commit（raw GitHub）讀取 `data/civic-home.json`、`data/home-case-options.json` 與 `data/latest-info.json`，不再讀正式站。`data/home-case-options.json` 是建置產生的 435 筆精簡政績投影（id、title、summary、status、villages、scope、categories、funding、updated，約 262 KB），只供首頁編輯器與即時預覽使用。`/api/case` 從該頁 commit 讀完整 `data/achievements-public.json`（2026-10-30 實測 1,376,979 bytes），上限 2,000,000 bytes。所有讀取都經過 `admin/src/bounded-fetch.ts`：邊串流邊計算 UTF-8 bytes（header 只能提早拒絕，不能放行），超限即取消讀取，並標示是哪個來源失敗（不存在、HTTP 429、5xx、逾時、網路、超限、格式）。若記錄的 commit 早於這些檔案，`/api/home` 回 503「尚未同步」並保留草稿，不會改讀其他版本。

首頁只渲染各分頁前幾則，其餘候選以同一個 renderer 產生惰性的 `<template data-latest-reserve>` 複本；後台預覽因此能置頂完整清單中的任何一則，顯示結果與下一次建置相同。

reserve 的實測與後續門檻（2026-10-30，候選工作區）：47 則中 33 則在 reserve，33,710 bytes（gzip 6,170）；首頁 HTML 77,394 bytes（gzip 17,376）；首頁 DOM 643 個元素（A-05 預算 1,500，template 內容不計入 DOM）；本機未壓縮同源傳輸 481,107 bytes（基準版桌機 582,052、手機 468,566，主要差異是移除大人像圖）。reserve 隨收錄量線性成長；當首頁 HTML gzip 超過 40 KB，或 reserve 超過 150 則時，再評估改由後台依同一 revision 的 `latest-info.json` 提供預覽卡片。在那之前不截斷，以免舊項目置頂後無法預覽。
