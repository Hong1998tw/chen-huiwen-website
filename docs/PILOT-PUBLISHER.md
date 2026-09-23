# huiwen.tw Notion Pilot 發布執行器（PR-only）

本文件是 GitHub 端的工程 runbook；施工契約、狀態與 Decision Log 以私有 Notion「現行施工計畫（Pilot）」為準。
本 repo 不保存任何 secret 實值、私人 Notion／Drive 網址或人員識別資料。

## 1. 範圍與安全契約

| 項目 | 規則 |
| --- | --- |
| Domain | 只處理活動（`data/events.json`）與律師時間表（`data/legal-schedule.json`）。政績維持既有 Notion 政績資料庫＋SKILL-218，執行器不寫入政績。 |
| 發布正本 | GitHub `main`。Notion 只是 authoring state。 |
| 執行器 | `scripts/publish_from_notion.py`；workflow `.github/workflows/publish-executor.yml`。 |
| Merge | **執行器沒有 merge 路徑**，並拒絕 merge／auto-merge endpoint（`MERGE_FORBIDDEN`）。Pilot 由 GitHub human review／human merge 把關。 |
| Auto-merge | 2026-11-29（Asia/Taipei）以前禁止；之後仍需 shadow acceptance、MVP gates、WP0.7 身分綁定、Gate 修訂與權責人另一次明確裁定，不自動啟用。 |
| Schema | 只寫入已知 `schemaVersion`（兩者皆為 2）；未知版本 `UNKNOWN_SCHEMA` fail closed。資料檔若不是 serializer 會產生的格式則 `FORMAT_DRIFT` fail closed。 |
| 未管理欄位 | 依 stable `id` 逐筆 patch；Notion 未管理但 builder 合法的欄位（例如 `location`、`registrationUrl`）原樣保留。 |
| 版本綁定 | dry-run 產生白話預覽與 `candidate_content_digest`；建立 PR 前 fresh-read Notion＋`main` 重算，不一致即拒絕並要求重新核准。 |
| 身分綁定 | WP0.7 未通過前，Notion 勾選者不構成 Publisher 身分證據；Pilot 的 Production authorization 是 GitHub human review。 |
| 發布保護 preflight | 建 PR 前讀 `GET /rules/branches/main`；未 enforce PR＋必要檢查＋人工核准＋禁止 force push／刪除時 `GATE_NOT_ENFORCED`，不建立 PR。 |
| 路徑 allowlist | 執行器與 CI（`publication-path-guard`，從 base revision 執行）都限制 PR 只能改該 domain 的資料檔與產出檔。 |
| Log | 不輸出內容本文、私人網址或 secret；PR 內文只含 domain、record、digest、base SHA 與時間。 |

## 2. 流程

```
Notion 編輯 → 勾選「要求預覽」→ dry-run（fresh-read、schema、Git base hash、candidate digest、
白話預覽、worktree build＋quality、allowlist；不 push、不開 PR、不產生 artifact）→ 回寫 Notion
→ 人看白話預覽 → 勾選「要求發布」→ gate preflight → fresh-read＋digest 重算＋base drift 檢查
→ worktree build＋quality → branch `notion-publish/<domain>/<record>-<digest8>` → PR（不 merge）
→ CI（validate／browser／secrets／publication-path-guard）→ GitHub human review → human merge
→ Pages → 分層驗證（verify）→ 回寫 receipt
```

執行模式：`dry-run`、`publish`、`verify`、`cycle`（排程：依序三者）、`gate-check`、`export-rows`（main → rows，供首次匯入）、`shadow-compare`（rows → 與 main 逐 byte 比對）。

## 3. Notion 欄位契約

活動 DB：活動名稱（title）、開始、結束（含時刻）、活動說明、報名方式、來源網址（https）、來源核對日、狀態（排定／改期／取消）、異動說明、來源更新日、下次複查。

律師時間表：月表 DB（月份 `YYYY-MM`、來源圖卡網址、圖卡標題、核對日、下次核對）＋時段 DB（日期、開始 `HH:MM`、結束 `HH:MM`、relation「月份」）。`validThrough` 由執行器依月份計算；`availability` 固定為須電話確認。網站目前格式每天只能有一個時段。

系統欄位（兩個 DB 共用名稱）：要求預覽、要求發布、執行狀態、網站 ID、GitHub 基準雜湊、候選內容雜湊、上次同步雜湊、白話預覽、發布結果、PR 連結、驗證層級、最後執行。候選內容雜湊只涵蓋受管欄位＋Git base，執行器回寫系統欄位不會改變它。

## 4. 分層 Production Verification

`verify` 分別回報 `pr_created`、`ci_passed`、`review_approved`、`merged`、`deployed`、`http_verified`、`snapshot_verified`、`native_verified`。只有全部 PASS 才是「已完成」；任何 BLOCKED 最多是「已部署待驗證」。Production revision 以 Pages deployment run 的 head SHA＋`github-pages` artifact digest 表示，不使用 `main` HEAD。

## 5. 需要 owner／Secret owner 執行的步驟（BLOCKED_EXTERNAL_ACTION）

以下需 repository admin 或 Secret owner 權限，執行器與本 PR 都沒有、也不應有這些權限。

1. **WP0.1 rulesets**：依 `docs/pilot/main-rulesets.json` 匯入兩個 ruleset（Settings → Rules → Rulesets → Import）。`main-publication-gate`：PR 必要、四個必要檢查、禁止 force push 與刪除，**bypass 為空**。`main-human-review`：至少 1 位核准、新推送使舊核准失效、最後推送需他人核准，**bypass 為空**。
   - 單人維護注意：作者不能核准自己的 PR。若短期內只有一位維護者，另一個人工選項是只在 `main-human-review` 加入「Repository admin／bypass mode：pull request」，GitHub App 仍不得在任何 bypass 名單；此時 admin 自行合併的 PR 會在分層驗證中顯示 `review_approved=PENDING`，不會被標為已完成。建議指定第二位 reviewer 後移除該 bypass。
   - 驗證：`python scripts/publish_from_notion.py gate-check`（需可讀 rules 的 token）回報 `ENFORCED`；以測試 branch 嘗試 direct push `main` 應被拒；無核准的 PR 無法合併；在 ruleset 詳細頁確認 bypass 名單不含 App。
2. **WP0.6 設定**：開啟「Automatically delete head branches」；確認「Allow auto-merge」為關閉。
3. **WP0.2 GitHub App**：只安裝在本 repo；權限 Contents RW、Pull requests RW、Actions R、Checks R、Metadata R；**不給 Workflows、Administration**；關閉 webhook。
4. **Environment `notion-publisher`**：Deployment branches 只允許 `main`；secrets：`HUIWEN_PUBLISH_APP_ID`、`HUIWEN_PUBLISH_APP_KEY`、`NOTION_PUBLISH_TOKEN`（只記 key name；實值依 Proton Pass 治理規則保存）。
5. **Repository variables**：`NOTION_EVENTS_DS`、`NOTION_LEGAL_MONTH_DS`、`NOTION_LEGAL_SESSION_DS`（Notion data source ID，私有 locator 記在 Notion 發布中心）、`PUBLISHER_APP_LOGIN`（例如 `<app-slug>[bot]`）、`PUBLISHER_GIT_NAME`／`PUBLISHER_GIT_EMAIL`；最後才設定 `NOTION_PUBLISHER_ENABLED=true`。
6. **Notion integration**：只分享活動 DB、律師月表 DB、時段 DB（不分享政績資料庫）。
7. 驗證 WP0.2：從非 `main` branch 手動觸發 workflow，job 應被 `if` 與 environment branch policy 擋下，取不到 secret。

## 6. Rollback／Recovery

- 內容錯誤：開 revert PR（或以 `export-rows` 前的 Notion 值重新核准一版還原內容）→ CI → human review → merge → Pages → 分層驗證。
- 執行器異常：把 `NOTION_PUBLISHER_ENABLED` 改為非 `true`（排程立即變成 no-op），改回既有工程 PR 流程；不需修改內容。
- Credential 疑似外洩：由 owner 撤銷 App installation／Notion integration、輪替 secret，檢查期間內的 PR 與 commit。
- Notion 或 GitHub 故障：正式站不受影響；恢復後排程自動重試（有退避與上限），不會重複建立 PR（branch 名稱綁 digest，先對帳再建立）。

## 7. WP0.6 Branch 清理政策

- 2026-09-23 盤點：遠端 95 個 branch；65 個已是 `main` 的祖先（可列為清理候選）；29 個不是祖先（多數可能為 squash merge，需逐一比對 tree 後再決定）。
- 規則：刪除任何 branch 前先列清單並取得 owner 明確授權；`backup/*` 不在一般清理範圍；執行器 branch（`notion-publish/*`）在 PR 合併後由「自動刪除 head branch」處理，未合併者保留以便稽核。
