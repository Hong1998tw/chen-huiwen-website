# A-05 視覺基準的 Git 採用流程

## CI 選擇契約

A-05 compare job 只讀固定的 Git 路徑：`tests/baselines/visual-qa/selection.json`。

- selection 不存在：輸出 `PENDING` 並成功結束；這代表沒有執行基準比較，不能解讀為視覺通過。
- selection 存在：必須同時通過來源完整 SHA、manifest 完整 SHA-256、核准紀錄、30 組 PNG/JSON 相鄰檔案及其內容 hash 驗證。缺檔、格式錯誤、來源不符、越界路徑或 hash 不符均為 `REJECTED`，CI 失敗，不退回 `PENDING`。
- Git selection 是 workflow 唯一的 approved-baseline 來源。現有 14 天 capture artifact 仍供取證與審閱；workflow 不從 artifact 或 `VISUAL_QA_BASELINE_*` repo variables 選基準，也不需修改這些 variables。
- selection 已存在但無效時不會退回任何其他來源。比較仍要求候選與基準環境及量測條件相容，並保留既有像素、transfer、DOM、deployment receipt、HTTP、gzip 與 1440×900 desktop 規則；A-05 job 維持 25 分鐘。

## PR 的獨立 main 參照

PR 的 A-05 job 以 shallow checkout 起跑，只 fetch 並驗證事件提供的單一 40 位 base commit，接著建立 detached worktree。Node、Playwright、runner 與 policy 從目前 PR checkout 載入；Python 3.12 先以同一組固定依賴分別執行 base worktree 自己的 `scripts/build_cloudflare_public.py` 和 candidate checkout 自己的 publisher，兩份輸出放在 `RUNNER_TEMP` 的獨立目錄。base 必須先在可寫狀態完成自身 publication build，再由 capture runner 套用既有 read-only mode、post-mode 與 tracked-byte guard。local screenshot capture 使用 `--site-root GIT_ROOT --public-artifact BUILT_PUBLIC_ROOT`：Git root 提供來源 SHA，HTTP server 只服務已建好的公開 artifact。candidate 也以相同方式服務它自己的 publication artifact；production measurement 仍讀 Cloudflare live deployment receipt。

publication gate 以來源 checkout 的真實 Git HEAD 核對 `deployment.json.sourceCommit`，核對 deployment digest 與原始 `publication-manifest.json` bytes、payload file count、每個 payload SHA-256、payload bytes、四個 delivery wrapper、完全相符的檔案／目錄集合、路徑安全、symlink／hardlink 與 secret-like 值。現行 source-native publication manifest 只宣告 payload 路徑與 SHA-256，沒有宣告 payload byte size；A-05 對每個檔案讀取後計算實際 bytes，並將逐檔與總 bytes inventory 做前後一致性驗證，不把實測值冒稱來源宣告值。manifest 與 capture metadata 記錄 `siteSourceKind`、`sourceGitSHA`、`servedRootRole`、raw manifest SHA、`publicArtifactDigest` 與完整 payload identity；artifact 和 source 都在 capture 前及 finally 後再驗。完整性失敗時，所有已寫入的 partial capture metadata 會失效，並移除可能已寫出的 verified summary。source-native publisher 先依各自版本的 contract 成功完成；A-05 gate 只驗證兩版本共通的來源與 bytes 關係，不以 candidate 版本的 header/font 規則重驗舊 base artifact。

參照輸出放在 `tests/donation/results/visual-qa/main-reference/local-http-uncompressed/`，候選輸出與 live Cloudflare 量測保留在原路徑。兩組 local capture 都成功後，`cross-compare` 會產生 `cross-source-review/cross-source-review.json` 與 30 張逐 capture 像素差異圖；報告列出 source/tool SHA、publication digest、量測 delta、預算狀態及像素差異，固定標為 `CROSS_SOURCE_REVIEW`，保留 `pass: null` 與 `approval: null`，不套用 exception、不宣稱 PASS，也不修改 golden selection。Git canonical-root capture 和 publication-artifact capture 不能互相比較。main／非 PR 執行會明確記錄沒有獨立 PR base，且不會把 candidate 當成自己的 base。

每筆 A-05 metadata、manifest 與 receipt 都分別記錄 `sourceSHA`／`siteSourceSHA`、`sourceGitSHA`、`siteSourceKind`、`servedRootRole` 和 `captureToolSHA`／`checkoutSHA`。Git root 與 tool SHA 都從各自 checkout 的真實 HEAD 取得，不接受命令列 SHA 覆寫，且兩個 checkout 都必須乾淨。publication artifact 必須與 source/tool Git root 及 capture output 分離。approved baseline 的 `selection.json` 綁定網站來源 SHA；manifest、每筆 capture 與 metadata 另核對 capture-tool SHA，允許這兩種身分不同，並拒絕 canonical-root 與 publication-artifact 混合比較。這組 main capture 是跨來源參照與逐圖審閱材料，**不會自動選為 golden**；沒有核准的固定 `selection.json` 時，A-05 comparison 仍為 `PENDING`。 原 83d0e2210079d607d29d5b01c0571feb56929184 是 2026-10-19 初始歷史基準；主控另明確核准以新 native snapshot e3f63ff40a8d1d52a361a52e8f8c635754a3cfe3 作為目前 Git baseline。ca61 cross-source review 仍是 CROSS_SOURCE_REVIEW、pass=null，沒有被解讀成 PASS。

每筆已核准的 per-capture × metric 預算例外必須有有效的帶時區 `expiresAt`，日期必須真實有效，且不可晚於 `approval.reviewedAt` 起 30 日。比較在 `now >= expiresAt` 時 fail closed；原 300,000 bytes／1,500 DOM、觀測值需等於 baseline、metadata SHA、resolution task、不得新增退步及已解債務需清除等條件照常適用。本次採用核准 34 筆有期限的既存預算例外；逐筆差異、資源證據、追蹤任務與到期時間見本文件末段。

## 同網域傳輸量的量測定義（2026-10-23 起）

`sameOriginTransferSizeBytes` 只計算擷取畫面需要的同網域流量：導覽文件加上同網域資源的 `PerformanceResourceTiming.transferSize`，但不計入量測當下完全位於視窗外、標記 `loading="lazy"` 的圖片。

- 原因：Chrome 對視窗外延遲載入圖片是否預先下載並不固定。2026-10-22 在 `news.html` 實測，同一頁同一視窗連續載入 16 次，有 10 次下載 `news-20260907-mazu-port-bridge.jpg`（206,686 B），6 次沒有；該圖始終在視窗底部 1,550 px 以外。A-05 因此對沒有變更的頁面回報 NEW_REGRESSION。
- 被排除的圖片與位元組記在每筆 metadata 的 `metrics.sameOriginOffscreenLazyImagesExcluded`，原始總量仍保留在 `sameOriginPerformanceTransferSizeBytes`。
- 讀取數值前，工具等待同網域請求全部結束並持續 500 ms 無新請求（上限 10 秒），結果記在 `conditions.networkSettled`；逾時的擷取標為 `NETWORK_NOT_SETTLED`，不進入比較。
- `sameOriginTransferSizeSource` 因此改為 `…; off-viewport lazy images excluded`。依比較契約，舊定義量測的基準與新擷取不可比較（`TRANSFER_MEASUREMENT_SOURCE_MISMATCH`），必須由主控依下方流程審閱並採用新定義量測的基準。
- 已驗證：同一 artifact 連續擷取三次，30 張截圖的傳輸量與 DOM 數完全一致。與 `ed2bdb57` 基準相比，新聞頁維持 379,520 B；捷運青線、特教支持、競選總部開幕活動、相簿與首頁等 9 張數值下降，因為原本每次都會預先下載的視窗外圖片不再計入預算。

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


## 2026-10-19 新版 snapshot 採用（目前 selection）

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
