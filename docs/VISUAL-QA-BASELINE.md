# A-05 視覺基準的 Git 採用流程

## CI 選擇契約

既有瀏覽器 QA 另支援 `workflow_dispatch` 手動分支取樣，權限仍為 `contents: read`，所有檢查步驟維持不變。非 PR 執行不具有獨立 base 參照，報告會明確標示；這種執行只提供取樣與檢查證據，不會自動採用基準、合併或部署。正式發布仍須在最終 PR head 完成全部必要 CI 與獨立審查。

手動分支操作依 [GitHub 官方工作流程觸發規則](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)；取樣來源須為該分支的真實 commit，完成逐圖及來源審核後才能依下列流程採用。

A-05 compare job 只讀固定的 Git 路徑：`tests/baselines/visual-qa/selection.json`。

- selection 不存在：輸出 `PENDING` 並成功結束；這代表沒有執行基準比較，不能解讀為視覺通過。
- selection 存在：必須同時通過來源完整 SHA、manifest 完整 SHA-256、核准紀錄、30 組 PNG/JSON 相鄰檔案及其內容 hash 驗證。缺檔、格式錯誤、來源不符、越界路徑或 hash 不符均為 `REJECTED`，CI 失敗，不退回 `PENDING`。
- Git selection 是 workflow 唯一的 approved-baseline 來源。現有 14 天 capture artifact 仍供取證與審閱；workflow 不從 artifact 或 `VISUAL_QA_BASELINE_*` repo variables 選基準，也不需修改這些 variables。
- selection 已存在但無效時不會退回任何其他來源。比較仍要求候選與基準環境及量測條件相容，並保留既有像素、transfer、DOM、deployment receipt、HTTP、gzip 與 1440×900 desktop 規則；A-05 job 維持 25 分鐘。

## PR 的獨立 main 參照

PR 的 A-05 job 以 shallow checkout 起跑，只 fetch 並驗證事件提供的單一 40 位 base commit，接著建立 detached worktree。Node、Playwright、runner 與 policy 從目前 PR checkout 載入；Python 3.12 先以同一組固定依賴分別執行 base worktree 自己的 `scripts/build_cloudflare_public.py` 和 candidate checkout 自己的 publisher，兩份輸出放在 `RUNNER_TEMP` 的獨立目錄。base 必須先在可寫狀態完成自身 publication build，再由 capture runner 套用既有 read-only mode、post-mode 與 tracked-byte guard。local screenshot capture 使用 `--site-root GIT_ROOT --public-artifact BUILT_PUBLIC_ROOT`：Git root 提供來源 SHA，HTTP server 只服務已建好的公開 artifact。candidate 也以相同方式服務它自己的 publication artifact；production measurement 仍讀 Cloudflare live deployment receipt。

publication gate 以來源 checkout 的真實 Git HEAD 核對 `deployment.json.sourceCommit`，核對 deployment digest 與原始 `publication-manifest.json` bytes、payload file count、每個 payload SHA-256、payload bytes、四個 delivery wrapper、完全相符的檔案／目錄集合、路徑安全、symlink／hardlink 與 secret-like 值。現行 source-native publication manifest 只宣告 payload 路徑與 SHA-256，沒有宣告 payload byte size；A-05 對每個檔案讀取後計算實際 bytes，並將逐檔與總 bytes inventory 做前後一致性驗證，不把實測值冒稱來源宣告值。manifest 與 capture metadata 記錄 `siteSourceKind`、`sourceGitSHA`、`servedRootRole`、raw manifest SHA、`publicArtifactDigest` 與完整 payload identity；artifact 和 source 都在 capture 前及 finally 後再驗。完整性失敗時，所有已寫入的 partial capture metadata 會失效，並移除可能已寫出的 verified summary。source-native publisher 先依各自版本的 contract 成功完成；A-05 gate 只驗證兩版本共通的來源與 bytes 關係，不以 candidate 版本的 header/font 規則重驗舊 base artifact。

參照輸出放在 `tests/donation/results/visual-qa/main-reference/local-http-uncompressed/`，候選輸出與 live Cloudflare 量測保留在原路徑。兩組 local capture 都成功後，`cross-compare` 會產生 `cross-source-review/cross-source-review.json` 與 30 張逐 capture 像素差異圖；報告列出 source/tool SHA、publication digest、量測 delta、預算狀態及像素差異，固定標為 `CROSS_SOURCE_REVIEW`，保留 `pass: null` 與 `approval: null`，不套用 exception、不宣稱 PASS，也不修改 golden selection。Git canonical-root capture 和 publication-artifact capture 不能互相比較。main／非 PR 執行會明確記錄沒有獨立 PR base，且不會把 candidate 當成自己的 base。

每筆 A-05 metadata、manifest 與 receipt 都分別記錄 `sourceSHA`／`siteSourceSHA`、`sourceGitSHA`、`siteSourceKind`、`servedRootRole` 和 `captureToolSHA`／`checkoutSHA`。Git root 與 tool SHA 都從各自 checkout 的真實 HEAD 取得，不接受命令列 SHA 覆寫，且兩個 checkout 都必須乾淨。publication artifact 必須與 source/tool Git root 及 capture output 分離。approved baseline 的 `selection.json` 綁定網站來源 SHA；manifest、每筆 capture 與 metadata 另核對 capture-tool SHA，允許這兩種身分不同，並拒絕 canonical-root 與 publication-artifact 混合比較。這組 main capture 是跨來源參照與逐圖審閱材料，**不會自動選為 golden**；沒有核准的固定 `selection.json` 時，A-05 comparison 仍為 `PENDING`。 原 83d0e2210079d607d29d5b01c0571feb56929184 是 2026-10-19 初始歷史基準；目前 Git baseline 依固定 selection 指向 ce70c9a94d1a22b767ad8d02ce476da225f93e4c；2026-10-30 的逐圖 AI 工程審閱、原始證據與既有預算例外詳見本文末節。83d、e3f 與 ed2b 的原始資料及核准紀錄均保留為歷史。ca61 cross-source review 仍是 CROSS_SOURCE_REVIEW、pass=null，沒有被解讀成 PASS。

每筆已核准的 per-capture × metric 預算例外必須有有效的帶時區 `expiresAt`，日期必須真實有效，且不可晚於 `approval.reviewedAt` 起 30 日。比較在 `now >= expiresAt` 時 fail closed；原 300,000 bytes／1,500 DOM、觀測值需等於 baseline、metadata SHA、resolution task、不得新增退步及已解債務需清除等條件照常適用。本次採用核准 34 筆有期限的既存預算例外；逐筆差異、資源證據、追蹤任務與到期時間見本文件末段。

## 固定目錄格式

核准後提交以下結構。`<sourceSHA>` 必須是產生該組 capture 的 40 位完整 Git SHA。

```text
tests/baselines/visual-qa/
├── selection.json
└── <sourceSHA>/
    ├── manifest.json
    ├── <capture-id>.png
    └── <capture-id>.json
```

`selection.json` 僅接受以下四個欄位；manifest 路徑必須是 `<sourceSHA>/manifest.json`，以限制在該基準目錄內。

```json
{
  "schemaVersion": 1,
  "manifestPath": "<sourceSHA>/manifest.json",
  "manifestSha256": "<manifest.json 的 64 位 SHA-256>",
  "sourceSHA": "<產生 capture 的 40 位完整 Git SHA>"
}
```

## 完成審閱後採用並提交

先從成功的 A-05 run 下載 `a05-visual-qa-<run_id>`，解壓後將 `SOURCE_DIR` 指向 `local-http-uncompressed` 資料夾。主控須在產品最終 UI 逐張檢視全部 30 張 PNG，並確認相鄰 JSON、manifest 來源 SHA 及量測證據；沒有完成該審核前，不得執行核准步驟。候選 artifact 本身不會自動成為 approved baseline。

```sh
set -euo pipefail
SOURCE_DIR='/absolute/path/to/extracted/local-http-uncompressed'
SOURCE_SHA="$(jq -er '.sourceSHA | select(test("^[a-f0-9]{40}$"))' "$SOURCE_DIR/manifest.json")"
DEST="tests/baselines/visual-qa/$SOURCE_SHA"
mkdir -p "$DEST"

python3 - "$SOURCE_DIR" "$DEST" "$SOURCE_SHA" <<'PY'
import hashlib
import json
import pathlib
import re
import shutil
import sys

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
source_sha = sys.argv[3]
manifest_path = source / 'manifest.json'
manifest_bytes = manifest_path.read_bytes()
manifest = json.loads(manifest_bytes)
if manifest.get('status') != 'CAPTURE_ONLY':
    raise SystemExit('Expected an unapproved CAPTURE_ONLY source manifest')
if manifest.get('siteSourceSHA') != source_sha or manifest.get('sourceSHA') != source_sha:
    raise SystemExit('Manifest source SHA does not match the selected directory')
if manifest.get('captureToolSHA') != manifest.get('checkoutSHA'):
    raise SystemExit('Manifest capture-tool SHA is missing or inconsistent')
captures = manifest.get('captures')
if not isinstance(captures, list) or len(captures) != 30:
    raise SystemExit('Expected exactly 30 captures')
capture_ids = [capture.get('id') for capture in captures]
if any(not isinstance(capture_id, str) for capture_id in capture_ids) or len(set(capture_ids)) != 30:
    raise SystemExit('Capture IDs must be unique')
for capture in captures:
    capture_id = capture.get('id', '')
    if capture.get('siteSourceSHA') != source_sha or capture.get('sourceSHA') != source_sha or capture.get('captureToolSHA') != manifest.get('captureToolSHA'):
        raise SystemExit('Capture source or capture-tool identity does not match the manifest')
    if not re.fullmatch(r'[a-z0-9-]+', capture_id) or capture.get('screenshotPath') != f'{capture_id}.png' or capture.get('metadataPath') != f'{capture_id}.json':
        raise SystemExit('Capture filenames must be adjacent id.png/id.json pairs')
    for key, hash_key in (('screenshotPath', 'screenshotSha256'), ('metadataPath', 'metadataSha256')):
        source_file = source / capture[key]
        if source_file.is_symlink() or not source_file.is_file():
            raise SystemExit(f'Capture file is not a regular file: {source_file.name}')
        data = source_file.read_bytes()
        if hashlib.sha256(data).hexdigest() != capture.get(hash_key):
            raise SystemExit(f'Capture hash mismatch: {source_file.name}')
        shutil.copyfile(source_file, destination / source_file.name)
shutil.copyfile(manifest_path, destination / 'manifest.json')
print(f'Copied and hash-checked {len(captures)} PNG/JSON pairs from {source_sha}')
PY
```

完成全部審閱後，填入真實審核者、時間與判斷說明，將 manifest 由 `CAPTURE_ONLY` 明確改為 `APPROVED`：

```sh
REVIEWED_BY='審核者姓名或識別'
REVIEWED_AT='2026-10-19T12:00:00+08:00'
APPROVAL_NOTE='已逐張檢視 30 張 local-http-uncompressed PNG，並核對其 JSON 與 manifest 證據。'
jq --arg reviewedBy "$REVIEWED_BY" --arg reviewedAt "$REVIEWED_AT" --arg note "$APPROVAL_NOTE" \
  '.status = "APPROVED" | .approval = {reviewedBy: $reviewedBy, reviewedAt: $reviewedAt, note: $note}' \
  "$DEST/manifest.json" > "$DEST/manifest.approved.json"
mv "$DEST/manifest.approved.json" "$DEST/manifest.json"
```

產生固定 selection；SHA 在核准欄位寫入後計算：

```sh
python3 - "$DEST/manifest.json" "$SOURCE_SHA" tests/baselines/visual-qa/selection.json <<'PY'
import hashlib
import json
import pathlib
import sys

manifest_path, source_sha, selection_path = pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3])
manifest_bytes = manifest_path.read_bytes()
selection = {
    'schemaVersion': 1,
    'manifestPath': f'{source_sha}/manifest.json',
    'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
    'sourceSHA': source_sha,
}
selection_path.parent.mkdir(parents=True, exist_ok=True)
selection_path.write_text(json.dumps(selection, indent=2) + '\n', encoding='utf-8')
print(f'Wrote {selection_path}')
PY

npm run test:visual-qa --prefix tests/donation
git add -- "$DEST" tests/baselines/visual-qa/selection.json
git diff --cached --check
git diff --cached --stat
git commit -m "test: approve A-05 visual QA baseline"
```

提交後的 PR workflow 會在相同固定路徑讀取該基準。本流程依完整審閱證據採用 capture；本次審核者記錄為 Codex 主控（非作者 AI 工程審查），不是人類或使用者簽核。目前 selection 指向 sourceSHA e3f63ff40a8d1d52a361a52e8f8c635754a3cfe3 的 30 組新基準，manifest SHA-256 為 17bac19fb54df3420f94812e8a4174a9e6300501336930b86a7b23730d9814d0。這是新 snapshot 的正式採用，不表示 native metric comparison 通過，也沒有修改 83d 歷史基準或比較規則。

## CI 狀態判讀

| CI 狀態 | 意義 |
|---|---|
| `PENDING` | 固定 selection 尚未提交；只有 capture evidence，沒有視覺比較或 pass。 |
| `PASS` | 已核准 Git 基準與本次 30 張候選完成像素和 transfer/DOM 比較，均通過既有門檻。 |
| `FAIL`／`STALE_BASELINE`／`INCOMPARABLE` | 比較已執行，但發現回歸、舊例外或不可比條件；CI 依既有 gate 失敗。 |
| `REJECTED` | selection、來源、manifest hash、approved 狀態或 PNG/JSON 檔案檢查失敗；CI fail-closed。 |
| `NOT_RUN` | capture 本身失敗，因此沒有執行比較。 |


## 初始 owned UI readiness（capture 取樣時機修正）

部分第一方 UI 在 `load` 之後才完成：首頁小 Q 先以 `requestIdleCallback`（timeout 1200）掛載，再以第二個 idle callback 插入自己的 stylesheet，並在該 stylesheet 的 `onload` 才取消 `hidden`。原 capture 在 `load`、字型與可見圖片 decode 後立即取 DOM 與 performance，之後才截圖，因此可能少計這支晚載 stylesheet，截圖卻已呈現完整小 Q。CDP network 一直收集到最後，所以 network rows 看得到這支 stylesheet，performance 取樣卻沒有。

`tests/donation/visual-qa-readiness.mjs` 在 `page.goto(load)` 之後、字型、圖片、動畫、DOM、performance 與截圖之前，以元件既有的 ready 訊號等待初始 owned UI：小 Q 的 `data-mounted="true"` 與 `hidden=false`（只在其 stylesheet `onload` 後成立）、所有 `link[rel~=stylesheet]` 已載入，同源 stylesheet 也都已有 PerformanceResourceTiming entry。等待以 50ms 輪詢，上限 10 秒；逾時或 stylesheet 載入失敗即 fail closed，頁面沒有該元件時立即通過。screenshot 與 measurement-only 兩種模式走同一路徑。產品 UI、public bytes、預算與比較條件都沒有改變，真實資源成本照常計入。

每筆 metadata 新增 `initialUiReadiness`（status、waitedMs、polls、元件與 stylesheet 狀態）。capture quality 另外拒絕以下情況：缺少此證據、未 READY、stylesheet 未載入或缺 performance entry（`INITIAL_UI_NOT_READY`／`INITIAL_UI_STYLESHEET_NOT_MEASURED`），以及 network 看到的同源 stylesheet 不在取樣證據內（`MEASUREMENT_SAMPLED_BEFORE_STYLESHEET`）。`measurementScope`、`environmentLabel` 與 transfer 量測來源不變，所以這是既有 load／可見 UI 取樣時機的 bugfix，不是新的量測條件。早於此修正的 baseline metadata 沒有 `initialUiReadiness`，採用前必須另行證明其數值等於修正後工具的完整初始狀態。

## 第一方請求 settlement 與 news lazy 圖的非決定性

小 Q readiness 之後、DOM／performance／截圖之前，capture 會等待第一方請求 settlement：每次輪詢先等兩個真實 layout frame（讓最新 layout 排程的 lazy 工作有機會發出），再要求第一方請求維持 300ms「沒有進行中、也沒有新開始」。上限 10 秒，逾時即 fail closed，證據列出仍在進行的第一方路徑。frame 等待與 readiness probe 都以 Node 端 deadline 計時，renderer 一直不送 animation frame 時同樣會在上限內失敗（證據標記 `frameTimedOut`／`probeTimedOut`），不會無限等待。第三方請求只計數、不等待，失敗的第一方請求視為已結束，但仍由既有的 `FIRST_PARTY_REQUEST_FAILED` 判為不完整。這段等待不會強制載入、阻擋或忽略任何資源，也不會 decode 畫面外的圖片。

每筆 metadata 新增 `firstPartySettlement`，內容包括 status、waitedMs、polls、quiet window、仍在進行的第一方請求、第三方未完成數、`domInteractiveMs`、performance 取樣涵蓋的同源 URL、每張 lazy 圖是否有 layout box、在 settled layout 下距 viewport 底部的距離、是否被請求，以及 `earlyLazyRequests`（沒有 layout box 或位在 settled viewport 外、卻已被請求的 lazy 圖）。capture quality 另外拒絕以下情況：缺少此證據（`FIRST_PARTY_SETTLEMENT_MISSING`）、未 settled（`FIRST_PARTY_NOT_SETTLED`）、第一方請求未完成（`FIRST_PARTY_REQUEST_UNFINISHED`），以及 network 已完成、卻不在 performance 取樣內的第一方請求（`MEASUREMENT_SAMPLED_BEFORE_REQUEST_COMPLETED`）。以 1.5 秒延遲 JPEG 回應做實驗時，舊取樣點在請求已發出的情況下仍少計整張圖，新取樣點則完整計入。

`measurementScope`、環境標籤與 transfer 量測來源都不變。這段 settlement 只保證「瀏覽器實際發出的第一方請求已完成並計入」，不改變量測對象。在與 755 相同的公開 bytes 上，以新工具做 5 次完整 capture，其中 28 張的 DOM 與 transfer 都和 755 相同。

原因：`news.html` 第一則報導的 lazy 圖（約 206 KB）是否被請求並非取樣時機問題，而是瀏覽器在 `load` 之前就做出的決定。Chromium 的 HTML parser 若在解析中途讓出、並在 `news.js` 重排之前跑了一次渲染更新，就會依當時的靜態 layout 判定這張圖在 lazy 門檻內而請求它；若沒有讓出，最終 layout 的距離（390：2003px、1440：1559px）超過門檻，之後也不會再請求。因此舊版 news-390／news-1440 會落在 388,678 或 595,460 bytes 兩個完整值之一，CI run `41008749618` 的 news FAIL 就是這個情況。

處理：產品端在 `news.html` 把這張來源照片的 `<img>` 放進 figure 內的原生收合 `<details class="news-report-media-gate">`（入口文字「查看圖片」），所以任何靜態 layout 都不會 lazy 預取它。`news.js` 建立閱讀層時移除這層包裝，把原 figure 放進既有的收合「內容與完整報導」，JS 模式的最終 DOM 與版面不變。沒有 JS、`news.js` 載入失敗或 CMS 預覽（`news.js` 提早返回）時，原生入口可用鍵盤展開。figure 仍是卡片的直接子元素、figcaption 位置不變，所以 CMS 編輯 manifest（欄位 id、source hash）與 latest-info 投影都不變。圖片原檔、src、alt、尺寸、圖說與來源連結都沒有更動，也沒有改為 eager、阻擋或忽略這支 JPEG。

本機驗證（尚非 Linux CI）：以快速解析、`news.js` 延遲 800ms、分塊串流 HTML 造成解析途中 paint、CPU 降速 4 倍四種條件，各在 390／1440 跑 5 次。新版 40/40 都沒有初始預取，展開後 40/40 都載入原圖；同條件下舊版 28/40 會預取。在重建的新公開產物上做 5 次完整 capture，30 張的 DOM 與 transfer 每張都只有一個值，news-390／1440 為 790／389,410，`earlyLazyRequests` 為空。公開 bytes 改變的頁面（news、news-special-education-nurse、explore）需要以新 commit 的 Linux CI capture 重新審閱並採用；採用時沿用既有 34 筆例外的鍵、限值、追蹤任務與 2026-11-17 到期日，觀測值取新 capture 實測。

## 2026-10-19 初始歷史基準（9c / 83d0）與預算債務紀錄

- 採用決策：execution/jobs/manager-9c-baseline-adoption-decision.md；native A-05 run 39192767770、artifact 12160737923、ZIP SHA-256 31a0e9759e2ce706782abd326b2ef3bd8c0d69c45960eebe0c3919880c763902。
- A-05 candidate 取自 local-http-uncompressed publication artifact，sourceSHA 與 captureToolSHA 均為 83d0e2210079d607d29d5b01c0571feb56929184；Git baseline 僅複製 30 組 PNG/JSON 與 manifest，原始 artifact 未修改。manifest approval 時間 2026-10-19T11:21:31+08:00，審核者為 Codex 主控（非作者 AI 工程審查）。
- 初始 selection 曾綁定 manifest SHA-256 85477674a5e4ac2e56c6d121848b161762733c48909f14eeab80ebf6f7061879；這組 83d 歷史資料及原核准內容均保留。ca61 來源 ca61aac302e6e90811c513193f20274cf1936191 只作方向對照；cross-source-review 是 CROSS_SOURCE_REVIEW、pass=null、baselineSelected=false，沒有被當成基準或 PASS 證據。
- 原全域限值維持 transfer 300000 bytes、DOM 1500。例外共 34 筆：30 筆 transfer、4 筆 DOM；每筆均保留 ca61 參照值、candidate 值、方向、既存超標狀態及實際 capture 證據。transfer 的必要同源 UI 資源類型取自各筆 metadata network；DOM 例外對應已採用 route/template 的實測 UI tree。
- 所有 resolution task 仍開啟，命名依各列 captureId/metric 組成；例外統一於 2026-11-17T23:59:00+08:00 到期。此表不代表修復已完成，不建立排程，也不延長全域限值。

| capture | metric | ca61 參照 | candidate | 差值 | 判讀 | UI 必要資源 / 證據 | resolutionTask | expiresAt |
|---|---|---:|---:|---:|---|---|---|---|
| home-390 | sameOriginTransferSizeBytes | 530635 | 463133 | -67,502 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Image, Script, Stylesheet (17 requests); home-390.json | A-05-BUDGET-REVIEW:home-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| home-1440 | sameOriginTransferSizeBytes | 837584 | 463133 | -374,451 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Image, Script, Stylesheet (17 requests); home-1440.json | A-05-BUDGET-REVIEW:home-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| achievements-390 | sameOriginTransferSizeBytes | 1039794 | 1075733 | +35,939 | 增加；ca61 與候選均超限，記錄增幅 | same-origin: Document, Font, Script, Stylesheet (12 requests); achievements-390.json | A-05-BUDGET-REVIEW:achievements-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| achievements-390 | domElementCount | 6419 | 6432 | +13 | 增加；ca61 與候選均超限，記錄增幅 | route UI DOM; achievements-390.json | A-05-BUDGET-REVIEW:achievements-390:domElementCount | 2026-11-17T23:59:00+08:00 |
| achievements-1440 | sameOriginTransferSizeBytes | 1039794 | 1075733 | +35,939 | 增加；ca61 與候選均超限，記錄增幅 | same-origin: Document, Font, Script, Stylesheet (12 requests); achievements-1440.json | A-05-BUDGET-REVIEW:achievements-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| achievements-1440 | domElementCount | 6419 | 6432 | +13 | 增加；ca61 與候選均超限，記錄增幅 | route UI DOM; achievements-1440.json | A-05-BUDGET-REVIEW:achievements-1440:domElementCount | 2026-11-17T23:59:00+08:00 |
| achievement-metro-green-line-390 | sameOriginTransferSizeBytes | 1389805 | 860353 | -529,452 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Image, Script, Stylesheet (13 requests); achievement-metro-green-line-390.json | A-05-BUDGET-REVIEW:achievement-metro-green-line-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| achievement-metro-green-line-1440 | sameOriginTransferSizeBytes | 1389805 | 860353 | -529,452 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Image, Script, Stylesheet (13 requests); achievement-metro-green-line-1440.json | A-05-BUDGET-REVIEW:achievement-metro-green-line-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| achievement-wende-school-center-390 | sameOriginTransferSizeBytes | 980598 | 437826 | -542,772 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Script, Stylesheet (11 requests); achievement-wende-school-center-390.json | A-05-BUDGET-REVIEW:achievement-wende-school-center-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| achievement-wende-school-center-1440 | sameOriginTransferSizeBytes | 980598 | 437826 | -542,772 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Script, Stylesheet (11 requests); achievement-wende-school-center-1440.json | A-05-BUDGET-REVIEW:achievement-wende-school-center-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| achievement-special-education-support-390 | sameOriginTransferSizeBytes | 1115738 | 564910 | -550,828 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Image, Script, Stylesheet (12 requests); achievement-special-education-support-390.json | A-05-BUDGET-REVIEW:achievement-special-education-support-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| achievement-special-education-support-1440 | sameOriginTransferSizeBytes | 1115738 | 564910 | -550,828 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Image, Script, Stylesheet (12 requests); achievement-special-education-support-1440.json | A-05-BUDGET-REVIEW:achievement-special-education-support-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| news-390 | sameOriginTransferSizeBytes | 350544 | 378907 | +28,363 | 增加；ca61 與候選均超限，記錄增幅 | same-origin: Document, Font, Script, Stylesheet (14 requests); news-390.json | A-05-BUDGET-REVIEW:news-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| news-1440 | sameOriginTransferSizeBytes | 350544 | 378907 | +28,363 | 增加；ca61 與候選均超限，記錄增幅 | same-origin: Document, Font, Script, Stylesheet (14 requests); news-1440.json | A-05-BUDGET-REVIEW:news-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| news-special-education-nurse-390 | sameOriginTransferSizeBytes | 425484 | 457065 | +31,581 | 增加；ca61 與候選均超限，記錄增幅 | same-origin: Document, Font, Image, Script, Stylesheet (12 requests); news-special-education-nurse-390.json | A-05-BUDGET-REVIEW:news-special-education-nurse-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| news-special-education-nurse-1440 | sameOriginTransferSizeBytes | 425484 | 457065 | +31,581 | 增加；ca61 與候選均超限，記錄增幅 | same-origin: Document, Font, Image, Script, Stylesheet (12 requests); news-special-education-nurse-1440.json | A-05-BUDGET-REVIEW:news-special-education-nurse-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| activities-390 | sameOriginTransferSizeBytes | 980235 | 348443 | -631,792 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Script, Stylesheet (13 requests); activities-390.json | A-05-BUDGET-REVIEW:activities-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| activities-1440 | sameOriginTransferSizeBytes | 980235 | 348443 | -631,792 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Script, Stylesheet (13 requests); activities-1440.json | A-05-BUDGET-REVIEW:activities-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| event-campaign-headquarters-opening-390 | sameOriginTransferSizeBytes | 1838899 | 1206033 | -632,866 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Image, Script, Stylesheet (15 requests); event-campaign-headquarters-opening-390.json | A-05-BUDGET-REVIEW:event-campaign-headquarters-opening-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| event-campaign-headquarters-opening-1440 | sameOriginTransferSizeBytes | 1838899 | 1206033 | -632,866 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Image, Script, Stylesheet (15 requests); event-campaign-headquarters-opening-1440.json | A-05-BUDGET-REVIEW:event-campaign-headquarters-opening-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| gallery-390 | sameOriginTransferSizeBytes | 1992857 | 1349188 | -643,669 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Image, Script, Stylesheet (20 requests); gallery-390.json | A-05-BUDGET-REVIEW:gallery-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| gallery-1440 | sameOriginTransferSizeBytes | 1992857 | 1349188 | -643,669 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Image, Script, Stylesheet (20 requests); gallery-1440.json | A-05-BUDGET-REVIEW:gallery-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| service-390 | sameOriginTransferSizeBytes | 993830 | 386405 | -607,425 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Script, Stylesheet (15 requests); service-390.json | A-05-BUDGET-REVIEW:service-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| service-1440 | sameOriginTransferSizeBytes | 993830 | 386405 | -607,425 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Script, Stylesheet (15 requests); service-1440.json | A-05-BUDGET-REVIEW:service-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| petition-390 | sameOriginTransferSizeBytes | 963601 | 342253 | -621,348 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Script, Stylesheet (11 requests); petition-390.json | A-05-BUDGET-REVIEW:petition-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| petition-1440 | sameOriginTransferSizeBytes | 963601 | 342253 | -621,348 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Script, Stylesheet (11 requests); petition-1440.json | A-05-BUDGET-REVIEW:petition-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| election-390 | sameOriginTransferSizeBytes | 884974 | 916105 | +31,131 | 增加；ca61 與候選均超限，記錄增幅 | same-origin: Document, Font, Script, Stylesheet (13 requests); election-390.json | A-05-BUDGET-REVIEW:election-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| election-390 | domElementCount | 4829 | 4835 | +6 | 增加；ca61 與候選均超限，記錄增幅 | route UI DOM; election-390.json | A-05-BUDGET-REVIEW:election-390:domElementCount | 2026-11-17T23:59:00+08:00 |
| election-1440 | sameOriginTransferSizeBytes | 884974 | 916105 | +31,131 | 增加；ca61 與候選均超限，記錄增幅 | same-origin: Document, Font, Script, Stylesheet (13 requests); election-1440.json | A-05-BUDGET-REVIEW:election-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| election-1440 | domElementCount | 4829 | 4835 | +6 | 增加；ca61 與候選均超限，記錄增幅 | route UI DOM; election-1440.json | A-05-BUDGET-REVIEW:election-1440:domElementCount | 2026-11-17T23:59:00+08:00 |
| explore-390 | sameOriginTransferSizeBytes | 2146586 | 2174747 | +28,161 | 增加；ca61 與候選均超限，記錄增幅 | same-origin: Document, Fetch, Font, Script, Stylesheet (14 requests); explore-390.json | A-05-BUDGET-REVIEW:explore-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| explore-1440 | sameOriginTransferSizeBytes | 2146586 | 2174747 | +28,161 | 增加；ca61 與候選均超限，記錄增幅 | same-origin: Document, Fetch, Font, Script, Stylesheet (14 requests); explore-1440.json | A-05-BUDGET-REVIEW:explore-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| not-found-390 | sameOriginTransferSizeBytes | 961033 | 309713 | -651,320 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Script, Stylesheet (11 requests); not-found-390.json | A-05-BUDGET-REVIEW:not-found-390:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |
| not-found-1440 | sameOriginTransferSizeBytes | 961033 | 309713 | -651,320 | 下降；兩端仍超限，既存債務延續 | same-origin: Document, Font, Script, Stylesheet (11 requests); not-found-1440.json | A-05-BUDGET-REVIEW:not-found-1440:sameOriginTransferSizeBytes | 2026-11-17T23:59:00+08:00 |


## 2026-10-19 新版 snapshot 採用（e3f，已由後續 selection 取代）

- 依 `execution/jobs/manager-c880-baseline-decision.md`，目前固定 selection 指向 `e3f63ff40a8d1d52a361a52e8f8c635754a3cfe3/manifest.json`。新來源是 native A-05 run `39200314656`、artifact `12162759820`；ZIP SHA-256 `0294349a11899793e6cb4fabea0fff832e2c7b9616463be9bbfca7a8c5dd9d8f`，source/capture-tool SHA 均為 `e3f63ff40a8d1d52a361a52e8f8c635754a3cfe3`，publication digest `cf6b0bf2ffb53227012a4543098c24bbef01e13299284c15849449d89a7261d3`。native 原始檔仍在 `execution/ci-artifacts/release3-c880-a05/local-http-uncompressed`；Git 新增其 30 張 PNG、30 份 metadata 及 manifest 副本，PNG 與 metadata bytes 均原樣保留。
- native CAPTURE_ONLY 原 manifest SHA-256 為 `bde9c79f0e11a4db0658c02f542a514d9149da654afbb3f5bfbf24ebeed7be60`，sidecar 相符。新 Git manifest SHA-256 為 `17bac19fb54df3420f94812e8a4174a9e6300501336930b86a7b23730d9814d0`；selection schema 1 僅含原定四欄，selection.json SHA-256 為 `87dab071fd18022fd06619a33746963288acc5fdcac73fd1d4a261ebb04978fd`，manifest 路徑、來源 SHA 與 manifest SHA 均已重算。manifest 的 status/approval/例外欄位按主控核准更新；capture、source/tool SHA、metadata hash、policy、pixel threshold、比較條件和 artifact identity 不變。審核時間 `2026-10-19T13:24:56+08:00`；審核者為 Codex 主控非作者 AI 工程審查，不代表人類或使用者簽核。
- native 原 pixel comparison 為 30/30 PASS、DOM delta 0；另已驗 native warm-cache CSS/JS/Common 3 資源均 `fromDiskCache` 且 map PASS。這些證據支持本次新版 golden 採用。native metric comparison 仍為 `FAIL`，其中 30 筆 `sameOriginTransferSizeBytes` 是合法 G1 full-hash／安全修正的 cold-byte 變化，必須維持 FAIL 記錄；本次採用不把同 artifact compare 說成 native gate PASS，也不代表冷 budget 全數達標。新版 capture 的 30 筆 transfer 例外及 4 筆 DOM 例外逐筆記錄在 manifest，觀測值取同一 capture 的實測 metrics、`evidencePath` 指向相鄰 metadata，`metadataSha256` 為該原始 JSON bytes 的真實 SHA-256。
- 每筆例外 limit 仍為 300000 bytes／1500 DOM；resolution task 維持 `A-05-BUDGET-REVIEW:<captureId>:<metric>` 且未結清，到期仍為 `2026-11-17T23:59:00+08:00`，未展期。no-new-regression、到期即 fail、已解債務須清除及舊 baseline fail-closed 等條件維持原樣。83d 初始歷史資料與舊 approval 保留；ca61 cross-source 仍是 `CROSS_SOURCE_REVIEW`、`pass=null`；A06 native compare true PASS 及 historical production baseline 未修改。

| capture | metric | 83d 初始值 → e3f 新實測值 | 差值 | evidencePath | metadataSha256 | resolutionTask | expiresAt |
|---|---|---:|---:|---|---|---|---|
| home-390 | `sameOriginTransferSizeBytes` | 463,133 → 463,852 | +719 | `home-390.json` | `8487c290a0a8eef45a5605e52605aa820de81d869894cd56e118e1aab96d06ba` | `A-05-BUDGET-REVIEW:home-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| home-1440 | `sameOriginTransferSizeBytes` | 463,133 → 463,852 | +719 | `home-1440.json` | `8a84356e9e0dafc8ea5a6844e528579be4e158a12395f689f5045fbf5de79d1d` | `A-05-BUDGET-REVIEW:home-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievements-390 | `sameOriginTransferSizeBytes` | 1,075,733 → 1,076,482 | +749 | `achievements-390.json` | `754c5e731dac7495fa3e7b6acf8648f0e56248801b10cb853802ddbfb08602e4` | `A-05-BUDGET-REVIEW:achievements-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievements-390 | `domElementCount` | 6,432 → 6,432 | +0 | `achievements-390.json` | `754c5e731dac7495fa3e7b6acf8648f0e56248801b10cb853802ddbfb08602e4` | `A-05-BUDGET-REVIEW:achievements-390:domElementCount` | 2026-11-17T23:59:00+08:00 |
| achievements-1440 | `sameOriginTransferSizeBytes` | 1,075,733 → 1,076,482 | +749 | `achievements-1440.json` | `c5fd39435ea5afebfa43f049808acdad8ee1c8b1fb5c802d7f8469ffa82171be` | `A-05-BUDGET-REVIEW:achievements-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievements-1440 | `domElementCount` | 6,432 → 6,432 | +0 | `achievements-1440.json` | `c5fd39435ea5afebfa43f049808acdad8ee1c8b1fb5c802d7f8469ffa82171be` | `A-05-BUDGET-REVIEW:achievements-1440:domElementCount` | 2026-11-17T23:59:00+08:00 |
| achievement-metro-green-line-390 | `sameOriginTransferSizeBytes` | 860,353 → 860,872 | +519 | `achievement-metro-green-line-390.json` | `4f8550723cc50dc4473cb769beff3071313556820ce69ae6b53f1bef11516448` | `A-05-BUDGET-REVIEW:achievement-metro-green-line-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-metro-green-line-1440 | `sameOriginTransferSizeBytes` | 860,353 → 860,872 | +519 | `achievement-metro-green-line-1440.json` | `a9026cd796bb557f6aa8ca82159d25497cc66b4292ccf324761f1f3d394e9551` | `A-05-BUDGET-REVIEW:achievement-metro-green-line-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-wende-school-center-390 | `sameOriginTransferSizeBytes` | 437,826 → 438,345 | +519 | `achievement-wende-school-center-390.json` | `972c8ae0ad3f80da99f9cab0d83024f46d4245001204c34164e1dfe90d9f5fad` | `A-05-BUDGET-REVIEW:achievement-wende-school-center-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-wende-school-center-1440 | `sameOriginTransferSizeBytes` | 437,826 → 438,345 | +519 | `achievement-wende-school-center-1440.json` | `230e88ecb136f04971b387dafc646fdde6317629a5e8faebca1ae86a3ce599e0` | `A-05-BUDGET-REVIEW:achievement-wende-school-center-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-special-education-support-390 | `sameOriginTransferSizeBytes` | 564,910 → 565,429 | +519 | `achievement-special-education-support-390.json` | `d488d3a3d92c6bdb436b859a8655e0be2248d42379239793ab1afb505416cee0` | `A-05-BUDGET-REVIEW:achievement-special-education-support-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-special-education-support-1440 | `sameOriginTransferSizeBytes` | 564,910 → 565,429 | +519 | `achievement-special-education-support-1440.json` | `738e6e15365b252a85d5a2d55edb3dc74d936b591120f563abe531493bcbf28c` | `A-05-BUDGET-REVIEW:achievement-special-education-support-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| news-390 | `sameOriginTransferSizeBytes` | 378,907 → 379,526 | +619 | `news-390.json` | `83c5473946453f7a8080dc480e731922ff2fc0d8a896b59a5c9e6f7a49dcf9be` | `A-05-BUDGET-REVIEW:news-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| news-1440 | `sameOriginTransferSizeBytes` | 378,907 → 586,308 | +207,401 | `news-1440.json` | `31b5a22c1688269f93efcc0722674011ea920e3350b909c7ab1e1e8cf849738f` | `A-05-BUDGET-REVIEW:news-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| news-special-education-nurse-390 | `sameOriginTransferSizeBytes` | 457,065 → 457,534 | +469 | `news-special-education-nurse-390.json` | `f528b7e7ccf355ef671ef61197c727abff65ad7b796380fb750a53386a2a818e` | `A-05-BUDGET-REVIEW:news-special-education-nurse-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| news-special-education-nurse-1440 | `sameOriginTransferSizeBytes` | 457,065 → 457,534 | +469 | `news-special-education-nurse-1440.json` | `6274ac19cb7dd82b2df0be664c939576b9f411b3f053a3f5c1766a04a78176b9` | `A-05-BUDGET-REVIEW:news-special-education-nurse-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| activities-390 | `sameOriginTransferSizeBytes` | 348,443 → 348,962 | +519 | `activities-390.json` | `5995894b00b202613953145d9f628610c0c5aaf72315798623dac677c1fed80c` | `A-05-BUDGET-REVIEW:activities-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| activities-1440 | `sameOriginTransferSizeBytes` | 348,443 → 348,962 | +519 | `activities-1440.json` | `10a1b9d99f30b079bc254bccb26764978cf6e91f31a102d85f9c0ead3546c440` | `A-05-BUDGET-REVIEW:activities-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| event-campaign-headquarters-opening-390 | `sameOriginTransferSizeBytes` | 1,206,033 → 1,206,552 | +519 | `event-campaign-headquarters-opening-390.json` | `70e3b06f9f2777d7358cad13b1a6b57d19d362d23400e5ada10262626f69b7f6` | `A-05-BUDGET-REVIEW:event-campaign-headquarters-opening-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| event-campaign-headquarters-opening-1440 | `sameOriginTransferSizeBytes` | 1,206,033 → 1,206,552 | +519 | `event-campaign-headquarters-opening-1440.json` | `6149721c6717ab3a601853aa23004cc596aa6db46b25a8d2bcb361f1313540c5` | `A-05-BUDGET-REVIEW:event-campaign-headquarters-opening-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| gallery-390 | `sameOriginTransferSizeBytes` | 1,349,188 → 1,349,607 | +419 | `gallery-390.json` | `eb916e69d596a290f8a1e58cfd426eb14ff38729c6371ed39b252d6f4d10edb2` | `A-05-BUDGET-REVIEW:gallery-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| gallery-1440 | `sameOriginTransferSizeBytes` | 1,349,188 → 1,349,607 | +419 | `gallery-1440.json` | `6ea7f6d5e8b4e82aca9c8035e44185cfc5b5efb6d34f571cb45b68b8f51ff63f` | `A-05-BUDGET-REVIEW:gallery-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| service-390 | `sameOriginTransferSizeBytes` | 386,405 → 387,024 | +619 | `service-390.json` | `c346a2038631b264298b47bbc0fa291e36bdbb0f54a872c00f4b8dd9d0b394d7` | `A-05-BUDGET-REVIEW:service-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| service-1440 | `sameOriginTransferSizeBytes` | 386,405 → 387,024 | +619 | `service-1440.json` | `f0169a84d2851f8a8a12635e8d165a42fd9806ca0efa99b90fbf9ead00989f26` | `A-05-BUDGET-REVIEW:service-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| petition-390 | `sameOriginTransferSizeBytes` | 342,253 → 342,672 | +419 | `petition-390.json` | `ce8b6c9dcbf70dcc7a7493b912114fd7c0461c3a09e526c68c711a8df635a778` | `A-05-BUDGET-REVIEW:petition-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| petition-1440 | `sameOriginTransferSizeBytes` | 342,253 → 342,672 | +419 | `petition-1440.json` | `8b503d53fa660c8d10c5d98a2fe55c4405e56364be38a607f4638dd359919cf6` | `A-05-BUDGET-REVIEW:petition-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| election-390 | `sameOriginTransferSizeBytes` | 916,105 → 916,674 | +569 | `election-390.json` | `68f045ddb577e574db29b75e95254c07ee8044b36c9bb9feada8a914f91d34e1` | `A-05-BUDGET-REVIEW:election-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| election-390 | `domElementCount` | 4,835 → 4,835 | +0 | `election-390.json` | `68f045ddb577e574db29b75e95254c07ee8044b36c9bb9feada8a914f91d34e1` | `A-05-BUDGET-REVIEW:election-390:domElementCount` | 2026-11-17T23:59:00+08:00 |
| election-1440 | `sameOriginTransferSizeBytes` | 916,105 → 916,674 | +569 | `election-1440.json` | `c4ace366b4f98b354ee909f505d2f3b6fa36982a7364b118e5b333bdca517602` | `A-05-BUDGET-REVIEW:election-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| election-1440 | `domElementCount` | 4,835 → 4,835 | +0 | `election-1440.json` | `c4ace366b4f98b354ee909f505d2f3b6fa36982a7364b118e5b333bdca517602` | `A-05-BUDGET-REVIEW:election-1440:domElementCount` | 2026-11-17T23:59:00+08:00 |
| explore-390 | `sameOriginTransferSizeBytes` | 2,174,747 → 2,175,766 | +1,019 | `explore-390.json` | `f0ad7570c29949e1683936c0bfa6b7d32cb6cde1f97cc4a0a27c52586ed67ab4` | `A-05-BUDGET-REVIEW:explore-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| explore-1440 | `sameOriginTransferSizeBytes` | 2,174,747 → 2,175,766 | +1,019 | `explore-1440.json` | `58d4935d3dcdd2b535a98570ad3a30a6808633a9aa9024c89a7618a49ff1059e` | `A-05-BUDGET-REVIEW:explore-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| not-found-390 | `sameOriginTransferSizeBytes` | 309,713 → 310,132 | +419 | `not-found-390.json` | `5486b235001236b42f151b1f5d037eed25973ce480bf427f3dee4239a5fca07f` | `A-05-BUDGET-REVIEW:not-found-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| not-found-1440 | `sameOriginTransferSizeBytes` | 309,713 → 310,132 | +419 | `not-found-1440.json` | `45954bacbf76922bb2d6faa73e71e59b3338e1eee47cf55f4f5f9b688f02778b` | `A-05-BUDGET-REVIEW:not-found-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |

## 2026-10-30 PR #235 紫色官網改版 snapshot 採用（ce70，已由後續 selection 取代）

- 目前固定 selection 指向 `ce70c9a94d1a22b767ad8d02ce476da225f93e4c/manifest.json`。來源是 PR #235 的 A-05 run `40983961080`、artifact `12946164615` 的 `local-http-uncompressed` capture；source／capture-tool SHA 均為 `ce70c9a94d1a22b767ad8d02ce476da225f93e4c`（與 `689ea258` 同一 tree），publication digest `24920c951daf4b617b85667a6457dd2d6b17c8e8cf4c70344ac6820168f24fae`。Git 新增其 30 張 PNG、30 份 metadata 及 manifest；PNG 與 metadata bytes 原樣保留並逐檔核對 SHA-256。
- 原始 CAPTURE_ONLY manifest SHA-256 為 `7c92eebb135f71897e1c7ac2735ff08f44561cd1306293e0607cb55f555d7860`。採用時只更新 `status`（`APPROVED`）、`approval` 與 `exceptions`，capture、source/tool SHA、metadata hash、policy 及 artifact identity 不變。核准後 manifest SHA-256 為 `af3930bb61cf1efd7a02c6e758ed5c37ecb2c5a27688bceccfcbb0c2dc9281d8`；selection schema 1 只含原定四欄，selection.json SHA-256 為 `e3109cbbe58c539cc384d5bb24969ad2652bf9c7a1f8be5c45e96368710a9b21`。
- 審閱者記為「Codex 主控（AI代理，依網站管理者Hong1998tw本次官網改版與直接部署指示代為工程審閱）」，審閱時間 `2026-10-30T09:39:20+08:00`。主控逐張目視審閱 30 張 PNG，並核對 hash 與來源；這是 AI 主控的工程與視覺審查，不代表人類或使用者本人簽核。
- 同一 run 以 ed2bdb57 selection 比較的結果為 `FAIL`：30/30 像素差異屬本次改版的預期畫面變更，metric 為 `NEW_REGRESSION`。該 FAIL 紀錄保留；採用後以同一 capture 自我比較只驗證採用契約，不等於正式 CI PASS，也不代表 production 量測成功。
- 34 筆例外沿用 ed2bdb57 的同一組 capture × metric 鍵（30 筆 transfer、4 筆 DOM），0 筆新增超限、0 筆回到預算內。觀測值取本次 capture 的實測 metrics，`evidencePath` 指向相鄰 metadata。相對同一 run 的 main `d711ba8c` 參考，本次改版的同源原始 bytes 增加約 5–9 KB（品牌色、主導覽、首頁最新資訊）；home-1440 與 news-1440 較 main 參考為低。achievements 的 transfer／DOM 和 ed2bdb57 差距較大，來自 ed2bdb57 之後 main 已合併的政績列表增至 2,657 筆，不屬本次改版。限值仍為 300000 bytes／1500 DOM；resolution task 未結清，到期仍為 `2026-11-17T23:59:00+08:00`，未展期。ed2b、e3f、83d 的舊目錄與 approval 保留不變。

| capture | metric | ed2b 採用值 → main d711 參考 → ce70 實測 | 相對 main 參考 | evidencePath | metadataSha256 | resolutionTask | expiresAt |
|---|---|---:|---:|---|---|---|---|
| home-390 | `sameOriginTransferSizeBytes` | 471,593 → 474,410 → 483,035 | +8,625 | `home-390.json` | `7448f000107600f7ee6adf0b30079dea2467ea3a9b39525fe4f3d85979a6a93b` | `A-05-BUDGET-REVIEW:home-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| home-1440 | `sameOriginTransferSizeBytes` | 585,079 → 587,896 → 486,351 | -101,545 | `home-1440.json` | `387a5e881fde37a41bb4219a6599684b0356410e04b1e68bad017e5a21537219` | `A-05-BUDGET-REVIEW:home-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievements-390 | `domElementCount` | 6,432 → 29,629 → 29,630 | +1 | `achievements-390.json` | `7f70958b2f632a4d7d5b3383188e1645ccc1b2494a7dd4ab2e9bbc752bf6afa9` | `A-05-BUDGET-REVIEW:achievements-390:domElementCount` | 2026-11-17T23:59:00+08:00 |
| achievements-390 | `sameOriginTransferSizeBytes` | 1,001,196 → 2,493,725 → 2,498,892 | +5,167 | `achievements-390.json` | `7f70958b2f632a4d7d5b3383188e1645ccc1b2494a7dd4ab2e9bbc752bf6afa9` | `A-05-BUDGET-REVIEW:achievements-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievements-1440 | `domElementCount` | 6,432 → 29,629 → 29,630 | +1 | `achievements-1440.json` | `8473d437f3007b37d9484cb01675968bdb586d18dcfcc29c9c530e8133e74a87` | `A-05-BUDGET-REVIEW:achievements-1440:domElementCount` | 2026-11-17T23:59:00+08:00 |
| achievements-1440 | `sameOriginTransferSizeBytes` | 1,001,196 → 2,493,725 → 2,498,892 | +5,167 | `achievements-1440.json` | `8473d437f3007b37d9484cb01675968bdb586d18dcfcc29c9c530e8133e74a87` | `A-05-BUDGET-REVIEW:achievements-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-metro-green-line-390 | `sameOriginTransferSizeBytes` | 860,026 → 862,453 → 867,580 | +5,127 | `achievement-metro-green-line-390.json` | `fa00a9d57fb241a03cbc3b98de8324c35d848f96242aaaedf0f8a57688a2e0fa` | `A-05-BUDGET-REVIEW:achievement-metro-green-line-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-metro-green-line-1440 | `sameOriginTransferSizeBytes` | 860,026 → 862,453 → 867,580 | +5,127 | `achievement-metro-green-line-1440.json` | `679ce47438215d3b082f456dcb18903cf2db6cc52b4cff2944c8aa204b213dfc` | `A-05-BUDGET-REVIEW:achievement-metro-green-line-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-wende-school-center-390 | `sameOriginTransferSizeBytes` | 437,619 → 440,046 → 445,513 | +5,467 | `achievement-wende-school-center-390.json` | `d45a3b555ff41821a4e89295e35a4d296967ea4a9e16e2297177a50c531c411f` | `A-05-BUDGET-REVIEW:achievement-wende-school-center-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-wende-school-center-1440 | `sameOriginTransferSizeBytes` | 437,619 → 440,046 → 445,513 | +5,467 | `achievement-wende-school-center-1440.json` | `9dec4a6b294126fc65ff92460d9563e80cf537589de9d2b625249e8168f18c91` | `A-05-BUDGET-REVIEW:achievement-wende-school-center-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-special-education-support-390 | `sameOriginTransferSizeBytes` | 564,693 → 567,120 → 572,483 | +5,363 | `achievement-special-education-support-390.json` | `d4e3a7c571d949570c51f7b9877e723dc5fe6dcf353f17fc4619dda0cbbef979` | `A-05-BUDGET-REVIEW:achievement-special-education-support-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-special-education-support-1440 | `sameOriginTransferSizeBytes` | 564,693 → 567,120 → 572,483 | +5,363 | `achievement-special-education-support-1440.json` | `0b4056485a9815fc71de64a9b0be9e27bc2eb51e654980cf3798c2ff925921c3` | `A-05-BUDGET-REVIEW:achievement-special-education-support-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| news-390 | `sameOriginTransferSizeBytes` | 379,520 → 381,960 → 388,678 | +6,718 | `news-390.json` | `81198dfe0f920cef5ee98f9c98c95a4d44a9c88854c7a47c51cf4021b62d640c` | `A-05-BUDGET-REVIEW:news-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| news-1440 | `sameOriginTransferSizeBytes` | 379,520 → 588,742 → 388,678 | -200,064 | `news-1440.json` | `c33fa5a8a42a68abcce13a79cc6766160986acc02c01ea57e1df47637023d21a` | `A-05-BUDGET-REVIEW:news-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| news-special-education-nurse-390 | `sameOriginTransferSizeBytes` | 457,528 → 459,968 → 465,535 | +5,567 | `news-special-education-nurse-390.json` | `9d22b42b3a58a2ec80c78ccda9100bbb66db31e200bcb496f0839beb1a2e3e20` | `A-05-BUDGET-REVIEW:news-special-education-nurse-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| news-special-education-nurse-1440 | `sameOriginTransferSizeBytes` | 457,528 → 459,968 → 465,535 | +5,567 | `news-special-education-nurse-1440.json` | `7b1e030594a6fd3977472f406eaceda2736a918b99c6f112b95f7964d3d8f70a` | `A-05-BUDGET-REVIEW:news-special-education-nurse-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| activities-390 | `sameOriginTransferSizeBytes` | 348,956 → 351,784 → 357,543 | +5,759 | `activities-390.json` | `e9dd18520e794d50563a45355c2c1ea624ff0ad448e1a7f37bc4bdd09a9b90fa` | `A-05-BUDGET-REVIEW:activities-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| activities-1440 | `sameOriginTransferSizeBytes` | 348,956 → 351,784 → 357,543 | +5,759 | `activities-1440.json` | `cc243e845310ec805ba7e7fa3696b3fc1dcf4148d73bfdcd9cd4c55135e43eba` | `A-05-BUDGET-REVIEW:activities-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| event-campaign-headquarters-opening-390 | `sameOriginTransferSizeBytes` | 1,206,546 → 1,209,394 → 1,215,085 | +5,691 | `event-campaign-headquarters-opening-390.json` | `fcfec3ae25a3cbb1a33cd85a8a0735ca5cda181ca3740218341faecbfcd363b6` | `A-05-BUDGET-REVIEW:event-campaign-headquarters-opening-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| event-campaign-headquarters-opening-1440 | `sameOriginTransferSizeBytes` | 1,206,546 → 1,209,394 → 1,215,085 | +5,691 | `event-campaign-headquarters-opening-1440.json` | `2657768486f7bf6de8b175727887f06e92ebf0378b586758d20893b7b9067570` | `A-05-BUDGET-REVIEW:event-campaign-headquarters-opening-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| gallery-390 | `sameOriginTransferSizeBytes` | 1,349,601 → 1,352,028 → 1,357,831 | +5,803 | `gallery-390.json` | `3c241314ea3f07ffc19a154394a4471fac395f6ab0077f6893477bdd95be5b25` | `A-05-BUDGET-REVIEW:gallery-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| gallery-1440 | `sameOriginTransferSizeBytes` | 1,349,601 → 1,352,028 → 1,357,831 | +5,803 | `gallery-1440.json` | `ea739c606b58c5f223ccd87d6de2001849d690400dd5ac091f3693de32630189` | `A-05-BUDGET-REVIEW:gallery-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| service-390 | `sameOriginTransferSizeBytes` | 387,018 → 389,445 → 394,884 | +5,439 | `service-390.json` | `65db841f2f18d7eba9a05a091567fd6646f180060a4eca64e363fdf2252fb69c` | `A-05-BUDGET-REVIEW:service-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| service-1440 | `sameOriginTransferSizeBytes` | 387,018 → 389,445 → 394,884 | +5,439 | `service-1440.json` | `d58fe5669314162b450ca80aa0bb4664ea9f5f7514eff32b8bcee6499b900e35` | `A-05-BUDGET-REVIEW:service-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| petition-390 | `sameOriginTransferSizeBytes` | 342,666 → 345,093 → 350,504 | +5,411 | `petition-390.json` | `c5b43207cb5a2dcf1236b71c784a8a4f21e6c403ba86d1827a02bed879002316` | `A-05-BUDGET-REVIEW:petition-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| petition-1440 | `sameOriginTransferSizeBytes` | 342,666 → 345,093 → 350,504 | +5,411 | `petition-1440.json` | `45bc6b79f55e604fad3c27af925d88d1f608aabb14e30c16425ec1986c41b9ea` | `A-05-BUDGET-REVIEW:petition-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| election-390 | `domElementCount` | 4,835 → 4,925 → 4,926 | +1 | `election-390.json` | `6c22a21432ad2c5e270b9b93f561b3962e615e824cf34dbb97a09682c9095445` | `A-05-BUDGET-REVIEW:election-390:domElementCount` | 2026-11-17T23:59:00+08:00 |
| election-390 | `sameOriginTransferSizeBytes` | 916,668 → 934,950 → 940,285 | +5,335 | `election-390.json` | `6c22a21432ad2c5e270b9b93f561b3962e615e824cf34dbb97a09682c9095445` | `A-05-BUDGET-REVIEW:election-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| election-1440 | `domElementCount` | 4,835 → 4,925 → 4,926 | +1 | `election-1440.json` | `80af60fd32d49fc5ff515f8ae3ba46ccafd109263b3cece3357e1a939ef48131` | `A-05-BUDGET-REVIEW:election-1440:domElementCount` | 2026-11-17T23:59:00+08:00 |
| election-1440 | `sameOriginTransferSizeBytes` | 916,668 → 934,950 → 940,285 | +5,335 | `election-1440.json` | `80af60fd32d49fc5ff515f8ae3ba46ccafd109263b3cece3357e1a939ef48131` | `A-05-BUDGET-REVIEW:election-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| explore-390 | `sameOriginTransferSizeBytes` | 2,175,751 → 2,199,003 → 2,204,590 | +5,587 | `explore-390.json` | `67d281625baf3cd5666777e68ab693225a1f547259495806614000a0e0427f38` | `A-05-BUDGET-REVIEW:explore-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| explore-1440 | `sameOriginTransferSizeBytes` | 2,175,751 → 2,199,003 → 2,204,590 | +5,587 | `explore-1440.json` | `d5a2e9b11dd93f769d14ceb056aa8ee1f46d541c7cd0a27655fcac99ffd773b1` | `A-05-BUDGET-REVIEW:explore-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| not-found-390 | `sameOriginTransferSizeBytes` | 310,126 → 312,553 → 318,017 | +5,464 | `not-found-390.json` | `a0c6dd963ad4ee2147172e59f750d578303668845681339d6774cea0b75a9b54` | `A-05-BUDGET-REVIEW:not-found-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| not-found-1440 | `sameOriginTransferSizeBytes` | 310,126 → 312,553 → 318,017 | +5,464 | `not-found-1440.json` | `58a46f0534bdecae8f9e76de6731ba74aa2e8d0fa9d9a72c09f1c8817be61100` | `A-05-BUDGET-REVIEW:not-found-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |

## 2026-10-30 PR #235 完整初始狀態 snapshot 採用（目前 selection）

- 目前固定 selection 指向 `755de197d190e39fbf92fd8b25e6524505843438/manifest.json`。來源是 PR #235 的 A-05 run `40988418954`、artifact `12948831390` 的 `local-http-uncompressed` capture；source／capture-tool SHA 均為 `755de197d190e39fbf92fd8b25e6524505843438`，publication digest `24920c951daf4b617b85667a6457dd2d6b17c8e8cf4c70344ac6820168f24fae`。Git 新增其 30 張 PNG、30 份 metadata 及 manifest；PNG 與 metadata bytes 原樣保留，並逐檔核對 SHA-256。
- 原始 CAPTURE_ONLY manifest SHA-256 為 `cd7b0d188c3b061436a205374a36b29c453b1d6ba4b8412ee7a2ee5052eab01c`。採用時只更新 `status`（`APPROVED`）、`approval` 與 `exceptions`，capture、metrics、source/tool SHA、metadata hash、policy 及 artifact identity 都不變。核准後 manifest SHA-256 為 `978d32831b5e01e073ef9e783d31db4cd485b87b97b469568c52970bdb92abd8`；selection schema 1 只含原定四欄，selection.json SHA-256 為 `e265c588d36b1188c5d8a637d936649715465ecfe151310772a49d217f317f5c`。
- 審閱者記為「Codex 主控（AI代理，依網站管理者Hong1998tw本次官網改版與直接部署指示代為工程審閱）」，審閱時間 `2026-10-30T10:17:38+08:00`。29 張 PNG 與先前已逐張審閱的 ce70 PNG bytes 完全相同；`news-special-education-nurse-390` 另行目視確認正常。這是 AI 主控的工程與視覺審查，不代表人類或使用者本人簽核。
- 同一 run 以 ce70 selection 比較的結果為 `FAIL`（29 PASS、1 FAIL）。唯一失敗的 `home-390` 像素 PASS（changedPixels 0），metric 則因 `sameOriginTransferSizeBytes` 483,035 → 486,351、`domElementCount` 642 → 643 被判為 `NEW_REGRESSION`。差額 3,316 bytes 正是小 Q 晚載 stylesheet 含 header 的 PerformanceResourceTiming transferSize；ce70 的 `home-390` 是取樣過早的不完整數值，`home-1440` 與 755 則已計入。該 FAIL 紀錄保留；這次沒有修改 gate、門檻或原始 metrics，採用後的自我比較只驗證採用契約，不等於正式 CI PASS。
- 755 的 metadata 早於上述 readiness 修正，沒有 `initialUiReadiness`。採用依據是：以修正後的 capture 工具，在與 755 publication manifest bytes 相同的公開產物上兩次完整 capture，30 張的 DOM 與 transfer 都和 755 相同，quality 全部 COMPLETE、readiness 全部 READY（home 兩張各多等約 55ms），比較條件也相同。對照同一產物的舊取樣順序，`home-390` 會落在 642 或 637／483,035。
- 34 筆例外沿用 ce70 的同一組 capture × metric 鍵（30 筆 transfer、4 筆 DOM），0 筆新增超限、0 筆回到預算內，觀測值取本組實測。除 `home-390` transfer 外，其餘 33 筆與 ce70 相同；`home-390` 的 DOM 643 仍在 1,500 以內，不需要例外。限值仍為 300000 bytes／1500 DOM；resolution task 未結清，到期仍為 `2026-11-17T23:59:00+08:00`，未展期。ce70、ed2b、e3f、83d 的舊目錄與 approval 保留不變。

| capture | metric | ce70 採用值 → 755 實測 | 差值 | evidencePath | metadataSha256 | resolutionTask | expiresAt |
|---|---|---:|---:|---|---|---|---|
| home-390 | `sameOriginTransferSizeBytes` | 483,035 → 486,351 | +3,316 | `home-390.json` | `2c9e87c305a785fe3ec6290dc42a5d67682db3861f92b9d8813eac955e7153fe` | `A-05-BUDGET-REVIEW:home-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| home-1440 | `sameOriginTransferSizeBytes` | 486,351 → 486,351 | +0 | `home-1440.json` | `20fe04fadddd78ab7fee24536c62f9d932122ad6ec4999866f77b0d659b7aa9f` | `A-05-BUDGET-REVIEW:home-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievements-390 | `domElementCount` | 29,630 → 29,630 | +0 | `achievements-390.json` | `982f6d0f18ad270f763f72501dc51d19c8ab4012a7bdb7eb392e8f865f8a1362` | `A-05-BUDGET-REVIEW:achievements-390:domElementCount` | 2026-11-17T23:59:00+08:00 |
| achievements-390 | `sameOriginTransferSizeBytes` | 2,498,892 → 2,498,892 | +0 | `achievements-390.json` | `982f6d0f18ad270f763f72501dc51d19c8ab4012a7bdb7eb392e8f865f8a1362` | `A-05-BUDGET-REVIEW:achievements-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievements-1440 | `domElementCount` | 29,630 → 29,630 | +0 | `achievements-1440.json` | `2fc8ab01337685fcfccb47d0cf37cadb4c23756acc988451ec702f9287fa9b2b` | `A-05-BUDGET-REVIEW:achievements-1440:domElementCount` | 2026-11-17T23:59:00+08:00 |
| achievements-1440 | `sameOriginTransferSizeBytes` | 2,498,892 → 2,498,892 | +0 | `achievements-1440.json` | `2fc8ab01337685fcfccb47d0cf37cadb4c23756acc988451ec702f9287fa9b2b` | `A-05-BUDGET-REVIEW:achievements-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-metro-green-line-390 | `sameOriginTransferSizeBytes` | 867,580 → 867,580 | +0 | `achievement-metro-green-line-390.json` | `1295d3b542146cc0e87d0e4521690c2101d40a438be8226eaa95331c48349822` | `A-05-BUDGET-REVIEW:achievement-metro-green-line-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-metro-green-line-1440 | `sameOriginTransferSizeBytes` | 867,580 → 867,580 | +0 | `achievement-metro-green-line-1440.json` | `9623f6d72c6e23b9ba547bb9f1216fc36dfa69fd921ae2da00497607d503be81` | `A-05-BUDGET-REVIEW:achievement-metro-green-line-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-wende-school-center-390 | `sameOriginTransferSizeBytes` | 445,513 → 445,513 | +0 | `achievement-wende-school-center-390.json` | `4e3282d0b02f297d1435a469d4bab8ac27fd621debb7af1255c03c903e5904cc` | `A-05-BUDGET-REVIEW:achievement-wende-school-center-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-wende-school-center-1440 | `sameOriginTransferSizeBytes` | 445,513 → 445,513 | +0 | `achievement-wende-school-center-1440.json` | `926055cb3c7f86c718b26fff14a9fce218d996c77bf38ccec84fedd535ad00eb` | `A-05-BUDGET-REVIEW:achievement-wende-school-center-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-special-education-support-390 | `sameOriginTransferSizeBytes` | 572,483 → 572,483 | +0 | `achievement-special-education-support-390.json` | `16dd682a98de70069cd6948c1e78e7d71f200555da6c4a2732da8d8384066467` | `A-05-BUDGET-REVIEW:achievement-special-education-support-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| achievement-special-education-support-1440 | `sameOriginTransferSizeBytes` | 572,483 → 572,483 | +0 | `achievement-special-education-support-1440.json` | `1ccc63e2ad2b59079fe48891cdfaa406e25ec42f819bad96fa16a1607ad2c826` | `A-05-BUDGET-REVIEW:achievement-special-education-support-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| news-390 | `sameOriginTransferSizeBytes` | 388,678 → 388,678 | +0 | `news-390.json` | `a7f16e64bb582f0accb7d880b6408415bd4203f297392370f2dd57aabf6a91b3` | `A-05-BUDGET-REVIEW:news-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| news-1440 | `sameOriginTransferSizeBytes` | 388,678 → 388,678 | +0 | `news-1440.json` | `47b910fb505b6d433217d908aa3ec632a79dad550f66e7756145240302655c45` | `A-05-BUDGET-REVIEW:news-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| news-special-education-nurse-390 | `sameOriginTransferSizeBytes` | 465,535 → 465,535 | +0 | `news-special-education-nurse-390.json` | `f68732e5fdd919159af21d9c8182c2e8e7cca5b6797314140851428249f375b0` | `A-05-BUDGET-REVIEW:news-special-education-nurse-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| news-special-education-nurse-1440 | `sameOriginTransferSizeBytes` | 465,535 → 465,535 | +0 | `news-special-education-nurse-1440.json` | `da8df3aaa59d969fa56e42e8a19e7de4ad20e64d77dc2d1bb8be90da817f0835` | `A-05-BUDGET-REVIEW:news-special-education-nurse-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| activities-390 | `sameOriginTransferSizeBytes` | 357,543 → 357,543 | +0 | `activities-390.json` | `9a93a31c9fa2ea08453ac80b8c38bb3ab8c503b9374f2dfb4adccdc9801b30e9` | `A-05-BUDGET-REVIEW:activities-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| activities-1440 | `sameOriginTransferSizeBytes` | 357,543 → 357,543 | +0 | `activities-1440.json` | `f649a0be8836210db2d4057960998b8fecbf237866bb54e928a14532772cf0d6` | `A-05-BUDGET-REVIEW:activities-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| event-campaign-headquarters-opening-390 | `sameOriginTransferSizeBytes` | 1,215,085 → 1,215,085 | +0 | `event-campaign-headquarters-opening-390.json` | `5c6eaf6fb31920bc74b8dd63096c74a96ec9f1ac182478e37c332e93aa28f3d2` | `A-05-BUDGET-REVIEW:event-campaign-headquarters-opening-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| event-campaign-headquarters-opening-1440 | `sameOriginTransferSizeBytes` | 1,215,085 → 1,215,085 | +0 | `event-campaign-headquarters-opening-1440.json` | `1552e188fdb9abe64ea43d2e4d82266cbabb81246693019839c0e8daef21d820` | `A-05-BUDGET-REVIEW:event-campaign-headquarters-opening-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| gallery-390 | `sameOriginTransferSizeBytes` | 1,357,831 → 1,357,831 | +0 | `gallery-390.json` | `773acf0f52b60b9b3157050cce0d52c35070bab122c1fd03b45788aa1ec07add` | `A-05-BUDGET-REVIEW:gallery-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| gallery-1440 | `sameOriginTransferSizeBytes` | 1,357,831 → 1,357,831 | +0 | `gallery-1440.json` | `0dc3bab7cfc1f21b5cf2866aabd22bc153f9a6f2fd7c86690e00940fc60c2105` | `A-05-BUDGET-REVIEW:gallery-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| service-390 | `sameOriginTransferSizeBytes` | 394,884 → 394,884 | +0 | `service-390.json` | `ffcfdb8276cb15d10fba90207fb448e9d45e9ce03bb1469067f42173cdb11e98` | `A-05-BUDGET-REVIEW:service-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| service-1440 | `sameOriginTransferSizeBytes` | 394,884 → 394,884 | +0 | `service-1440.json` | `1b1262130457ef98d1b7d86e67b6146b7ec7ec40ecb0b4e8f59eb7adae41003a` | `A-05-BUDGET-REVIEW:service-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| petition-390 | `sameOriginTransferSizeBytes` | 350,504 → 350,504 | +0 | `petition-390.json` | `d81e2a091e405d79416bd0a9700a7598c0c90725f0ed6b2f2e6d8050f8434408` | `A-05-BUDGET-REVIEW:petition-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| petition-1440 | `sameOriginTransferSizeBytes` | 350,504 → 350,504 | +0 | `petition-1440.json` | `6852c2ef5dd7f3a3a74e1a92a7f00b3ee15af5d73172a3c63f4737668fd93a85` | `A-05-BUDGET-REVIEW:petition-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| election-390 | `domElementCount` | 4,926 → 4,926 | +0 | `election-390.json` | `b177d03dc641464cb8fbbfa7032da9211cad67cea2d82b7ab2103eb669f218d1` | `A-05-BUDGET-REVIEW:election-390:domElementCount` | 2026-11-17T23:59:00+08:00 |
| election-390 | `sameOriginTransferSizeBytes` | 940,285 → 940,285 | +0 | `election-390.json` | `b177d03dc641464cb8fbbfa7032da9211cad67cea2d82b7ab2103eb669f218d1` | `A-05-BUDGET-REVIEW:election-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| election-1440 | `domElementCount` | 4,926 → 4,926 | +0 | `election-1440.json` | `d03cdd46861e125c34b8ed424f8264c9fb64323cd8e0c4b13e370772e082b617` | `A-05-BUDGET-REVIEW:election-1440:domElementCount` | 2026-11-17T23:59:00+08:00 |
| election-1440 | `sameOriginTransferSizeBytes` | 940,285 → 940,285 | +0 | `election-1440.json` | `d03cdd46861e125c34b8ed424f8264c9fb64323cd8e0c4b13e370772e082b617` | `A-05-BUDGET-REVIEW:election-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| explore-390 | `sameOriginTransferSizeBytes` | 2,204,590 → 2,204,590 | +0 | `explore-390.json` | `7de74fb8e169163a3e9c3f2cbfe39fb0bea119550b7404cef962f9eef61978c1` | `A-05-BUDGET-REVIEW:explore-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| explore-1440 | `sameOriginTransferSizeBytes` | 2,204,590 → 2,204,590 | +0 | `explore-1440.json` | `68af1318941ec0db22f9441a879b8533c9c67e449983c172dacd23576fe52072` | `A-05-BUDGET-REVIEW:explore-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| not-found-390 | `sameOriginTransferSizeBytes` | 318,017 → 318,017 | +0 | `not-found-390.json` | `b6f8eb7b4dca762bf4e0eda2ead9555b177acd138838a790f998eea1e9e6e11a` | `A-05-BUDGET-REVIEW:not-found-390:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
| not-found-1440 | `sameOriginTransferSizeBytes` | 318,017 → 318,017 | +0 | `not-found-1440.json` | `31d452cd5d6033e255a2f0fe6a5640823472df5954bb5e5cf5f55bb9ff61c353` | `A-05-BUDGET-REVIEW:not-found-1440:sameOriginTransferSizeBytes` | 2026-11-17T23:59:00+08:00 |
