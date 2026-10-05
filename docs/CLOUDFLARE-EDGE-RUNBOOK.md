# Cloudflare Edge Optimization Runbook

此文件保存 `www.huiwen.tw` 的 Cloudflare edge 優化操作契約與驗證方法；**Cloudflare Dashboard／API current state 才是 Runtime authority**。Routine、低風險且完成必要 Gate 的 edge 改善依官網 current standing requirement「沒疑慮就預設直接部署」執行；重大 scope expansion、高風險 effect 或未解異常才停下確認。不得用舊 snapshot 覆蓋 native current state。

## Current hosting — Cloudflare Static Assets

2026-10-01 起，正式前台採 `data/deployment-target.json` 的 `cloudflare-static-assets`，流程見 [現行部署契約](DEPLOYMENT.md) 與 [遷移契約](CLOUDFLARE-PUBLIC-MIGRATION.md)。下方 Production A 與 `max-age=600` 是 GitHub Pages origin 階段的歷史紀錄。

現役 Static Assets 預設回 `Cache-Control: public, max-age=0, must-revalidate`，`CF-Cache-Status` 描述其資產服務快取。帶 `production-verification` 的 URL 也可能回 `HIT`；不能只憑此標頭判定版本正確或 CDN bypass 失效。Cloudflare 官方說明：[預設標頭](https://developers.cloudflare.com/workers/static-assets/headers/)與[資產快取](https://developers.cloudflare.com/workers/static-assets/#caching-behavior)。

現役唯讀檢查：

```bash
python3 scripts/build_cloudflare_public.py
python3 scripts/check_cloudflare_edge.py --expect-static-assets --expected-sha "$(git rev-parse HEAD)"
```

此模式只允許 public HTML 的首次 `MISS`／`EXPIRED` 再讀同一 URL 一次，HTTP 異常或持續未進快取仍 fail；同時沿用 `verify_cloudflare_delivery.py` 綁定 provider、完整 SHA 與本地公開 artifact digest，收據 `FAIL`／`BLOCKED` 不得通過。它不取代完整資產、106頁 HTTP、snapshot 或 native browser 的 production gate。

`--expect-html-cache` 保留為 legacy CDN 模式：同樣只重讀正常 refill 一次，production-verification URL 的 `HIT`／`REVALIDATED`／`UPDATING`／`STALE` 仍 fail，不能拿這個舊模式驗收現役 Static Assets。本修補不修改 Cache Rules、WAF、Access 或部署設定。

## 前台最小安全標頭（`_headers`）

Static Assets 的 `_headers` 由 `scripts/build_cloudflare_public.py` 的 `SECURITY_HEADERS` 單一來源產生，`/*` 一條規則涵蓋 `/`、舊目錄 rewrite、HTML、JS、CSS、JSON、圖片與 404 頁；`/deployment.json` 另保留 `Cache-Control: no-store`。

| 標頭 | 值 | 理由 |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | 禁止 MIME sniffing，網站所有資源 `Content-Type` 皆正確。 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 跨站只送 origin，同站維持完整 referrer；與現有分析、外部連結相容。 |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` | 只關閉網站與嵌入內容都不使用的功能；Facebook 嵌入的 `allow="encrypted-media; picture-in-picture; web-share"` 不受影響。 |
| `X-Frame-Options` / `Content-Security-Policy` | `DENY` / `frame-ancestors 'none'` | 後台預覽經同源 `/api/page-preview` 代理取回 HTML 再由後台自己的網域提供（`admin/public/app.js` 設定 `frame.src`），前台沒有任何第一方嵌入需求。`tests/test_public_security_headers.py` 會在後台改回直接嵌入 `www.huiwen.tw` 時失敗，須同步重新評估此標頭。 |

刻意**不**加入：

- 完整 CSP：需先決定 Cloudflare 注入的 JSD 腳本、編輯器 loader（hash 隨內容變動）、已過期的 fbcdn 圖片與 `sw.js` 內聯樣式的處理，另案評估。
- COEP／CORP：`Cross-Origin-Resource-Policy` 會擋住後台縮圖載入 `https://www.huiwen.tw/assets/...`；COEP 會擋 Facebook／OSM 嵌入。
- HSTS：屬 Cloudflare zone 設定（SSL/TLS → Edge Certificates），才能同時涵蓋 apex 301。先小 `max-age`、不含 `includeSubDomains`／`preload`，由網站擁有者決定，不在 artifact 內設定。

部署後唯讀驗收（不修改任何設定）：

```bash
python3 scripts/verify_security_headers.py --base-url https://www.huiwen.tw
```

腳本逐一檢查 `/`、`/index.html`、`/about.html`、`/site.js`、`/styles.css`、`/data/search-index.json`、圖片、`/mktexp26/`、`/deployment.json` 與 404 探針，列出 URL、時間、狀態碼、是否重新導向與實際標頭；任一缺漏或異常 exit 1。本機可用 `wrangler dev --local` 對建好的 `_site` 預跑。回復：revert 該提交後依現行部署流程重新部署，或使用 Cloudflare Workers 的前一個 deployment。

## 2026-09-29 pre-change baseline

- `www.huiwen.tw`：Cloudflare proxy；origin 為 GitHub Pages。
- `huiwen.tw` apex：GitHub Pages A／AAAA，DNS-only；目前由 GitHub 回 301 至 `https://www.huiwen.tw/`。
- Cache Rules：1 個 active rule `Static-Assets-Cache`，涵蓋圖片、CSS、JS、字型等副檔名。
- `https://www.huiwen.tw/`：`CF-Cache-Status: DYNAMIC`；HTML 尚未進 edge cache。
- 靜態 CSS 已觀察到 `CF-Cache-Status: HIT` 與長 TTL。
- 近 24 小時 Cloudflare zone overview：4.05k requests、cache percentage 21.96%；這是觀測 receipt，不是長期容量假設。

## Production A — public HTML edge cache

目的：只快取明確公開、靜態的網站 HTML；不碰 `office.huiwen.tw`、CMS、API、登入或任何個人化內容。

2026-09-29 已部署兩條 Cache Rules。Cloudflare 同 phase 的 non-terminating Cache Rules 會繼續評估，**最後一個設定同一欄位的 matching rule 生效**，因此 verification bypass 排在 HTML cache 規則之後：

1. `Public-HTML-Short-Cache`
   - Hostname = `www.huiwen.tw`
   - Method = GET / HEAD
   - Path = `/` 或以 `.html` 結尾
   - Action: eligible for cache
   - Edge TTL: respect origin
   - Browser TTL: respect origin
   - Current origin HTML: `Cache-Control: max-age=600`，因此正常 freshness window 約 10 分鐘
2. `Bypass-Production-Verification`
   - Hostname = `www.huiwen.tw`
   - Method = GET / HEAD
   - Query string 含 `production-verification=`
   - Action: bypass cache
   - Placement: after `Public-HTML-Short-Cache` so the bypass wins when both rules match

`huiwen.tw` zone 目前是 Cloudflare Free；Free zone 的 **minimum Edge Cache TTL override 是 2 小時**，不能用 120 秒 override。為保留短 stale window 且不新增 purge Secret，本次採 `respect origin`，沿用 GitHub Pages 現有 `max-age=600`。若未來建立最小權限 purge path，再評估較長 Edge TTL。

### Hard exclusions

- 不對 `office.huiwen.tw`、`admin.huiwen.tw`、`cms-publisher.huiwen.tw` 套用此規則。
- 不快取帶 `Authorization`、登入 Cookie、private API response 或 `Cache-Control: no-store/private` 的內容。
- Production Verification 的 cache-busting query 必須 bypass，不能讓 cache HIT 冒充 origin parity。

## Candidate B — apex routing normalization

`huiwen.tw` 目前仍為 DNS-only GitHub Pages apex。若要把 apex redirect 統一交給 Cloudflare：

1. 先 native snapshot A／AAAA、MX、TXT、CAA、Redirect Rules、SSL/TLS 與 Pages custom domain。
2. 只變更 apex web A／AAAA proxy 狀態，不動 MX／mail records。
3. 建立 exact 301：`https://huiwen.tw/*` → `https://www.huiwen.tw/$1`。
4. 驗證 apex HTTP/HTTPS、www canonical、GitHub Pages custom-domain certificate、主要 SEO URL。
5. 任一步異常，優先退回 apex DNS-only before-state。

此項主要是 routing／observability 一致性，不是目前最高 ROI；預設延後，除非本次工作明確納入 apex routing normalization，或後續 evidence 顯示目前路由造成實際問題。

## Verification

執行 `python3 scripts/check_cloudflare_edge.py` 取得 read-only snapshot；加 `--expect-html-cache` 驗證 legacy Production A，正常 cold/refill `MISS` 或 `EXPIRED` 只再讀同一 HTML 一次。現役 hosting 使用上方 Static Assets 模式。2026-09-29 deployment receipt：

- public HTML 第一次 GET：`CF-Cache-Status: MISS`；後續 GET：`HIT`，`Age` 正常增加。
- `?production-verification=edge-audit-live`：`CF-Cache-Status: DYNAMIC`，未命中 public HTML cache。
- static CSS：維持 `HIT`。
- `python3 scripts/check_cloudflare_edge.py --expect-html-cache`：Passed。
- user-controlled native browser direct edge smoke：8/8 checks PASS、service worker activated、browser errors 0。
- GitHub-hosted native edge smoke 同輪曾因 Cloudflare 對 runner 回 HTTP 403 而 `BLOCKED`；HTTP parity、全頁驗證、snapshot-backed live browser QA 均 success。此 runner-specific challenge 不作網站本身失敗證據，但 CI 仍照 current contract保留紅燈，不改寫成 PASS。

Production 變更完成仍需依 `docs/DEPLOYMENT.md` 做現行 provider 的 exact-SHA delivery 與 live verification；Cache Rule 成功不等於網站 release 成功。
