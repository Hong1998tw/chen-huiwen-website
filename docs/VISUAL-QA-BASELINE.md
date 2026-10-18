# A-05 視覺基準的 Git 採用流程

## CI 選擇契約

A-05 compare job 只讀固定的 Git 路徑：`tests/baselines/visual-qa/selection.json`。

- selection 不存在：輸出 `PENDING` 並成功結束；這代表沒有執行基準比較，不能解讀為視覺通過。
- selection 存在：必須同時通過來源完整 SHA、manifest 完整 SHA-256、核准紀錄、30 組 PNG/JSON 相鄰檔案及其內容 hash 驗證。缺檔、格式錯誤、來源不符、越界路徑或 hash 不符均為 `REJECTED`，CI 失敗，不退回 `PENDING`。
- Git selection 是 workflow 唯一的 approved-baseline 來源。現有 14 天 capture artifact 仍供取證與人工檢視；workflow 不從 artifact 或 `VISUAL_QA_BASELINE_*` repo variables 選基準，也不需修改這些 variables。
- selection 已存在但無效時不會退回任何其他來源。比較仍要求候選與基準環境及量測條件相容，並保留既有像素、transfer、DOM、deployment receipt、HTTP、gzip 與 1440×900 desktop 規則；A-05 job 維持 25 分鐘。

## PR 的獨立 main 參照

PR 的 A-05 job 以 shallow checkout 起跑，只 fetch 並驗證事件提供的單一 40 位 base commit，接著建立 detached worktree。capture runner、Node、Playwright 與 policy 仍從目前 PR checkout 載入；`--site-root` 只指定要服務及量測的網站檔案。參照輸出放在 `tests/donation/results/visual-qa/main-reference/local-http-uncompressed/`，候選輸出與 live Cloudflare 量測保留在原路徑。兩組 local capture 都成功後，`cross-compare` 會產生 `cross-source-review/cross-source-review.json` 與 30 張逐 capture 像素差異圖；報告列出 source/tool SHA、量測 delta、預算狀態及像素差異，固定標為 `CROSS_SOURCE_REVIEW`，不套用 exception、不宣稱 PASS，也不修改 golden selection。main／非 PR 執行會明確記錄沒有獨立 PR base。

每筆 A-05 metadata、manifest 與 receipt 都分別記錄 `sourceSHA`／`siteSourceSHA` 和 `captureToolSHA`／`checkoutSHA`。前者由 site-root 的 Git `HEAD` 取得，後者由 runner 所在 checkout 的 Git `HEAD` 取得；兩者不接受命令列 SHA 覆寫，且兩個 checkout 都必須乾淨。獨立 site-root 的 capture output 不可與來源 checkout 重疊。approved baseline 的 `selection.json` 綁定網站來源 SHA；manifest、每筆 capture 與 metadata 另核對 capture-tool SHA，允許這兩種身分不同。這組 main capture 是跨來源參照與逐圖審閱材料，**不會自動選為 golden**；沒有核准的固定 `selection.json` 時，A-05 comparison 仍為 `PENDING`。

每筆已核准的 per-capture × metric 預算例外必須有有效的帶時區 `expiresAt`，日期必須真實有效，且不可晚於 `approval.reviewedAt` 起 30 日。比較在 `now >= expiresAt` 時 fail closed；原 300,000 bytes／1,500 DOM、觀測值需等於 baseline、metadata SHA、resolution task、不得新增退步及已解債務需清除等條件照常適用。沒有核准任何本輪例外。

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

## 人工檢視後採用並提交

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

完成全部人工審核後，填入真實審核者、時間與判斷說明，將 manifest 由 `CAPTURE_ONLY` 明確改為 `APPROVED`：

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

提交後的 PR workflow 會在相同固定路徑讀取該基準。此次採用流程只適用於人工審核完成的 capture；目前沒有 selection，也沒有已核准 golden。

## CI 狀態判讀

| CI 狀態 | 意義 |
|---|---|
| `PENDING` | 固定 selection 尚未提交；只有 capture evidence，沒有視覺比較或 pass。 |
| `PASS` | 已核准 Git 基準與本次 30 張候選完成像素和 transfer/DOM 比較，均通過既有門檻。 |
| `FAIL`／`STALE_BASELINE`／`INCOMPARABLE` | 比較已執行，但發現回歸、舊例外或不可比條件；CI 依既有 gate 失敗。 |
| `REJECTED` | selection、來源、manifest hash、approved 狀態或 PNG/JSON 檔案檢查失敗；CI fail-closed。 |
| `NOT_RUN` | capture 本身失敗，因此沒有執行比較。 |
