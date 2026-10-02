# Cloudflare Edge Optimization Runbook

此文件保存 `www.huiwen.tw` 的 Cloudflare edge 優化操作契約與驗證方法；**Cloudflare Dashboard／API current state 才是 Runtime authority**。Routine、低風險且完成必要 Gate 的 edge 改善依官網 current standing requirement「沒疑慮就預設直接部署」執行；重大 scope expansion、高風險 effect 或未解異常才停下確認。不得用舊 snapshot 覆蓋 native current state。

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

執行 `python3 scripts/check_cloudflare_edge.py` 取得 read-only snapshot；加 `--expect-html-cache` 驗證 Production A。checker 遇到正常的 cold/refill `MISS` 或 `EXPIRED` 會對同一 HTML 再讀一次，只有 warm-up 後仍未進 cache 才失敗。2026-09-29 deployment receipt：

- public HTML 第一次 GET：`CF-Cache-Status: MISS`；後續 GET：`HIT`，`Age` 正常增加。
- `?production-verification=edge-audit-live`：`CF-Cache-Status: DYNAMIC`，未命中 public HTML cache。
- static CSS：維持 `HIT`。
- `python3 scripts/check_cloudflare_edge.py --expect-html-cache`：Passed。
- user-controlled native browser direct edge smoke：8/8 checks PASS、service worker activated、browser errors 0。
- GitHub-hosted native edge smoke 同輪曾因 Cloudflare 對 runner 回 HTTP 403 而 `BLOCKED`；HTTP parity、全頁驗證、snapshot-backed live browser QA 均 success。此 runner-specific challenge 不作網站本身失敗證據，但 CI 仍照 current contract保留紅燈，不改寫成 PASS。

Production 變更完成仍需依 `docs/DEPLOYMENT.md` 做 Pages 與 live verification；Cache Rule 成功不等於網站 release 成功。
