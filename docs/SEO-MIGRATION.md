# www.huiwen.tw SEO Migration

本文件記錄 `www.huiwen.tw` 舊站 SEO 資產遷移至 `Hong1998tw/chen-huiwen-website` 的 inventory、successor 與 redirect governance。它只描述 migration governance，不實作正式網域、canonical、redirect 或 production cutover。

> 目前狀態：Phase 1 inventory／redirect governance 已完成遠端同步；Phase 2 內容 parity 已完成；Phase 3 On-page SEO 已由 PR #21 合併並部署。Phase 4 canonical host／domain migration 仍鎖定，尚未執行。

## 1. 權威來源與目前 Runtime

- Repository：`Hong1998tw/chen-huiwen-website`
- GitHub canonical source branch：`main`
- 目前正式 `main`：`e89ae5445ee43fb86e91e9a6ea646648820d570d`
- Phase 3 merge：PR #21，`seo: improve on-page search visibility and validation`
- migration governance branch：`seo/huiwen-domain-migration`
- Phase 1 synchronization commit：`4dada315c96f8ceba2a7115ede570e41a63085a6`
- 舊本機 Phase 1／Phase 2 commits僅作稽核與回復依據，不應反向覆蓋最新 `main`。

`main` 現有正式內容包含特教支持、八德滯洪池、鳳山車站 hub／細分專題、五福市場、美麗島歷史頁，以及 Phase 3 完成的 title／description／Open Graph／Twitter metadata／structured data／SEO validator 與 sitemap metadata。

目前 `main` 仍未包含 `kumamoto-relief.html`，因此熊本 legacy URL 仍不得標示為已有正式 successor。

## 2. Migration 目標與安全邊界

- 未來 canonical host 規劃為 `https://www.huiwen.tw/`。
- 目前 production canonical host 仍為 `https://hong1998tw.github.io/chen-huiwen-website/`。
- 每個 legacy URL 必須有可追溯的 successor、補頁、410 或待人工裁定決策。
- 不把所有 legacy URL 導回首頁。
- 不把未在最新 `main` 的本機頁面當成公開 successor。
- 未經 production cutover 授權，不修改 DNS、Cloudflare、GitHub Pages custom domain、canonical host、production redirect runtime 或 Search Console。

## 3. Runtime Truth

### GitHub

- `main`：`e89ae5445ee43fb86e91e9a6ea646648820d570d`
- `seo/huiwen-domain-migration`：已完成 Phase 1 governance remote sync，並已更新到目前 Phase 3 後狀態。
- CSV successor 與 action 必須以最新 `main` 實際存在的公開檔案為準。

### Production

- PR #21 已 merge。
- Merge 後 `Validate canonical source`：PASS。
- GitHub Pages run #25：PASS。
- Pages artifact 已確認綁定 `main@e89ae5445ee43fb86e91e9a6ea646648820d570d`。
- Deployment-level verification：PASS。
- 獨立 HTTP fetch 目前仍受工具 cache 限制，因此不得把 independent HTTP verification 虛報為 PASS。

### Cloudflare / Search Console

- Cloudflare DNS／Proxy／Redirect Rules／SSL／cache：未修改。
- GitHub Pages custom domain：未修改。
- Search Console landing pages、clicks、impressions、index coverage 與 backlink 全量資料：未知／待確認。

## 4. Phase 1 Inventory

`data/seo/legacy-urls.csv` 盤點 18 個 exact legacy URL；`data/seo/redirect-map.csv` 以相同 normalized path 維持 candidate action。

重要 successor：

- 鳳山車站長篇 hub → `achievement-fengshan-station-overview.html`
- 美麗島歷史頁 → `history-meilidao.html`
- 特教復康巴士 → `achievement-special-education-support.html`
- 八德滯洪池 → `achievement-bade-detention.html`
- 五福市場 → `activity-market.html`
- 熊本舊頁 → 尚無正式 successor，維持 `先補新頁再301`／`partial`
- 服務案件／網站聯絡 → `partial`，需在 cutover 前再確認混合 intent 承接
- 問政集合頁 → `partial`，需在 cutover 前再確認舊頁全量內容承接
- Notion 內部導航 view → 410 candidate；仍需 Search Console／外部連結確認

## 5. Phase Gates

### Phase 0 — Baseline / Worktree

- [x] 建立 migration baseline
- [x] 確認 GitHub `main` 為唯一 Canonical Source
- [x] 未以 Drive／Notion／舊本機 source 覆蓋 `main`

### Phase 1 — Legacy SEO Asset Inventory

- [x] 建立 18 筆 legacy URL inventory
- [x] 建立 redirect candidate map
- [x] 每筆指定 action，未將 unresolved URL 批次導回首頁
- [x] 依正式 successor 更新鳳山車站、美麗島、特教、八德與五福市場 mapping
- [x] 熊本頁維持 unresolved，不宣稱已承接
- [x] 遠端 `seo/huiwen-domain-migration` 已收到 Phase 1 synchronization commit
- [x] governance 檔已重新同步到 `main@e89ae544` 的 Phase 3 後 Runtime State
- [ ] Search Console landing pages／clicks／impressions／index coverage
- [ ] 完整 external backlink 資料

**Phase 1 Gate：PASSED。**

Search Console／backlink 資料仍屬 cutover 前補強項，不影響 Phase 1 inventory 與 remote governance synchronization 已完成的判定，但在真正執行高風險 redirect／410 前仍須再次檢查。

### Phase 2 — Content Reconciliation

**Completed。**

由 PR #20／`main` 正式內容承接，包含特教、八德滯洪池、鳳山車站 hub、五福市場與美麗島歷史頁。不得用舊本機 Phase 2 HTML 反向覆蓋最新 `main`。

### Phase 3 — Search Intent / Metadata Preservation

**Completed / Deployed。**

PR #21 已完成：

- title／description
- Open Graph／Twitter metadata
- JSON-LD／structured data
- contextual internal links
- 404 `noindex`
- sitemap metadata
- SEO validator／regression tests

目前 canonical host 仍維持 GitHub Pages，尚未切換至 `www.huiwen.tw`。

### Phase 4 — Canonical Host Preparation

**LOCKED / 尚未執行。**

下一階段應以最新 `main@e89ae544` 為 baseline，建立新的 domain-migration implementation branch，不得直接以舊 migration branch source 覆蓋 `main`。

Phase 4 僅在使用者明確授權後處理：

- canonical host → `https://www.huiwen.tw/`
- `og:url`／structured data host
- sitemap／robots host
- GitHub Pages custom domain preparation
- Cloudflare DNS／redirect design

正式 DNS／custom domain／production cutover 仍屬後續獨立 Gate。

### Phase 5 — Sitemap / Robots / Structured Data

Phase 3 已完成現行 GitHub Pages host 的 technical SEO；domain-specific host migration 尚待 Phase 4／5。

### Phase 6 — Redirect Engineering

待執行。`data/seo/redirect-map.csv` 目前只是 candidate governance，不代表 runtime 已有 301／410。

### Phase 7 — Migration CI Gate

待執行。正式 domain migration branch 應加入 repository-native migration validation，至少檢查 legacy inventory、redirect map、canonical／OG／sitemap／robots host consistency。

### Phase 8 — Pull Request / Release Candidate

待 Phase 4–7 完成後建立正式 migration PR。

### Phase 9 — Production Cutover

**未授權，禁止執行。**

只有 CI 全綠、redirect／canonical／custom-domain candidate 驗證完成，且使用者明確授權「切換／上線 www.huiwen.tw」後，才能修改 Production。

## 6. Validation / Rollback

正式 domain migration 前至少確認：

- latest `main` SHA
- legacy inventory 18 筆 path uniqueness
- successor path existence
- redirect action／verification consistency
- canonical／OG／JSON-LD／sitemap／robots host consistency
- no mass redirect to homepage
- no redirect chains
- 404／410 決策有 Search Console／external-link evidence
- build zero drift
- `validate_site.py`
- `validate_seo.py`
- browser／Accessibility QA
- `git diff --check`

Rollback 一律使用 Git history 回到上一個已驗證 `main`／migration commit；不得用 Drive candidate 或未在 Canonical Source 的舊 HTML 覆蓋。

## 7. 下一步

1. Phase 1 Gate 維持 `PASSED`。
2. 保留 `seo/huiwen-domain-migration` 作 migration governance／audit branch。
3. Phase 4 若獲授權，必須從執行當下最新 `main` 建立新的 implementation branch。
4. 先完成 canonical／sitemap／robots／redirect implementation candidate 與 migration CI。
5. CI／review 全部通過後，再另行取得 Production cutover 授權。
