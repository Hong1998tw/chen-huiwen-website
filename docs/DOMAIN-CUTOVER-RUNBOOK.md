# huiwen.tw Domain Cutover Runbook

本文件是 `www.huiwen.tw` 正式切換的候選操作順序。它不是 Production 授權；沒有使用者明確下達正式切換指令時，不執行 DNS、GitHub Pages custom domain、Cloudflare proxy 或 runtime redirect。

## 1. Canonical host

- Primary canonical：`https://www.huiwen.tw/`
- Apex：`https://huiwen.tw/`
- 目標行為：apex 最終導向 `www`，避免同時存在兩套 canonical host。

選擇 `www` 的原因：舊站既有索引主要使用 `www.huiwen.tw`，可避免同時做內容遷移與 host variant 遷移。GitHub Pages 官方亦建議使用 `www` 子網域。

## 2. GitHub Pages DNS candidate

依 GitHub Pages 官方 2026-09-09 文件，`www` 子網域 CNAME 必須直接指向使用者 Pages default domain，不含 repository 名稱：

- Name：`www`
- Type：`CNAME`
- Target：`Hong1998tw.github.io`

禁止：

- `Hong1998tw.github.io/chen-huiwen-website`
- 任意含 path 的 URL
- wildcard `*.huiwen.tw`

Apex candidate 依 GitHub Pages 官方目前值：

- `A @ 185.199.108.153`
- `A @ 185.199.109.153`
- `A @ 185.199.110.153`
- `A @ 185.199.111.153`
- `AAAA @ 2606:50c0:8000::153`
- `AAAA @ 2606:50c0:8001::153`
- `AAAA @ 2606:50c0:8002::153`
- `AAAA @ 2606:50c0:8003::153`

正式 cutover 當下仍須重新查 GitHub 官方文件，不把本文件快照當永久常數。若 apex 與 `www` 都使用 GitHub Pages 官方 DNS，且 Pages custom domain 設為 `www.huiwen.tw`，GitHub Pages 會嘗試讓 apex 導向 `www`。

## 3. Cloudflare proxy / TLS policy

正式切換前必須記錄 Cloudflare DNS 全量 before-state，包括既有 `www`、apex、MX、TXT、CAA、redirect、Worker、Page Rule／Cache Rule 等；不得只看單一 CNAME。

### Initial routing stage

為降低 custom-domain／certificate 驗證與雙重代理風險，候選流程先以 DNS-only 完成 GitHub Pages routing 與 HTTPS 驗證：

1. GitHub Pages custom domain 設為 `www.huiwen.tw`。
2. `www` CNAME → `Hong1998tw.github.io`。
3. apex 使用 GitHub Pages 官方 A／AAAA。
4. 先保持上述 web records DNS-only。
5. 等 GitHub Pages domain check 與 HTTPS 正常，再進下一階段。

Cloudflare 官方一般建議 web traffic 使用 proxy；但 Cloudflare 也提醒，對另一個 CDN／proxy provider 再套 proxy 可能造成 TLS／routing 問題。GitHub Pages 是託管式 Pages origin，因此本專案採「先 DNS-only 驗證 origin，再逐步啟用 proxy」的保守流程。

### Redirect stage

Cloudflare Redirect Rules 只有在流量經 Cloudflare proxy 時才有意義。因此在 GitHub Pages HTTPS 已確認後：

1. 將 `www`／apex web records切為 Proxied candidate。
2. 立即驗證首頁、主要頁、TLS、Host routing。
3. 若 proxy 正常，再啟用 legacy redirect rules。
4. 若 proxy 導致 GitHub Pages domain／TLS／routing 異常，立即回復 DNS-only；不得以 Flexible SSL 或其他弱化 TLS 方式硬撐。

Proxy、SSL mode、cache 與 Redirect Rules 必須以 cutover 當下 Cloudflare Runtime State 為準，不從舊聊天猜測。

## 4. Redirect runtime candidate

### Bulk Redirects

`data/seo/cloudflare-redirects.csv` 目前 15 筆 path-only 301 candidate：

- source 不包含 query string。
- `preserve_query=false`，用來清除舊 Notion `pvs` query。
- target 全部使用 `https://www.huiwen.tw/`。
- 不包含 root-to-root redirect。
- 不包含 `/0`。

Cloudflare Bulk Redirect source URL 不支援以 query string 作 source match，因此像 `/map?pvs=96` 會以 `/map` path-only 規則承接；舊 query 在跳轉時丟棄。

### Single Redirect

`data/seo/cloudflare-single-redirects.json` 只處理首頁 legacy query：

- match：`www.huiwen.tw` + path `/` + query `pvs=18`
- target：`https://www.huiwen.tw/`
- status：301
- preserve query：false

### No redirect / 404

- `/`：同 canonical URL，保留，不轉址。
- `/0?...`：cutover 首日不主動 410；先由 GitHub Pages 正常 404。待 Search Console／external backlink evidence 確認後，再決定是否升級 410。

## 5. Legacy successor status

18 筆 legacy inventory 中：

- 15 筆 path-based confirmed 301 可進 Bulk Redirect candidate。
- 1 筆首頁 `?pvs=18` 由 Single Redirect 處理。
- 1 筆 canonical homepage `/` 保留原 URL。
- 1 筆 Notion internal navigation `/0?...` 先 404。

新增 successor：

- 熊本舊頁 → `history-kumamoto-relief.html`，以日本氣象廳、外交部、高雄市政府資料重建 evergreen 內容，過期募款 CTA 不延續。
- 問政記錄 → `council-records.html`，以高雄市議會官方資料承接舊站 `4-6總質詢`。
- 服務案件／網站聯絡 → `petition.html`，已核對案件登記、電話、服務資訊、法律諮詢與 footer 聯絡資料。

## 6. Pre-cutover Gate

正式切換前全部必須 PASS：

- migration PR 已 review
- canonical／OG／JSON-LD host 全部為 `www.huiwen.tw`
- sitemap／robots host 全部為 `www.huiwen.tw`
- build zero drift
- `validate_site.py`
- `validate_donation.py`
- `validate_seo.py`
- `validate_domain_migration.py`
- Full-site browser/accessibility QA
- legacy inventory 18 筆 unique
- Bulk Redirect candidate 與 confirmed path-based 301 map 完全一致
- homepage Single Redirect candidate 正確
- no mass-home redirect
- rollback commit 已記錄
- DNS／Cloudflare before-state 已記錄
- Search Console／external backlink evidence 對 410 決策完成或明確維持 404

## 7. Safer cutover sequence

只有取得正式 Production 授權後，依下列順序執行。**不要先 merge canonical=www 再慢慢處理 DNS。**

### Stage A — Freeze / snapshot

1. 再讀 GitHub `main`、PR、CI、Pages source。
2. 記錄 pre-cutover `main` SHA、Pages deployment 與 Production 狀態。
3. 保存 Cloudflare DNS／Rules／SSL／proxy before-state。
4. 確認 PR #22 仍可乾淨 merge，且 head 未漂移。

### Stage B — Route custom domain to current production source

5. GitHub Pages custom domain 設定 `www.huiwen.tw`。
6. 修改 Cloudflare DNS 為 GitHub Pages candidate，先 DNS-only。
7. 驗證 `www.huiwen.tw` DNS resolution 與 Pages domain check。
8. 驗證 GitHub Pages HTTPS／certificate。
9. 驗證 `www.huiwen.tw` 目前可讀；此時內容仍可能是 migration merge 前版本，因此 metadata 暫仍以 pre-cutover main 為準。

### Stage C — Publish canonical migration source

10. merge 已批准的 migration PR。
11. 確認新的 `main` HEAD。
12. 等待 post-merge Validate canonical source。
13. 等待 GitHub Pages deployment。
14. 驗證 `www.huiwen.tw` 首頁與主要頁 HTTP 200。
15. 驗證 canonical／OG／JSON-LD／sitemap／robots runtime 全部已切至 `www.huiwen.tw`。
16. 驗證 apex → `www`。

### Stage D — Enable Cloudflare redirect layer

17. 在 GitHub Pages HTTPS 已穩定後，視計畫將 web records 改為 Proxied。
18. 驗證 Cloudflare proxy 下首頁／主要頁／TLS 正常。
19. 啟用 `cloudflare-redirects.csv` 對應的 15 筆 301 rules。
20. 啟用 homepage `pvs=18` Single Redirect。
21. 逐筆抽查 legacy status／Location，確認無 chain、無 query 汙染、無 mass-home。
22. `/0?...` 維持 404，除非另有證據與決策。

### Stage E — Search / monitoring

23. 更新／驗證 Search Console property 與 sitemap。
24. 監控 404、index coverage、canonical selection、clicks、impressions 與 ranking。
25. Redirect 至少維持一年；高價值路徑建議長期保留。

## 8. Failure classification

- custom domain／DNS 未成功，migration PR 尚未 merge：**Domain Cutover Preparation 失敗／Source 未變更**。
- `main` 更新但 Pages 失敗：**Source 更新成功／Production 部署失敗**。
- Pages 成功但 custom domain／DNS 異常：**Deployment 成功／Domain Cutover Verification 失敗**。
- DNS 正常但 metadata 不一致：**Domain routing 成功／Production SEO Verification 失敗**。
- Cloudflare proxy／redirect layer 異常：**Origin 正常／Edge Redirect Layer 失敗**，優先退回 DNS-only。

不得把上述任一情況統稱「已成功上線」。

## 9. Rollback

### Merge 前

若 Stage B 失敗且 migration PR 尚未 merge：

1. 將 Cloudflare DNS／GitHub Pages custom domain 恢復 before-state。
2. 驗證舊站恢復。
3. `main` 不需要變更。

### Merge 後

重大問題時：

1. 使用 Git history revert migration merge commit。
2. 等待 Pages 回復 pre-cutover source。
3. 將 GitHub Pages custom domain／Cloudflare DNS／proxy／redirect rules 回復至切換前 snapshot。
4. 驗證原 Runtime 恢復。
5. 保留問題 commit、rollback commit、失敗原因與受影響 URL。

禁止使用 Drive 舊 `index.html` 覆蓋 `main`。
