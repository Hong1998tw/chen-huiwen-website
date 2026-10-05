# Lighthouse 量測條件（CI `lighthouse` job）

結論：門檻不變（performance ≥ 90、accessibility／best-practices／SEO ≥ 95，逐頁取中位數）。變的是量測環境：測試用靜態伺服器改為與正式站相同的傳輸壓縮（`Content-Encoding: br`／`gzip`）、固定 Chromium 版本，並讓 CI 量測**最終建置的 `_site`**（不是 repository root），每次量測都附受測檔案清單與內容 digest，兩組結果內容不同或缺證據時比較明確失敗。只改 `tests/donation/`、CI workflow 與本文件；網站檔案、CSS、Cloudflare 設定都不動。（發布影響見 §9：合併到 main 本身仍會走既有的 Cloudflare Builds／收據流程。）

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
| 受測內容 | repository root（原始檔，未經建置） | 最終 `_site`：`scripts/build_cloudflare_public.py` 的輸出（見 §2a） |
| 內容證據 | 無（比較只看 root 路徑字串） | `content-manifest.json`（逐檔路徑／大小／SHA-256）＋ `summary.json` 的 `content.digest`；量測前後各算一次，不一致即失敗 |
| 瀏覽器 | 未固定 | `EXPECT_BROWSER_VERSION` 固定；不符即失敗 |
| 門檻 | 90／95／95／95 | 不變 |
| 紀錄位置 | `summary.json` 僅有結果 | `summary.json` 增 `conditions`、每次 run 的 `network`／`pageRequests`；另有 `server-log.json` |

`COMPRESSION=none` 會重現舊條件（identity bodies），供 A/B 與歷史比對。

## 2a. 受測內容與正式產物的邊界

- **舊 gate 量的不是正式產物。** 以 `ROOT_DIR` 預設值（repository root）量測時，伺服器送出的是 git 中的原始檔；正式站送出的是建置後的 `_site`（JSON 投影、CMS 文字渲染、HTML 引用改寫、`deployment.json`、`_headers`／`_redirects`）。實測（2026-10-05，`9b353ff` 加本 PR 變更）：root 632 個可送出檔案、`_site` 520 個；**153 個同路徑檔案位元組不同**，其中包含 gate 的 `index.html`、`about.html`、`achievements.html`、`vision.html`、`political-donation.html`（例如 `index.html` 20357 → 20441 bytes：`data-cms-manifest` 引用）。`styles.css`、`site.js`、`data/search-index.json` 相同，所以分數差異很小（root 98／100 vs `_site` 97／100，見 §6），但「很小」不等於「同一份」，所以 CI 改量 `_site`。
- **CI 現在量什麼：** `lighthouse` job 先以 Python 3.12 執行 `python scripts/build_cloudflare_public.py --output "$RUNNER_TEMP/public-site"`（與 Cloudflare Builds 相同的建置腳本），再以 `ROOT_DIR` 指向該目錄執行壓縮 gate 與未壓縮對照；兩次讀同一棵樹，`content.digest` 相同。門檻 90／95／95／95 不變。
- **本機 fallback：** 不設 `ROOT_DIR` 仍量 repository root，僅供開發時快速試跑；其 digest 與 `_site` 不同，不能與 CI 結果比較。
- **仍不涵蓋的差異**（同 §3「刻意不模擬」）：Cloudflare 注入的 JSD、`_headers` 的實際回應標頭、zone 層級轉址、邊緣 TLS／HTTP/2、已註冊的 SW。因此 Lighthouse 分數是「正式產物位元組＋正式站相同壓縮」的實驗室結果，不是正式站的 field 表現。
- **建置時間：** `_site` 建置約 4 秒、不需要 Cloudflare 帳號或網路；`git rev-parse HEAD` 只用來填 `deployment.json` 的 `sourceCommit`。

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
| 含空路徑段的網址（`//about.html`、`/dir//index.html`） | 正式站回 `307` 並轉到正規化路徑（2026-10-05 實測 `//about.html` → `Location: /about.html`）；本伺服器不折疊空路徑段，一律 404（不洩漏、也不會把兩種寫法當同一檔） |
| `Accept-Encoding: identity;q=0`（連 identity 都拒絕） | RFC 要求 406；本伺服器仍回 identity 本文（Lighthouse 不會送這種標頭，不模擬） |

## 4. 路徑處理與協商契約（與正式站對照）

> **範圍：這是 localhost 測試伺服器（`tests/donation/static-server.mjs`）的行為，只在 CI／本機量測時啟動、只綁 `127.0.0.1`。** 以下 404 邊界與路徑檢查不是正式站、Cloudflare 或網站程式的缺陷或修補；正式站的路徑處理由 Cloudflare Static Assets 負責，未受本 PR 影響。

伺服器行為：精確檔案比對；`/` 與以 `/` 結尾的目錄回傳該目錄的 `index.html`（如 `/mktexp26/`）；不帶斜線的目錄（`/mktexp26`）、副檔名省略（`/about`）、`/about.html/` 一律 404（不轉址）；**空路徑段（`//x`、`/a//b`、`%2f` 解碼後）不折疊，一律 404**；找不到時回 `404.html` 本文與 404 狀態（同樣依 Accept-Encoding 壓縮）；查詢字串與 fragment 忽略；以 `.` 開頭的路徑、`_headers`、`_redirects`、路徑穿越（含 `%2e%2e`、`%5c`、NUL）一律 404；只允許 GET／HEAD（其他 405）。

**root 邊界（含 404 fallback）：** 任何要送出的檔案——包含 `404.html`——其 `realpath` 必須在 root 內。指向 root 外的 symlink（檔案或目錄）回 404；`404.html` 本身若是指向 root 外的 symlink，未知路徑回內建的純文字 `Not Found`（404，`text/plain`），不讀取也不外洩外部目標；root 內的 `404.html` symlink 仍可使用。（此缺口在先前版本存在：fallback 只用 `stat` 判斷、沒有 `realpath` 邊界檢查，由 PR #155 的獨立審查發現，現已修正並有負向測試。）

**Accept-Encoding 協商：** 依 q 值挑選：`br` 與 `gzip` 取較高 q，同 q 時選 `br`；`q=0` 移除該編碼；`*` 涵蓋未列名的編碼（明確列名者優先，例如 `br;q=0, *` 得 `gzip`）；格式錯誤或超出範圍的 q（`q=abc`、`q=1.5`、`q=-1`）視為不可接受；名稱不分大小寫；`compress`、`deflate` 等不支援的編碼視同沒有；圖片與字型一律不壓縮。回應不含 `Vary`（正式站也沒有）、`Content-Length` 等於實際本文長度（含 404 與 HEAD）、`Cache-Control` 固定。

驗證（`tests/donation/static-server-check.mjs`，CI 在 gate 前執行）共 15 項：各文字類型 br 往返位元組完全一致、gzip 與 identity 協商、q 值權重／平手／`q=0`／`*`／格式錯誤（17 組標頭，同時驗證回應位元組可解回原檔）、圖片／字型不壓縮、`COMPRESSION=none`、真實站台檔案往返、404 本文與壓縮、404 的 `Content-Length`／`Vary`／HEAD、**404.html 的 root 邊界（含正向對照：root 內 symlink 可用）**、路徑處理、穿越與 dotfile、**空路徑段（每個負向案例都先確認正規路徑回 200，所以 404 是伺服器的決定、不是檔案不存在）**、指向 root 外的 symlink、HEAD／405、請求紀錄欄位。審查前的 `//etc/passwd` 案例只是因為 root 下沒有 `etc/passwd` 才 404，並沒有驗到「不折疊」；現在改為檔案存在的案例。三項修正各做過變異測試（拿掉 404 邊界、拿掉空路徑段檢查、忽略 q 值權重），對應測試皆會失敗。

另以建置後的 `_site` 對正式站做同一組 27 個請求（一次性驗證，不入庫）：狀態碼、Content-Type、Content-Encoding、Vary、Cache-Control 全數相同，唯二差異為 `/deployment.json`（`_headers` 的 `no-store`）與 HTML 本文（Cloudflare 注入 JSD）。

## 5. 固定瀏覽器版本

CI 以 `npm ci` 安裝鎖定的 `playwright 1.55.1`，其 Chromium 為 `140.0.7339.186`（build 1193）；workflow 以 `EXPECT_BROWSER_VERSION: '140.0.7339.186'` 釘住。實際版本取自 Chrome DevTools `/json/version` 並寫入 `summary.json` 的 `conditions.browserVersion`，不符時在量測前失敗。升級 Playwright 時須同時更新此值，並把新舊瀏覽器的分數分開看。`lighthouse-compare.mjs` 在兩組結果的瀏覽器／Lighthouse 版本、建置內容或門檻不同時會標示「不可直接比較」並以 exit 1 結束。

## 6. 同一份建置的壓縮／未壓縮對照與內容證據

每個 PR 的 `lighthouse` job 會在壓縮 gate 之後（`if: always()`，即使 gate 失敗也會產生證據）再跑一次 `COMPRESSION=none`（`index.html`、`achievements.html`，各 3 次，`ENFORCE_THRESHOLDS=0`），並以 `lighthouse-compare.mjs --expect-pages=index.html,achievements.html` 比較（也寫入 Job Summary）。**未壓縮分數只記錄、不判定；效能門檻只由壓縮 gate 執行。但參照 run 必須完整產生證據、比較器必須通過，否則 CI 失敗**（兩個步驟都沒有 `continue-on-error`；比較步驟以 `shell: bash` 加 `set -o pipefail` 執行，因為管到 `tee` 時，沒有 `pipefail` 會讓比較器的 exit 1 被吞掉）。同一 runner、同一份最終 `_site`、同一 Chromium，唯一差異是壓縮。全部原始 Lighthouse JSON（`<page>-<run>.json`）、`summary.json`、`content-manifest.json`、`server-log.json` 與比較檔都在 artifact `production-readiness-lighthouse`（保留 14 天）。

**內容證據怎麼運作**

- 每次量測前，`readiness-performance.mjs` 對 `ROOT_DIR` 逐檔計算路徑、大小與 SHA-256（規則與伺服器相同：略過 dotfile、`_headers`、`_redirects`、`node_modules`、證據輸出目錄；指向 root 外的 symlink 不算），寫入 `content-manifest.json`；`summary.json` 的 `content` 記錄 `digest`、`fileCount`、量測後重算的 `digestAfterRun` 與 `unchangedDuringRun`。量測期間內容有變動 → 該次 run 失敗。
- 伺服器對每個實際送出的檔案記錄 identity 位元組的 SHA-256（`server-log.json`、各 run 的 `pageRequests[].serverIdentitySha256`）。
- `lighthouse-compare.mjs` 只在下列全部成立時才輸出 `comparable: true`：
  1. 兩邊都有 `content` 與 `content-manifest.json`，且 manifest 能重算出自己記錄的 digest；
  2. 兩邊都證明量測期間樹未變：`digestAfterRun` 存在、**等於**量測前的 `digest`，且 `unchangedDuringRun === true`（缺少、為 null、或與 `digest` 矛盾——包括 `unchangedDuringRun: true` 但 `digestAfterRun` 不同——都算證據不足）；
  3. **每一次量測**都有伺服器端證據：`pageRequests` 存在且非空；每一列都有 64 位十六進位的 `serverIdentitySha256`（缺少、null、空字串或格式錯誤皆不接受）；列出的路徑（忽略 query string）必須存在於 manifest（未知路徑 = 證據不足），且位元組與 manifest 相同；受測頁面本身必須有一列已驗證的請求；
  4. 兩邊 digest 相同，且兩邊都送出的路徑位元組一致；
  5. 瀏覽器／Lighthouse／門檻相同、壓縮模式不同；
  6. **兩邊都是完成的完整 run**：`summary.json` 有最終 `acceptance` 區塊（沒有＝run 中途中斷）、記錄了 `conditions.runs`、每一頁恰好有 `1..runs` 的逐次結果（缺次、多次、重複編號皆不接受）、`acceptance` 列出的頁面都有量測結果，且 `--expect-pages` 指名的頁面兩邊都存在。分數高低**不**影響可比較性（參照 run 低於門檻仍可比較）。
  任何一項缺證據或不符都會 exit 1 並寫出 `comparable: false` 與原因（問題清單最多列 10 項再加總數）。**缺證據永遠不會被解讀為「沒有問題」。** root 路徑字串相同或不同都不再是證據。
- **這些證據證明什麼、不證明什麼：** 證明「Chrome 在這次量測中請求的每個檔案，伺服器實送的位元組與量測前掃描的 manifest 一致」，以及「樹在量測前後相同」。不證明 Chrome 沒請求的檔案（例如其他頁面）是否相同——那部分由整棵樹的 digest 涵蓋；也不證明正式站實際送出的位元組（那是正式驗收的範圍）。CI 內的參照 run 與比較步驟現在會讓 `lighthouse` job 失敗（見本節上方）；但比較器信任 `summary.json` 與 `content-manifest.json` 的相互一致，不防範有意偽造兩者，只防漏記與不一致。
- 負向測試（`tests/donation/lighthouse-compare-check.mjs`，CI 在 gate 前執行，16 項）：同一個 root 路徑、不同位元組 → 不可比較並點名 `styles.css`；不同目錄、相同內容 → 可比較；新增／缺少檔案；缺 manifest、缺 `content`、外部 `BASE_URL`；量測期間內容變動；手改 digest 或 manifest；伺服器實送位元組與 manifest 不符；**缺 `serverIdentitySha256`（缺少／null／空字串／格式錯誤）、未知 served path（含 query string）、`digestAfterRun` 缺少／null／與 `unchangedDuringRun=true` 矛盾、`pageRequests` 缺少／空陣列／非陣列／整批缺少、受測頁面本身沒有已驗證的列、列沒有 path、`results` 為空——每一種都在 A、B 兩側各測一次，且有「資料完整則可比較」的對照（含 query string 的路徑）與 CLI exit 1／0**；瀏覽器／Lighthouse／門檻／壓縮模式不符；CLI 結束碼。七條新規則各自做過變異測試（關掉該規則，測試失敗）。

**本機實測**（2026-10-05，沙箱 Chromium 141.0.7390.37、Lighthouse 13.4.1、每頁 3 次、最終 `_site`，內容 digest `c5d4bee6b0de…584df4`、520 個檔案、量測前後相同）：

| 頁面 | 未壓縮 Perf（逐次） | 壓縮 Perf（逐次） | FCP 中位數 | LCP 中位數 | 傳輸量 |
|---|---|---|---|---|---|
| index.html | 91, 91, 90 | 97, 98, 97 | 2267 → 1660 ms | 3156 → 2408 ms | 374 → 238 KiB |
| achievements.html | 92, 92, 92 | 100, 100, 100 | 2554 → 1354 ms | 2854 → 1378 ms | 342 → 84 KiB |

壓縮 gate 的 8 頁中位數（Perf／A11y／BP／SEO）：index 97／100／100／100、about 100、achievements 100、vision 100、news 100、news-20260915-special-education-nurse 99、political-donation 100、election 100，全部達標。

同一個沙箱量 repository root（digest `d00bfbf596c0…`、632 個檔案）：未壓縮 index 91 ／ achievements 92，壓縮 98／100——與 `_site` 相比差 0～1 分，這就是「受測內容不同但分數接近」的證據；但兩者不是同一份內容，CI 只採用 `_site`。

沙箱 Chromium 與 CI 的 140 不同，這些數字僅用於 A/B，不與 CI 數字混用，也不是正式站的效能提升。

## 7. 量測條件改變後，如何與歷史數據比較

1. **不能把新分數接在舊分數後面當成網站變快。** 同一份建置，單靠壓縮在本機就差約 +6～+8 分；網站檔案沒有任何改變。此外舊數據量的是 repository root，新數據量的是最終 `_site`（§2a），兩者內容不同。
2. 舊數據一律視為條件 `legacy-identity`（無壓縮、未固定瀏覽器）：例如 PR #152 兩次 CI 的中位數（achievements 89；index 89 後 90），以及 release 文件中的本機單次結果；它們彼此之間也受 runner／機器差異影響，只能當趨勢參考。
3. 新數據一律視為條件 `br-q4-chromium-<版本>`，以 `summary.json.conditions` 為準。只在條件相同時才比較分數；條件不同時，用同一次 job 裡的 `uncompressed-reference` 與 `candidate` 對照。
4. 90 分門檻不變，但餘裕由約 0～2 分擴大到約 8～10 分；這代表 gate 對「文字資源位元組增加」變得較不敏感（文字資源壓縮約 4～5 倍）。未壓縮的對照 run 保留舊的敏感度，網站仍可用它觀察位元組回歸；若要回到舊 gate 行為，設 `COMPRESSION=none`。
5. 門檻仍有鑑別力（變異測試，於 repository root 量測、尚未對 `_site` 重做）：在 `achievements.html` 前加入一份 400 KB、不可壓縮的 render-blocking CSS，壓縮版 gate 的三次 run 都是 88 分，gate 以 exit 1 失敗（未改動的版本為 100）。
6. 要重現舊的未壓縮條件：`COMPRESSION=none LABEL=legacy npm run test:lighthouse --prefix tests/donation`（要量與 CI 相同的內容，另加 `ROOT_DIR=<建置輸出>`）。

## 8. 指令

```sh
python scripts/build_cloudflare_public.py --output /tmp/public-site        # Python 3.12 + beautifulsoup4==4.13.5 html5lib==1.1
node tests/donation/static-server-check.mjs                                # 伺服器合約測試（無瀏覽器）
node tests/donation/lighthouse-compare-check.mjs                           # 比較契約測試（無瀏覽器）
ROOT_DIR=/tmp/public-site EXPECT_BROWSER_VERSION=140.0.7339.186 npm run test:lighthouse --prefix tests/donation   # gate（壓縮）
ROOT_DIR=/tmp/public-site COMPRESSION=none ENFORCE_THRESHOLDS=0 LABEL=uncompressed-reference PAGES=index.html,achievements.html RUNS=3 \
  npm run test:lighthouse --prefix tests/donation
node tests/donation/lighthouse-compare.mjs <A 資料夾> <B 資料夾> [輸出資料夾]
```

## 9. 發布影響與回復

**合併到 main 不是「沒有部署動作」。** 本 PR 只改 `tests/`、`.github/workflows/`、`docs/`，網站來源與 `_site` 的公開檔案不變；但依現行契約（[CLOUDFLARE-PUBLIC-MIGRATION.md](CLOUDFLARE-PUBLIC-MIGRATION.md)「Normal publication」），任何進 main 的 commit 都會：

1. 觸發 Cloudflare Builds（pinned validators → `quality.py` → `build_cloudflare_public.py` → Wrangler）。新 build 的 `deployment.json` 會帶新的 `sourceCommit`（公開檔案的 `publicArtifactDigest` 不變）；是否產生新的 Worker version 與流量切換由 Cloudflare Builds 決定。
2. 觸發 `cloudflare-public.yml`：重建 artifact，輪詢正式站直到 `/deployment.json` 的 `sourceCommit` 等於這個 commit（預設最多 90 次 × 5 秒）；若 Cloudflare Builds 沒有產生對應版本，這個 workflow 會失敗。
3. 成功後再觸發 `production-verification.yml` 的獨立 HTTP／全頁／瀏覽器檢查，並更新 CMS 的 deployed 收據。

因此合併前請當作「會有一次正式 build／部署與收據更新」處理：對訪客可見的網頁位元組不變，但 `deployment.json` 與 Worker version 會更新。Cloudflare Builds 是否設定了 build watch paths 而略過只動 `tests/`／`docs/` 的 commit，本文件**無法**從 repository 確認（未驗證），請以 Cloudflare dashboard 讀回為準。

回復：還原此 PR（同樣是一次 main 提交，會走同樣的 build／收據流程）即回到 `python3 -m http.server` 條件；網站內容、Cloudflare 設定與已發布內容不受影響。
