# A-05 視覺基準的 Git 採用流程

## CI 選擇契約

A-05 compare job 只讀固定的 Git 路徑：`tests/baselines/visual-qa/selection.json`。

- selection 不存在：輸出 `PENDING` 並成功結束；這代表沒有執行基準比較，不能解讀為視覺通過。
- selection 存在：必須同時通過來源完整 SHA、manifest 完整 SHA-256、核准紀錄、30 組 PNG/JSON 相鄰檔案及其內容 hash 驗證。缺檔、格式錯誤、來源不符、越界路徑或 hash 不符均為 `REJECTED`，CI 失敗，不退回 `PENDING`。
- Git selection 是 workflow 唯一的 approved-baseline 來源。現有 14 天 capture artifact 仍供取證與人工檢視；workflow 不從 artifact 或 `VISUAL_QA_BASELINE_*` repo variables 選基準，也不需修改這些 variables。
- selection 已存在但無效時不會退回任何其他來源。比較仍要求候選與基準環境及量測條件相容，並保留既有像素、transfer、DOM、deployment receipt、HTTP、gzip 與 1440×900 desktop 規則；A-05 job 維持 25 分鐘。

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
SOURCE_SHA="$(jq -er '.checkoutSHA | select(test("^[a-f0-9]{40}$"))' "$SOURCE_DIR/manifest.json")"
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
if manifest.get('checkoutSHA') != source_sha or manifest.get('sourceSHA') != source_sha:
    raise SystemExit('Manifest source SHA does not match the selected directory')
captures = manifest.get('captures')
if not isinstance(captures, list) or len(captures) != 30:
    raise SystemExit('Expected exactly 30 captures')
capture_ids = [capture.get('id') for capture in captures]
if any(not isinstance(capture_id, str) for capture_id in capture_ids) or len(set(capture_ids)) != 30:
    raise SystemExit('Capture IDs must be unique')
for capture in captures:
    capture_id = capture.get('id', '')
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
