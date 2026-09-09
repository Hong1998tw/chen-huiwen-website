# www.huiwen.tw Pre-cutover Runtime Snapshot — 2026-09-09

本文件記錄 Phase 4/5/6/7 Release Candidate 完成後、正式 Production cutover 前的可驗證 Runtime State 與未知項目。它只作治理與回滾基準，不代表已授權切換。

## 1. GitHub Canonical Source

- Repository：`Hong1998tw/chen-huiwen-website`
- Canonical branch：`main`
- 正式 `main` baseline：`e89ae5445ee43fb86e91e9a6ea646648820d570d`
- Production source 尚未合併 PR #22。
- 現行 `main` canonical host 仍為 GitHub Pages host。

## 2. Migration Release Candidate

- PR：#22
- Branch：`seo/huiwen-domain-phase4-v2`
- PR 狀態：Draft / open / mergeable
- Current RC head：`6053b7bc3d2909487744dbc5079eeaee65dabfae`
- 目標 canonical host：`https://www.huiwen.tw/`
- Sitemap：57 個 indexable URLs
- Legacy inventory：18 筆
- Cloudflare Bulk Redirect candidate：15 筆 path-only 301
- Homepage query Single Redirect candidate：1 筆
- `/0?...`：首日維持 404，不執行 410

## 3. CI / QA

最新 RC head：

- Validate canonical source #83：PASS
- Full-site browser and accessibility QA #58：PASS
- `validate_domain_migration.py`：PASS
- Build zero drift：PASS
- SEO regression tests：PASS

## 4. Successor Status

已完成正式 candidate successor：

- 鳳山車站 → `achievement-fengshan-station-overview.html`
- 美麗島 → `history-meilidao.html`
- 熊本災後互助 → `history-kumamoto-relief.html`
- 特教支持 → `achievement-special-education-support.html`
- 八德滯洪池 → `achievement-bade-detention.html`
- 五福市場 → `activity-market.html`
- 服務案件／網站聯絡 → `petition.html`
- 問政記錄 → `council-records.html`

## 5. Public Web Observation

2026-09-09 的目前工具可取得 `https://www.huiwen.tw/` 公開頁面內容，但該來源標記為較早的 crawl cache；內容仍為舊站型態，而不是 PR #22 candidate。

因此只能判定：

- 沒有證據顯示 PR #22 candidate 已意外成為 `www.huiwen.tw` Production。
- 不能把此 cached fetch 當作 cutover 當下的精確 HTTP／DNS Runtime State。

Apex `https://huiwen.tw/` 的獨立 fetch 在目前工具回傳 cache miss，狀態仍為未知／待 cutover 前重新驗證。

## 6. Cloudflare Runtime State

Cloudflare plugin 已完成安裝／連接流程，但本對話目前沒有暴露 Cloudflare 操作 namespace；因此尚不能直接讀取帳號內：

- Zone ID / zone status
- DNS records
- Proxy flags
- SSL/TLS mode
- Edge certificate status
- CAA
- Redirect Rules / Bulk Redirect Lists
- Cache Rules

上述項目全部標記：`UNKNOWN / PRE-CUTOVER SNAPSHOT REQUIRED`。

不得以公開 DNS、BuiltWith、舊聊天或本文件推測 Cloudflare 帳號內 Runtime State。

## 7. GitHub Pages Runtime State

GitHub Connector目前可驗證 repository、branch、PR、workflow 與 artifacts，但本工具 surface 不允許直接讀 GitHub Pages site settings endpoint。

因此以下仍須在 cutover 前實際確認：

- current custom domain
- enforce HTTPS
- certificate state
- Pages source/deployment mapping

目前 repo 沒有新增 `CNAME`，PR #22 也未 merge。

## 8. Cutover Gate

目前已 PASS：

- Canonical host candidate
- Sitemap / robots / structured data candidate
- Redirect engineering candidate
- Successor final review
- Migration CI
- Browser / Accessibility QA
- Rollback runbook

仍 PENDING：

1. Cloudflare actual Runtime snapshot
2. GitHub Pages custom-domain / TLS runtime snapshot
3. Cutover 當下 live DNS resolution
4. `www` live HTTP 200 before merge
5. apex → www runtime behavior
6. 使用者明確 Production cutover 授權

## 9. Safe Cutover Order

取得正式授權後：

1. Freeze `main`／PR／Cloudflare before-state。
2. 先建立 GitHub Pages custom-domain + DNS-only routing。
3. 驗證 `www.huiwen.tw` 能正常載入現行 source 且 HTTPS 穩定。
4. 再 merge PR #22，使 canonical／OG／JSON-LD／sitemap 正式切到 `www`。
5. 驗證 Pages deployment 與 production metadata。
6. 視需要啟用 Cloudflare proxy。
7. 最後啟用 15 Bulk Redirects + 1 Single Redirect。
8. 逐筆驗證 legacy Location/status，並監控 404/indexing。

如果 Stage 2/3 routing 或 TLS 失敗，直接回復 Cloudflare／Pages before-state；此時 `main` 尚未修改。
