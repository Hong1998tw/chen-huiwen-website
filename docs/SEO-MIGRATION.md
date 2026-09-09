# www.huiwen.tw SEO Migration

本文件記錄 `www.huiwen.tw` 舊站 SEO 資產遷移至 `Hong1998tw/chen-huiwen-website` GitHub Pages 正式架構的基準、邊界、Gate、Redirect 策略與 Rollback 原則。

> 狀態：Phase 0 baseline established。尚未切換正式網域、尚未修改 Cloudflare DNS、尚未修改 GitHub Pages custom domain、尚未 merge `main`。

## 1. Migration 目標

- 未來正式 canonical host：`https://www.huiwen.tw/`
- 保留既有 `www.huiwen.tw` 已累積的搜尋索引、網址與內容資產。
- 將網站 hosting/source architecture 收斂至 GitHub Canonical Source，而不是直接覆蓋舊站。
- 所有高價值 legacy URL 在正式切換前建立明確 successor 與永久轉址策略。
- 不以大量 legacy URL 全部導回首頁的方式處理遷移。

## 2. Canonical Source 與 Phase 0 Baseline

- Repository：`Hong1998tw/chen-huiwen-website`
- Canonical branch：`main`
- Phase 0 baseline commit：`9a4f734adbebf07ef1a4a85d6fd4c8cb090a9c5f`
- Baseline commit message：`feat: publish 24-item categorized news archive`
- Migration working branch：`seo/huiwen-domain-migration`
- Branch 建立基準：精確從上述 baseline commit 建立。
- Phase 0 建立日期：2026-09-09（Asia/Taipei）

除非後續明確重新 rebase／update branch 並重新記錄 baseline，Migration Audit 以此 commit 為第一版比較基準。

## 3. Runtime State（Phase 0）

### GitHub main

- `main` HEAD：`9a4f734adbebf07ef1a4a85d6fd4c8cb090a9c5f`
- Repository 為 public，GitHub Connector 對 repository 具有 push/admin 等必要權限。

### GitHub Pages

- 現行專案文件所載 Production URL：`https://hong1998tw.github.io/chen-huiwen-website/`
- 最新可確認 Pages workflow：`pages build and deployment` run #22
- run #22 head SHA：`9a4f734adbebf07ef1a4a85d6fd4c8cb090a9c5f`
- run #22 狀態：completed / success
- 同一 HEAD 的 `Validate canonical source` run #60：completed / success
- 本次執行環境無法直接 fetch `github.io` runtime，因此 Phase 0 不把「獨立外部 HTTP production verification」標示為已完成；以 GitHub Pages deployment success 作為已確認部署證據。

### Legacy public site

- Legacy host：`https://www.huiwen.tw/`
- 2026-09-09 實際 web fetch 可正常讀取首頁。
- 首頁目前公開辨識資訊包括：陳慧文、高雄市議員、鳳山區、服務處聯絡資料與既有公告／導覽。
- Legacy site 已存在可被搜尋引擎發現的內頁，因此正式切換視為 SEO migration，而不是新網域從零上線。

### Cloudflare

- 使用者已確認網域由 Cloudflare 管理。
- 本工作階段沒有 Cloudflare account connector，因此無法讀取帳號內實際 DNS records、Proxy mode、Redirect Rules、SSL/TLS mode 或 cache rules。
- 不從公開頁面可連線狀態反推 Cloudflare account 內部設定。
- Phase 0 未修改任何 DNS、Proxy、Redirect、SSL/TLS 或 Cloudflare 設定。

### Google Search Console

- 目前工具未提供此網站 Search Console property 的私有存取能力。
- 是否已建立 `huiwen.tw` Domain Property、目前 clicks/impressions/index coverage 等均標示為「未知／待取得」。
- 正式 migration 前應取得 Search Console Pages / Queries / Indexing 資料，以補強 legacy URL 優先級與成效 baseline。

## 4. 已知 Migration 技術狀態

Phase 0 前的 SEO Readiness Audit 已確認：

- GitHub 新站已有 title、meta description、canonical、Open Graph、Twitter Card、sitemap、robots.txt 與部分 JSON-LD。
- 現有 canonical、OG URL、structured data、robots sitemap、sitemap loc 等仍以 `hong1998tw.github.io/chen-huiwen-website` 為正式 base。
- `scripts/build_cases.py` 與 `templates/case-page.html` 會產生 GitHub Pages 絕對 URL。
- repo baseline 尚未配置 `www.huiwen.tw` 為 deployable canonical host。
- legacy URL → new URL 的完整 mapping 尚未建立。
- 已發現部分 legacy 高價值內容比 GitHub 新站對應內容更新，正式轉址前必須先完成事實核驗與內容承接。

以上均為後續 Phase 1～7 的工作，不在 Phase 0 直接修改。

## 5. Production Safety Boundary

在使用者沒有明確要求「正式切換／上線／部署／merge main」以前：

允許：

- 更新 `seo/huiwen-domain-migration` branch
- 建立 SEO inventory、redirect map、migration scripts
- 修改 candidate source
- build / test
- 建立 Pull Request

禁止：

- merge `main`
- 修改 GitHub Pages custom domain
- 修改 Cloudflare DNS / Proxy / Redirect Rules / SSL/TLS
- 將 `www.huiwen.tw` 指向 GitHub Pages
- 移除現行 legacy production
- 宣稱 migration 已上線

## 6. Redirect 原則

每個 legacy URL 後續只能採取明確處置之一：

- 301 / 308 至內容高度對應的新 canonical URL
- 保留原 URL
- 先建立／補完 successor，再永久轉址
- 404 / 410（僅限確定不應保留、無合理 successor 的內容）
- 待人工裁定

禁止：

- 大量 URL 全部永久轉址首頁
- redirect loop
- 不必要 redirect chain
- 將較新、較完整 legacy 內容轉向較舊或明顯較弱的新頁

## 7. Migration 資料檔規劃

Phase 1 預計建立：

- `data/seo/legacy-urls.csv`：legacy URL inventory
- `data/seo/redirect-map.csv`：正式 redirect mapping candidate

欄位至少需支援：legacy URL、頁面標題／主題、來源、搜尋可見性、內容狀態、successor、action、verification status、備註。

## 8. Rollback 原則

Phase 0 baseline：

`9a4f734adbebf07ef1a4a85d6fd4c8cb090a9c5f`

在 custom domain migration 正式發布前，Production 不受本 branch 影響。

未來正式切換時至少記錄：

- 切換前最後已驗證 `main` commit
- migration merge commit
- Cloudflare DNS / Redirect Rules 變更摘要
- GitHub Pages custom domain 狀態
- Pages deployment run
- production verification 結果
- rollback commit / DNS 回復方案

若 GitHub source 更新成功但 Pages 失敗，標示「Source 更新成功／Production 部署失敗」。
若 Pages 成功但 `www.huiwen.tw` 驗證失敗，標示「Deployment 成功／Production Verification 失敗」。

## 9. Phase Gates

### Phase 0 — Baseline / Worktree

- [x] 重新讀取 GitHub `main` HEAD
- [x] 確認 latest Pages deployment 對應 baseline HEAD 且 success
- [x] 確認 legacy `www.huiwen.tw` 目前可公開讀取
- [x] 建立 `seo/huiwen-domain-migration`
- [x] 建立本 Migration 文件
- [x] Production 未修改
- [x] Cloudflare 未修改
- [ ] Cloudflare account Runtime State：目前無 connector，待正式切換前從實際帳號讀取
- [ ] Search Console Runtime State：目前未連線／未取得，待 migration 前補齊

Phase 0 Gate 判定：**Passed with external-runtime unknowns**。未知項不阻礙 Phase 1 SEO asset inventory，但在正式 Production 切換前必須處理。

### Phase 1 — Legacy SEO Asset Inventory

待執行。

### Phase 2 — Content Reconciliation

待執行。

### Phase 3 — Search Intent / Metadata Preservation

待執行。

### Phase 4 — Canonical Host Preparation

待執行。

### Phase 5 — Sitemap / Robots / Structured Data

待執行。

### Phase 6 — Redirect Engineering

待執行。

### Phase 7 — Migration CI Gate

待執行。

### Phase 8 — Pull Request / Release Candidate

待執行。

### Phase 9 — Production Cutover

**未授權，禁止執行。**

## 10. 下一步

下一個正式工作階段是 Phase 1：建立完整 legacy SEO asset inventory 與 redirect mapping candidate。優先取得 Search Console landing pages；若 Search Console 暫時不可用，先以 legacy site crawl、公開搜尋結果、現有內部連結與已知 URL 建立 baseline inventory，並把 Search Console 欄位保留為待補證據。
