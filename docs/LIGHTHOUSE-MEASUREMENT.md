# Lighthouse 量測條件（CI `lighthouse` job）

結論：門檻不變（performance ≥ 90、accessibility／best-practices／SEO ≥ 95，逐頁取中位數）。變的是量測環境：測試用靜態伺服器改為與正式站相同的傳輸壓縮（`Content-Encoding: br`／`gzip`），並固定 Chromium 版本。只改 `tests/donation/`、CI workflow 與本文件；網站檔案、CSS、Cloudflare 設定都不動。

## 1. 為什麼要改

過去 gate 用 `python3 -m http.server`，所有文字資源都以原始大小傳輸（`achievements.html` 約 342 KiB 傳輸量），正式站實際送出 brotli（同一頁約 84 KiB）。在 Lighthouse 預設的 simulated slow-4G（1.6 Mbps）下，6 個 render-blocking CSS 的下載時間直接決定 FCP／LCP，所以舊 gate 量到的是「未壓縮傳輸」這個正式站不存在的條件，並在 CI runner 抖動時落在 89–92 分、兩度紅燈。

## 2. 量測條件對照

| 項目 | 舊（≤ PR #152 時期） | 新（本變更） |
|---|---|---|
| 伺服器 | `python3 -m http.server`（無壓縮） | `tests/donation/static-server.mjs` |
| Content-Encoding | 無（identity） | 文字資源 `br`，否則 `gzip`，否則 identity；圖片／字型不壓縮 |
| Brotli／gzip 參數 | – | brotli quality 4、gzip level 6（對照正式站，見 §3） |
| Vary | 無 | 無（正式站也不送，記錄為 `null`） |
| 壓縮時機 | – | 每檔只壓一次並快取，伺服器回應 ≈ 0 ms（正式站為 edge cache HIT） |
| Cache-Control | 無（只有 `Last-Modified`） | `public, max-age=0, must-revalidate`（同正式站） |
| 瀏覽器 | 未固定 | `EXPECT_BROWSER_VERSION` 固定；不符即失敗 |
| 門檻 | 90／95／95／95 | 不變 |
| 紀錄位置 | `summary.json` 僅有結果 | `summary.json` 增 `conditions`、每次 run 的 `network`／`pageRequests`；另有 `server-log.json` |

`COMPRESSION=none` 會重現舊條件（identity bodies），供 A/B 與歷史比對。

## 3. 正式站觀察（2026-10-05，請求帶 `Accept-Encoding: br, gzip`）

- HTML、CSS、JS、JSON、XML、manifest、robots、404 本文：`content-encoding: br`（只帶 gzip 時為 `gzip`）。圖片（webp／png）與字型（woff2）：無 `content-encoding`。
- **沒有 `Vary` 標頭**（所有檔案、所有編碼皆無）。
- Content-Type：`text/html`、`text/css`、`text/javascript`、`application/json`、`application/xml`、`application/manifest+json`、`text/plain`、`font/woff2`、`image/webp`（均無 charset）。
- `Cache-Control: public, max-age=0, must-revalidate`；`/deployment.json` 由 `_headers` 覆寫為 `no-store`。
- 壓縮大小對照（同一份檔案位元組，伺服器本文位元組 vs 正式站）：`styles.css` 10880／10933、`site.js` 4108／4142、`data/search-index.json` 109082／109202、`sitemap.xml` 2142／2184、`manifest.webmanifest` 435／435、`favicon.svg` 177／177；差距 0–1.4%，所以 brotli 取 quality 4（預設 11 會小約 20%，且每次請求即時壓縮會讓 root document 多約 300 ms 的伺服器延遲，Lighthouse 會把它算進分數）。

### 刻意不模擬的差異

| 差異 | 原因／影響 |
|---|---|
| Cloudflare 對 HTML 注入的 JSD（`/cdn-cgi/challenge-platform/…`，約 +0.4 KiB 壓縮後） | 屬 Cloudflare 設定決策，本 PR 不碰；測試環境沒有這段注入 |
| `_headers`（含 `/deployment.json` 的 `no-store`、安全標頭）、zone 層級重新導向（例如 `/news` → 301 `/news.html`） | 不影響 Lighthouse 受測頁（皆為 canonical `.html`），不模擬 |
| 邊緣 TLS／HTTP/2、真實網路延遲、已註冊的 SW | gate 是 localhost 實驗室量測，不代表 field CWV |
| 原始 `GET /../x`、`/%2e%2e/x` | 正式站在 HTTP 層回 400；本伺服器回 404（兩者都不洩漏檔案） |

## 4. 路徑處理（與正式站對照）

伺服器行為：精確檔案比對；`/` 與以 `/` 結尾的目錄回傳該目錄的 `index.html`（如 `/mktexp26/`）；不帶斜線的目錄（`/mktexp26`）、副檔名省略（`/about`）、`/about.html/` 一律 404（不轉址）；找不到時回 `404.html` 本文與 404 狀態（同樣依 Accept-Encoding 壓縮）；查詢字串與 fragment 忽略；以 `.` 開頭的路徑、`_headers`、`_redirects`、路徑穿越（含 `%2e%2e`、`%5c`、NUL、`//`）與指向 root 外的 symlink 一律 404；只允許 GET／HEAD（其他 405）。

驗證（`tests/donation/static-server-check.mjs`，CI 在 gate 前執行）共 12 項：各文字類型 br 往返位元組完全一致、gzip 與 identity 協商（含 `q=0`、`*`）、圖片／字型不壓縮、`COMPRESSION=none`、真實站台檔案往返、404 本文與壓縮、路徑處理、穿越與 dotfile、指向 root 外的 symlink、HEAD／405、請求紀錄欄位。

另以建置後的 `_site` 對正式站做同一組 27 個請求（一次性驗證，不入庫）：狀態碼、Content-Type、Content-Encoding、Vary、Cache-Control 全數相同，唯二差異為 `/deployment.json`（`_headers` 的 `no-store`）與 HTML 本文（Cloudflare 注入 JSD）。

## 5. 固定瀏覽器版本

CI 以 `npm ci` 安裝鎖定的 `playwright 1.55.1`，其 Chromium 為 `140.0.7339.186`（build 1193）；workflow 以 `EXPECT_BROWSER_VERSION: '140.0.7339.186'` 釘住。實際版本取自 Chrome DevTools `/json/version` 並寫入 `summary.json` 的 `conditions.browserVersion`，不符時在量測前失敗。升級 Playwright 時須同時更新此值，並把新舊瀏覽器的分數分開看。`lighthouse-compare.mjs` 在兩組結果的瀏覽器／Lighthouse 版本、建置內容或門檻不同時會標示「不可直接比較」並以 exit 1 結束。

## 6. 同一份建置的壓縮／未壓縮對照

每個 PR 的 `lighthouse` job 會在 gate 之後（`if: always()`、`continue-on-error: true`、`ENFORCE_THRESHOLDS=0`）再跑一次 `COMPRESSION=none`（`index.html`、`achievements.html`，各 3 次），並產生 `comparison-*.json／.md`（也寫入 Job Summary）。同一 runner、同一 checkout、同一 Chromium，唯一差異是壓縮。全部原始 Lighthouse JSON（`<page>-<run>.json`）、`summary.json`、`server-log.json` 與比較檔都在 artifact `production-readiness-lighthouse`（保留 14 天）。

本機（沙箱 Chromium 141.0.7390.37、Lighthouse 13.4.1、每頁 5 次、同一份 `origin/main` 內容）：

| 頁面 | 未壓縮 Perf（逐次） | 壓縮 Perf（逐次） | FCP 中位數 | LCP 中位數 | 傳輸量 |
|---|---|---|---|---|---|
| index.html | 90, 91, 91, 91, 91 | 98, 97, 97, 98, 98 | 2405 → 1654 ms | 3005 → 2271 ms | 374 → 238 KiB |
| achievements.html | 92, 92, 92, 92, 92 | 100, 100, 100, 100, 100 | 2554 → 1353 ms | 2854 → 1476 ms | 342 → 84 KiB |

重複第二輪結果相同（index 98／achievements 100 vs 91／92）。沙箱 Chromium 與 CI 的 140 不同，這些數字僅用於 A/B，不與 CI 數字混用。

## 7. 量測條件改變後，如何與歷史數據比較

1. **不能把新分數接在舊分數後面當成網站變快。** 同一份建置，單靠壓縮在本機就差約 +7～+8 分；網站檔案沒有任何改變。
2. 舊數據一律視為條件 `legacy-identity`（無壓縮、未固定瀏覽器）：例如 PR #152 兩次 CI 的中位數（achievements 89；index 89 後 90），以及 release 文件中的本機單次結果；它們彼此之間也受 runner／機器差異影響，只能當趨勢參考。
3. 新數據一律視為條件 `br-q4-chromium-<版本>`，以 `summary.json.conditions` 為準。只在條件相同時才比較分數；條件不同時，用同一次 job 裡的 `uncompressed-reference` 與 `candidate` 對照。
4. 90 分門檻不變，但餘裕由約 0～2 分擴大到約 8～10 分；這代表 gate 對「文字資源位元組增加」變得較不敏感（文字資源壓縮約 4～5 倍）。未壓縮的對照 run 保留舊的敏感度，網站仍可用它觀察位元組回歸；若要回到舊 gate 行為，設 `COMPRESSION=none`。
5. 門檻仍有鑑別力（變異測試）：在 `achievements.html` 前加入一份 400 KB、不可壓縮的 render-blocking CSS，壓縮版 gate 的三次 run 都是 88 分，gate 以 exit 1 失敗（未改動的版本為 100）。
6. 要重現舊條件：`COMPRESSION=none LABEL=legacy npm run test:lighthouse --prefix tests/donation`。

## 8. 指令

```sh
node tests/donation/static-server-check.mjs                       # 伺服器合約測試（無瀏覽器）
EXPECT_BROWSER_VERSION=140.0.7339.186 npm run test:lighthouse --prefix tests/donation   # gate（壓縮）
COMPRESSION=none ENFORCE_THRESHOLDS=0 LABEL=uncompressed-reference PAGES=index.html,achievements.html RUNS=3 \
  npm run test:lighthouse --prefix tests/donation
node tests/donation/lighthouse-compare.mjs <A 資料夾> <B 資料夾> [輸出資料夾]
```

## 9. 回復

只涉及測試與 CI：還原此 PR 即回到 `python3 -m http.server` 條件；網站、Cloudflare 與已發布內容不受影響。
