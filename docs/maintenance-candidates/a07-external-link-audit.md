# A07 外部連結可達性報告候選

## 狀態與範圍

`scripts/audit_external_links.py` 維持唯讀工具。本次保留 URL 正規化、fingerprint、重試分類、報告狀態與原始 source 的唯讀 `--inventory-only` 相容模式；真實 HTTP probe 必須使用通過驗證的公開 artifact，不能直接盤點 repository source。這次沒有啟用排程、建立 Issue 或通知，也沒有執行即時外連探測。

## 報告行為

- URL 移除 fragment、正規化 scheme／host／預設 port，保留 query 的順序和值；相同正規化 URL 共用 SHA-256 fingerprint，來源檔合併列出。
- 含帳密資訊的 URL 會略過，不送出請求或寫入報告。
- `--inventory-only` 可繼續唯讀原始 source 的 HTML／JSON，列出 `NOT_RUN`，不連外。
- HTTP probe 必須明確提供 `--public-artifact PATH --source-sha SHA`。工具會先比對目前 checkout SHA、Cloudflare `deployment.json` 的來源與 publication-manifest digest、完整 manifest 路徑閉包、每檔 SHA-256，以及部署 wrapper；缺少或不一致時在第一個 probe 前拒絕。未提供合法公開 artifact 時，一般模式會明確失敗。
- probe 只從 publication manifest 列出的公開 HTML／JSON（包含巢狀 HTML）擷取外連。路徑集合沿用 `build_public.public_paths()`，僅容許其明確產物及建置產生的 CMS 索引；不掃描 repository 的 `data/*.json`。`data/achievements.json` 只有在位元組與公開投影 `data/achievements-public.json` 完全相同且符合公開 schema 時才接受；`data/case-context.json`、source raw 檔及其他未發布檔案不會成為 probe 來源。
- 一般模式依序送出 GET，只讀取回應標頭，不讀 response body、不提交表單、不下載地圖 tile、不登入或繞過限制。`PASS` 只代表 HTTP 可達，不代表內容正確。
- 2xx／3xx 為 `PASS`；404／410 為 `FAIL`；認證、拒絕存取、限流、TLS、網路、逾時、伺服器及其他非預期結果為 `BLOCKED`。
- 最多兩次嘗試，預設間隔 0.5 秒且不得低於 0.25 秒；單次 timeout 必須大於 0 且不超過 30 秒。408、5xx、逾時與暫時網路錯誤可在上限內重試；認證、拒絕存取、404／410、限流及 TLS 錯誤不重試。
- 報告先標示 `running`，完成後標示 `complete`；中斷時保留的部分報告不會被誤認為完整結果。

手動準備並執行即時檢查時，可使用下列命令，並將報告存放於 repository 外。前兩步建置公開 artifact 並附上來源收據，不會部署；最後一步才會對該 artifact 的公開連結送出 GET：

```bash
python3 scripts/build_public.py --output /tmp/huiwen-public-artifact
python3 scripts/build_cloudflare_public.py --wrap-existing-artifact /tmp/huiwen-public-artifact \
  --source-commit "$(git rev-parse HEAD)"
python3 scripts/audit_external_links.py /path/outside/repository/external-links.json \
  --public-artifact /tmp/huiwen-public-artifact --source-sha "$(git rev-parse HEAD)" \
  --timeout 8 --attempts 2 --interval 0.5
```

候選 workflow 直接執行一次 `build_public.py`；接著 `build_cloudflare_public.py --wrap-existing-artifact` 只附上既有 schema 的 `deployment.json`、`_headers`、`_redirects`，不重跑 package。這兩步都不執行 `build_all.py`、`quality.py` 或部署。

## 每週報告候選

可審查的 workflow 範本位於 [`a07-weekly-link-report.yml.example`](a07-weekly-link-report.yml.example)。它保留在文件目錄，不會被 GitHub Actions 載入；目前沒有啟用這項每週工作。範本只保留 `workflow_dispatch` 與排程入口，不建立 Issue、不通知或指派負責人。

排程 cron 為 `30 20 * * 0`（UTC），換算為台灣時間每週一 04:30。候選工作使用 `contents: read`、現有 pinned Actions、Python 3.12，固定安裝 Beautiful Soup 4.13.5、html5lib 1.1、FontTools 4.66.1、Brotli 1.2.0、zopfli 0.4.3 與 PyYAML 6.0.3。它將唯一一次必要的公開 artifact package 輸出至 `RUNNER_TEMP`，沿用 production publication manifest 與 deployment receipt，不執行 `build_all.py` 或 `quality.py`。每次 GET timeout 為 8 秒、最多兩次嘗試、間隔 0.5 秒；GNU `timeout` 在 900 秒終止並於 10 秒後強制結束，整個 job 上限為 25 分鐘，包含依賴安裝、package 與報告。

URL 完整耗時上限約為每筆 17 秒（兩次各 8 秒、重試間隔 0.5 秒、兩筆間隔 0.5 秒）；總筆數超出 900 秒時允許留下 partial。工具逐筆持久寫入 `running` report，timeout 或其他執行失敗會保留非零步驟結果；摘要重新驗證來源 SHA、publication manifest digest、artifact inventory 與每筆來源。只有每個公開 URL 都有結果且 summary 一致時才能標示 `complete`。沒有 HTTP 結果的筆數不算 `PASS`。JSON 與 markdown 摘要都嘗試保存 30 天；artifact 只是報告保存，不代表連結全數 `PASS`。若 artifact 或報告不存在／格式錯誤，摘要驗證會失敗，不會用零值替代缺失資料。

報告 JSON 只保留公開 artifact 中的 canonical URL（包括 query）、公開來源路徑、HTTP 狀態／redirect 目標與重試紀錄；啟用後 runner 只會對這些已發布 URL 發送有界 GET，不讀取 response body。它不會把 source raw 或 private JSON 作為探測輸入，也不會上傳公開網站 artifact 本身。

只有另行明確決定啟用後，才將範本複製至 `.github/workflows/a07-weekly-link-report.yml`，執行契約測試並審查差異。回復時移除該啟用檔；不必移除本候選範本或既有手動工具。

本次驗證僅使用純 fixtures／mock 與本機公開 packager；沒有對外送出連結 HTTP 請求。範本仍在 `docs/maintenance-candidates/`，不會作為已啟用 cron 回報。若要啟用排程或新增通知，須另有明確啟用變更。回復本次程式及文件變更可使用 reviewed revert，唯讀 inventory-only 模式仍可照原方式使用。

## 驗證

離線行為由 [`tests/test_external_link_audit.py`](../../tests/test_external_link_audit.py) 覆蓋；工具位置為 [`scripts/audit_external_links.py`](../../scripts/audit_external_links.py)。
