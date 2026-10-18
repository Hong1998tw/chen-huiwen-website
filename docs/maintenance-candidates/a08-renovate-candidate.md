# A08 Renovate 依賴更新候選

## 狀態與自動探索範圍

本頁與 [`renovate.json.example`](renovate.json.example) 是供審閱的候選內容。候選檔放在 `docs/maintenance-candidates/`，且使用 `.json.example` 副檔名，不是 repository root 的 Renovate 設定檔名，因此不會被當作預設設定自動載入。參考 Renovate 官方的 [設定檔名稱](https://docs.renovatebot.com/configuration-options/#configfilenames) 說明。

Renovate 官方自架設定中的 `autodiscover` 預設為 `false`；若營運者日後明確啟用 repository discovery，掃描範圍受執行端憑證可見的 repository 範圍限制，並可用 `autodiscoverFilter` 收窄。這是執行端的 repository 探索設定，與本候選檔是否被載入分開；詳見官方 [`autodiscover` 設定](https://docs.renovatebot.com/self-hosted-configuration/#autodiscover)。

本次僅在候選設定中保留更新時窗，未安裝或啟用 bot、未新增 GitHub 權限，亦未啟用外部排程、通知或 auto-merge。先前設定端點回應 401，無法據此判斷帳號是否已安裝 Renovate；本次未檢查帳號設定，安裝狀態維持未知。

## 候選管理範圍

- `github-actions`：管理 workflow 中的 GitHub Actions 依賴；候選沿用 `helpers:pinGitHubActionDigests`。部分 `uses:` 行缺少對應的版本註解時，SHA 本身不能證明人讀版本標籤；本候選不補註解或推定版本。
- `npm`：範圍對應 [`admin/package.json`](../../admin/package.json) 與 [`admin/package-lock.json`](../../admin/package-lock.json)，以及 [`tests/donation/package.json`](../../tests/donation/package.json) 與 [`tests/donation/package-lock.json`](../../tests/donation/package-lock.json) 這兩組 manifest／lockfile。
- `pyenv`：範圍對應 repository root 的 [`.python-version`](../../.python-version)。GitHub Actions 內的 Python 版本固定值不是由這個 manager 同步。
- workflow 命令列中的 inline `pip install` 未納入此候選；沒有把它們宣稱為受管理依賴，也未新增 requirements／pyproject 檔案。

候選排程是台灣時間週一 04:00–07:59 的更新時窗。`patch` 與 GitHub Actions `digest` 更新會分組；`automerge` 明確維持 `false`，`dependencyDashboard` 維持 `false`。本候選不會自動合併任何更新，patch／digest auto-merge 尚未啟用。

## 未來啟用門檻

若要正式啟用，須另行審閱並明確確認 bot 安裝及 repository 權限、資料接收者與實際作用，再把候選設定移至受支援的 root 設定檔名。若另要啟用 auto-merge，還須確認合併權限、保護規則、適用更新範圍與回復方式，並以獨立變更設定；本候選不授權或執行這些操作。
