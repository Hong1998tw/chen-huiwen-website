# A07 外部連結可達性報告候選

## 狀態與範圍

既有 `scripts/audit_external_links.py` 維持手動唯讀工具。本次改善 URL 正規化、fingerprint、重試分類、報告狀態與離線測試；沒有新增排程、Issue 建立或通知功能，也沒有執行即時外連探測。文件與程式變更不代表已啟用自動執行。

## 報告行為

- URL 移除 fragment、正規化 scheme／host／預設 port，保留 query 的順序和值；相同正規化 URL 共用 SHA-256 fingerprint，來源檔合併列出。
- 含帳密資訊的 URL 會略過，不送出請求或寫入報告。
- `--inventory-only` 只讀本機 HTML／JSON，列出 `NOT_RUN`，不連外。
- 一般模式依序送出 GET，只讀取回應標頭，不讀 response body、不提交表單、不下載地圖 tile、不登入或繞過限制。`PASS` 只代表 HTTP 可達，不代表內容正確。
- 2xx／3xx 為 `PASS`；404／410 為 `FAIL`；認證、拒絕存取、限流、TLS、網路、逾時、伺服器及其他非預期結果為 `BLOCKED`。
- 最多兩次嘗試，預設間隔 0.5 秒且不得低於 0.25 秒；單次 timeout 必須大於 0 且不超過 30 秒。408、5xx、逾時與暫時網路錯誤可在上限內重試；認證、拒絕存取、404／410、限流及 TLS 錯誤不重試。
- 報告先標示 `running`，完成後標示 `complete`；中斷時保留的部分報告不會被誤認為完整結果。

手動執行即時檢查時，可使用下列命令，並將報告存放於 repository 外：

```bash
python3 scripts/audit_external_links.py /path/outside/repository/external-links.json --attempts 2 --interval 0.5
```

## 每週報告候選

可審查的 workflow 範本位於 [`a07-weekly-link-report.yml.example`](a07-weekly-link-report.yml.example)。它保留在文件目錄，不會被 GitHub Actions 載入；目前沒有啟用這項每週工作。範本只提供 `workflow_dispatch` 與排程入口，不建立 Issue、不通知或指派負責人。

排程 cron 為 `30 20 * * 0`（UTC），換算為台灣時間每週一 04:30。候選工作使用 `contents: read`、現有 pinned Actions、Python 3.12，只安裝報告與契約測試所需套件；沒有執行全站建置。它以單一序列 GET 執行既有唯讀工具，每次 timeout 1 秒、最多兩次嘗試、間隔 0.5 秒，GNU `timeout` 在 900 秒終止並於 10 秒後強制結束，job timeout 為 20 分鐘。

目前離線盤點為 254 個 URL。依工具的重試與 URL 間隔計算，最壞等待約 762 秒；候選契約測試會隨來源盤點數成長重新檢查此預算。超時或其他執行失敗會保留非零步驟結果；若 JSON 已存在，摘要會標示 `running`、完整盤點總數與已寫入筆數，artifact 仍會嘗試保存 30 天。artifact 只是報告保存，不代表連結全數 `PASS`。若報告不存在或格式錯誤，摘要驗證會失敗，不會用零值替代缺失資料。

報告 JSON 保留完整 canonical URL（包括 query）、來源檔名、HTTP 狀態／redirect 目標與重試紀錄；目前離線盤點中有 1 個 URL 的 query 欄位名為 `sessioncode`，沒有將其值輸出到此文件。啟用後，runner 會對這些 URL 發送有界 GET，不讀取 response body；JSON 會存放在 GitHub Actions artifact 30 天。

只有另行明確決定啟用後，才將範本複製至 `.github/workflows/a07-weekly-link-report.yml`，執行契約測試並審查差異。回復時移除該啟用檔；不必移除本候選範本或既有手動工具。

本次驗證僅使用離線測試與 `--inventory-only`；沒有對外送出 HTTP 請求。若要建立排程或通知，須另有明確啟用變更；目前沒有排程、Issue 或通知已啟用。回復本次程式及文件變更可使用 reviewed revert，既有手動工具仍可照原方式執行。

## 驗證

離線行為由 [`tests/test_external_link_audit.py`](../../tests/test_external_link_audit.py) 覆蓋；工具位置為 [`scripts/audit_external_links.py`](../../scripts/audit_external_links.py)。
