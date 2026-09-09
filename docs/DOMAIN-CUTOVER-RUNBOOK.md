# huiwen.tw Domain Cutover Runbook

本文件是 `www.huiwen.tw` 正式切換的候選操作順序。它不是 Production 授權；沒有使用者明確下達正式切換指令時，不執行 DNS、GitHub Pages custom domain 或 runtime redirect。

## 1. Canonical host

- Primary canonical：`https://www.huiwen.tw/`
- Apex：`https://huiwen.tw/`
- 目標行為：apex 最終導向 `www`，避免同時存在兩套 canonical host。

選擇 `www` 的原因：舊站既有索引主要使用 `www.huiwen.tw`，可避免同時做內容遷移與 host variant 遷移。

## 2. GitHub Pages DNS candidate

依 GitHub Pages 官方文件，`www` 子網域的 CNAME 應直接指向使用者的 Pages default domain，不含 repository 名稱：

- Name：`www`
- Type：`CNAME`
- Target：`Hong1998tw.github.io`

禁止把 CNAME 指到：

- `Hong1998tw.github.io/chen-huiwen-website`
- 任意含 path 的 URL
- wildcard `*.huiwen.tw`

Apex `huiwen.tw` 可依 GitHub Pages 官方當下支援的 A／AAAA／ALIAS／ANAME 方式設定。正式 cutover 當下必須重新查 GitHub 官方值，不把本文件的歷史快照當永久常數。

## 3. Cloudflare candidate policy

正式切換前記錄現有 DNS 全量 snapshot。

建議流程：

1. 先完成 GitHub Pages custom-domain ownership／設定準備。
2. `www` CNAME 指向 `Hong1998tw.github.io`。
3. Apex 使用 GitHub Pages 官方支援方式，並確認 apex → www。
4. 初始 DNS／TLS 驗證階段避免加入不必要的額外 redirect／cache 規則。
5. HTTPS 穩定後才加入 legacy URL redirect rules。

Proxy（橘雲／灰雲）、SSL mode、cache 與 Redirect Rules 必須以 cutover 當下 Cloudflare Runtime State 為準，不從舊聊天猜測。

## 4. Pre-cutover Gate

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
- redirect map 無 mass-home redirect
- unresolved routes 尚未被 runtime redirect
- rollback commit 已記錄
- DNS before-state 已記錄

## 5. Redirect safety

目前 redirect map 分三類：

- `301 / confirmed`：可在正式 cutover candidate 中實作
- `先補新頁再301 / partial`：不得先轉址
- `410 / partial`：不得在 Search Console／external-link evidence 完成前直接執行

禁止：

- 所有舊 UUID 一律導首頁
- redirect chain
- query variant 多層跳轉
- 未存在 successor 的 URL 強制 301

## 6. Cutover sequence

只有取得正式 Production 授權後：

1. 再讀 GitHub `main`、PR、CI、Pages source。
2. 記錄 rollback SHA。
3. merge 已批准 migration PR。
4. 確認 `main` post-merge validation。
5. 設定 GitHub Pages custom domain：`www.huiwen.tw`。
6. 修改 Cloudflare DNS。
7. 驗證 DNS resolution。
8. 驗證 GitHub Pages TLS／HTTPS。
9. 驗證首頁與主要頁 HTTP 200。
10. 驗證 canonical／OG／JSON-LD／sitemap／robots runtime。
11. 驗證 `huiwen.tw` → `www.huiwen.tw`。
12. 實作 confirmed legacy redirects。
13. 逐筆抽查 legacy URL status/location。
14. 更新／驗證 Search Console property 與 sitemap。
15. 開始 404、index coverage、ranking monitoring。

## 7. Failure classification

- `main` 更新但 Pages 失敗：**Source 更新成功／Production 部署失敗**。
- Pages 成功但 custom domain／DNS 異常：**Deployment 成功／Domain Cutover Verification 失敗**。
- DNS 正常但頁面 metadata 不一致：**Domain routing 成功／Production SEO Verification 失敗**。

不得把上述任一情況統稱「已成功上線」。

## 8. Rollback

重大問題時：

1. 使用 Git history revert migration merge commit。
2. 將 GitHub Pages custom domain／Cloudflare DNS 回復至切換前 snapshot。
3. 驗證原 GitHub Pages runtime 恢復。
4. 保留問題 commit、rollback commit、失敗原因與受影響 URL。

禁止使用 Drive 舊 `index.html` 覆蓋 `main`。
