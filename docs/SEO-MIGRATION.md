# www.huiwen.tw SEO Migration

本文件記錄 `www.huiwen.tw` 舊站 SEO 資產遷移至 `Hong1998tw/chen-huiwen-website` 的 inventory、successor 與 redirect governance。它只描述 candidate mapping，不實作正式網域、canonical、redirect 或 production 變更。

> 目前狀態：Phase 1 inventory／redirect governance synchronization candidate。內容 parity 已由 GitHub `main` 的 `0c3072ca63f1161619073d7e6bebcfcfb3c36f9c`（`content: restore Stage 2 SEO migration content parity (#20)`）承接；本次只補回 migration-only assets。

## 1. 權威來源與目前 baseline

- Repository：`Hong1998tw/chen-huiwen-website`
- GitHub canonical source branch：`main`
- 本次 Runtime baseline：`0c3072ca63f1161619073d7e6bebcfcfb3c36f9c`
- migration governance target：`seo/huiwen-domain-migration`
- 遠端 target branch 在本次執行開始時仍為 Phase 0 commit `2103d7e823a2deb02156f32e954151f7dc64bdb8`
- 舊本機 Phase 1／Phase 2 commits 僅作稽核與回復依據，不是本次 synchronization 的 parent，也不應直接推送其歷史。

`main` 的 Stage 2 內容以實際檔案為準，包含特教支持、八德滯洪池、鳳山車站 hub／細分專題、五福市場與美麗島歷史頁。本次 CSV successor 只指向在該 baseline 實際存在的檔案；舊本機 `kumamoto-relief.html` 未進入此 baseline，因此不得在 inventory 中標為已發布 successor。

## 2. Migration 目標與安全邊界

- 未來 canonical host 仍規劃為 `https://www.huiwen.tw/`，但目前 GitHub Pages source 的 canonical host 不因本次工作改變。
- 每個 legacy URL 必須有可追溯的 successor、保留、補頁、410 或待人工裁定決策。
- 不把所有 legacy URL 導回首頁，不把未在最新 `main` 的本機頁面當成公開 successor。
- 本次允許建立／更新 `data/seo/legacy-urls.csv`、`data/seo/redirect-map.csv` 與本文件，並更新 migration-only 的 successor／action／verification 狀態。
- 本次禁止修改 DNS、Cloudflare、GitHub Pages custom domain、production redirect runtime、Search Console、Drive、Notion、Phase 4 canonical/domain 設定。

## 3. Runtime Truth

### GitHub

- `main`：`0c3072ca63f1161619073d7e6bebcfcfb3c36f9c`
- `seo/huiwen-domain-migration`：本次同步前為 `2103d7e823a2deb02156f32e954151f7dc64bdb8`
- 本文件與兩份 CSV 的 successor 必須以 `main` 實際存在的檔案重新核對，不以舊摘要或單一 commit SHA 推測內容。

### Production、Cloudflare、Search Console

- GitHub Pages production 狀態、custom domain、Cloudflare DNS／Proxy／Redirect Rules／SSL 與 cache 狀態，本次未寫入也未由本次 connector 重新授權確認。
- Search Console landing pages、clicks、impressions、index coverage 與 backlink 全量資料仍未知。
- 因此 inventory 是公開導覽／搜尋可見的 migration candidate，不是 Search Console 私有索引的完整匯出。

## 4. Phase 1 inventory

`data/seo/legacy-urls.csv` 盤點 18 個 exact legacy URL；`data/seo/redirect-map.csv` 以相同 normalized path 維持 candidate action。欄位涵蓋 URL、標題／主題、發現來源、HTTP 狀態、搜尋可見性、SEO value、內容狀態、successor、action、verification status 與備註。

目前重要 successor 判定：

- 鳳山車站長篇 hub → `achievement-fengshan-station-overview.html`；由 hub 再連到停車、站體與步道細分專題。
- 美麗島歷史頁 → `history-meilidao.html`；不導回首頁。
- 特教復康巴士 → `achievement-special-education-support.html`。
- 八德滯洪池 → `achievement-bade-detention.html`；保留 8,350 萬元總經費、7,289 萬元原工程決標、2026-08-11 變更設計決標與未宣稱整體完工的邊界。
- 五福市場 → `activity-market.html`。
- 熊本舊頁目前沒有 successor：`main` 未含 `kumamoto-relief.html`，因此維持 `先補新頁再301`／`partial`，不可把舊本機頁面當正式內容。
- 服務案件／網站聯絡與問政集合頁仍是 `partial`，因混合內容或舊頁全量承接尚未逐項核對。

## 5. Phase Gates

### Phase 0 — Baseline / Worktree

- [x] 讀取最新 GitHub `main` Runtime State
- [x] 確認本次只以實際 repository source 建立 migration-only candidate
- [x] 未修改 production、Cloudflare、Pages custom domain、Drive 或 Notion

### Phase 1 — Legacy SEO Asset Inventory

- [x] 建立 18 筆 legacy URL inventory
- [x] 建立同路徑 redirect candidate map
- [x] 為每筆指定 action，未把 unresolved URL 批次導回首頁
- [x] 以最新 `main` 實際存在的 hub／history／activity／achievement successor 更新 mapping
- [x] 將未在最新 `main` 的熊本頁保留為 unresolved，不宣稱已承接
- [ ] Search Console landing pages、clicks、impressions 與 index coverage
- [ ] 完整 external backlink 資料
- [ ] 遠端 `seo/huiwen-domain-migration` 收到本次 synchronization commit

Phase 1 Gate 判定：**候選資產已在本機依最新 main 核對；遠端 branch 尚未收到前，不判定正式完成。**

### Phase 2 — Content Reconciliation

已由 `main` 的 `0c3072ca` 承接。本次不重新帶入 Phase 2 的 HTML、JSON、build scripts、sitemap 或其他 content parity 檔案；CSV／本文件只引用已存在於該 baseline 的 successor。

### Phase 3 — Search Intent / Metadata Preservation

待執行。需檢查 title、description、canonical、structured data、內部連結與 legacy intent 是否逐頁承接。

### Phase 4 — Canonical Host Preparation

**鎖定，未授權。** 不修改 canonical host、DNS、Pages custom domain 或 Cloudflare。

### Phase 5 — Sitemap / Robots / Structured Data

待執行；本次不改 `sitemap.xml` 或 robots。

### Phase 6 — Redirect Engineering

待執行；本次只記錄 candidate map，不實作 redirect runtime。

### Phase 7 — Migration CI Gate

待執行；需有 repository-native inventory／redirect validation 與 CI evidence。

### Phase 8 — Pull Request / Release Candidate

待使用者明確授權；本次不建立正式 migration PR。

### Phase 9 — Production Cutover

**未授權，禁止執行。**

## 6. 驗證與 rollback

本次應至少執行：

- `python3 scripts/validate_site.py`
- 兩份 CSV header、row count、legacy path uniqueness、successor path existence 與 action／verification consistency 檢查
- `git diff --check`
- 以 `git diff --name-only` 確認只含 migration-only 資產

正式切換前仍須記錄切換前最後已驗證 `main` SHA、migration merge／sync commit、Pages deployment、canonical／DNS／redirect 變更與 production verification。若 source 更新而 Pages 或 production verification 失敗，必須分別回報，不得統稱為已上線。

Rollback 應以 Git history 回到上一個已驗證 `main`／migration governance commit；不得用舊 Drive candidate 或未在 canonical source 的 HTML 覆蓋現行 source。

## 7. 下一步

1. 完成本機 CSV／文件 validation。
2. 建立以 `0c3072ca` 為第一 parent、並可由遠端 Phase 0 branch 正常 fast-forward 到的 synchronization commit。
3. 只更新遠端 `seo/huiwen-domain-migration`，確認遠端 branch 收到 inventory／redirect map 後，才把 Phase 1 Gate 更新為正式完成。
4. 保持 Phase 4 canonical/domain、Cloudflare、production redirect 與正式 migration PR 鎖定。
