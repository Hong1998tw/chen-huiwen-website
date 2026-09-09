# www.huiwen.tw SEO Migration

本文件記錄 `www.huiwen.tw` 舊站 SEO 資產遷移至 `Hong1998tw/chen-huiwen-website` 的 inventory、successor、canonical-host 與 redirect governance。

> 目前狀態：Phase 1／2／3 已完成；Phase 4 Canonical Host Preparation 正在 `seo/huiwen-domain-phase4-v2` 製作 candidate。此 branch 不代表 Production 已切換。

## Runtime

- Repository：`Hong1998tw/chen-huiwen-website`
- Canonical branch：`main`
- Phase 4 baseline：`e89ae5445ee43fb86e91e9a6ea646648820d570d`
- Phase 3：PR #21 已 merge、GitHub Pages deployment PASS
- 現行 Production host：`https://hong1998tw.github.io/chen-huiwen-website/`
- 目標 canonical host：`https://www.huiwen.tw/`
- Phase 4 implementation branch：`seo/huiwen-domain-phase4-v2`

## Phase 1 — Legacy SEO Asset Inventory

**PASSED。**

- `data/seo/legacy-urls.csv`：18 筆 exact legacy URL
- `data/seo/redirect-map.csv`：同路徑 redirect candidate map
- 鳳山車站 → `achievement-fengshan-station-overview.html`
- 美麗島 → `history-meilidao.html`
- 特教復康巴士 → `achievement-special-education-support.html`
- 八德滯洪池 → `achievement-bade-detention.html`
- 五福市場 → `activity-market.html`
- 熊本舊頁仍無正式 successor，維持 `先補新頁再301 / partial`
- 服務案件／網站聯絡與問政集合頁仍為 `partial`
- Notion 內部導航 view 為 410 candidate，正式執行前仍需 Search Console／external-link evidence

禁止把 unresolved URL 批次導回首頁。

## Phase 2 — Content Reconciliation

**Completed。** PR #20 已將特教、八德滯洪池、鳳山車站 hub、五福市場與美麗島內容正式納入 `main`。

## Phase 3 — On-page SEO

**Completed / Deployed。** PR #21 已完成 title、description、Open Graph、Twitter metadata、JSON-LD、internal links、404 noindex、sitemap metadata 與 SEO validator。

## Phase 4 — Canonical Host Preparation

**Candidate in progress；未部署。**

本階段只準備 repository candidate：

- canonical → `https://www.huiwen.tw/`
- `og:url`
- JSON-LD `url`／`@id`／breadcrumb identity URLs
- social images absolute URLs
- builders／templates canonical base
- sitemap `<loc>` host
- robots Sitemap host
- 404 `<base>` host
- migration validator／CI Gate

本 branch 使用 `scripts/prepare_domain_candidate.py` 做 deterministic、idempotent host rewrite。完成後必須再 build，確保 generated HTML 與 source/template 一致。

### Phase 4 禁止事項

未經正式 cutover 授權，不得：

- merge 此 migration candidate 到 `main`
- 修改 Cloudflare DNS／Proxy／Redirect Rules
- 修改 GitHub Pages custom domain
- 啟用 `CNAME` Production 行為
- 修改 Search Console
- 執行 runtime 301／410
- 宣稱 `www.huiwen.tw` 已上線

## Phase 5 — Sitemap / Robots / Structured Data Host

與 Phase 4 candidate 一併準備，但只有 candidate CI 通過，不代表 Production host 已切換。

## Phase 6 — Redirect Engineering

`data/seo/redirect-map.csv` 目前仍是治理資料。Runtime 301／410 的實作位置必須在 cutover 前依實際舊站／Cloudflare 架構確認，不得先假設 GitHub Pages 本身可以提供任意 server-side 301。

## Phase 7 — Migration CI Gate

正式 migration PR 至少要 PASS：

- `python scripts/build_cases.py`
- `python scripts/build_platforms.py`
- `python scripts/build_events.py`
- build 後 `git diff --exit-code`
- `python scripts/validate_site.py`
- `python scripts/validate_donation.py`
- `python scripts/validate_seo.py`
- `python scripts/validate_domain_migration.py`
- SEO regression tests
- `git diff --check`
- Full-site browser/accessibility QA

Migration validator 必須檢查：

- deployable SEO surface 不殘留舊 GitHub Pages canonical base
- indexable HTML canonical／`og:url` 全為 `www.huiwen.tw`
- sitemap／robots host 一致
- 404 base host 正確
- legacy inventory 18 筆、path unique
- redirect map 與 inventory path 集合一致
- 無 unrelated mass redirect → `/`
- unresolved／410 action 不得誤標 confirmed

## Phase 8 — Migration PR / Release Candidate

Phase 4–7 全部 PASS 後才建立正式 migration PR。PR 仍不得自行 merge。

## Phase 9 — Production Cutover

**LOCKED。**

只有使用者明確下達「正式切換／上線 www.huiwen.tw」才執行：

1. 再確認 latest `main`、PR、CI、rollback commit。
2. 設定 GitHub Pages custom domain。
3. 設定 Cloudflare DNS。
4. 驗證 TLS／HTTPS。
5. 驗證 apex ↔ www 行為。
6. 實作已批准 legacy redirects。
7. 驗證 canonical／OG／JSON-LD／sitemap／robots runtime。
8. 更新 Search Console／sitemap。
9. 持續監控 404、redirect、indexing 與 ranking。

## GitHub Pages DNS 設計基準

依 GitHub 官方文件，`www` 子網域應以 CNAME 直接指向使用者 Pages default domain，**不含 repository path**。本專案規劃：

- `www.huiwen.tw` CNAME → `Hong1998tw.github.io`
- apex `huiwen.tw`：正式 cutover 前依 Cloudflare 與 GitHub Pages 官方支援方式設定，並驗證 apex → www

GitHub 官方也建議使用 `www` subdomain，且正確設定 apex 與 www 時可由 Pages 建立兩者間的 redirect。正式值仍需 cutover 當下重新查官方文件，不從本文件當永久常數。

## Rollback

- Source rollback：Git revert migration merge commit，回到上一個已驗證 `main`。
- DNS／custom-domain rollback：依 cutover runbook 回復切換前記錄。
- 不得以 Drive candidate 或舊 HTML 覆寫 `main`。
- Source 成功但 Pages 失敗、Pages 成功但 runtime 驗證失敗，必須分開標示。
