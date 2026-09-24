# huiwen.tw Notion CMS 發布執行器

本文件是 GitHub 端工程 runbook。GitHub `main` 是網站程式與發布正本；Notion 是各內容 domain 的 authoring surface。

## 1. 使用者操作

日常後台只保留兩個動作：

1. **發布**：內容有變更時直接勾選「發布」。
2. **重新部署正式站**：內容不變，只想把 current `main` 重新 build / deploy。

「要求預覽」與「白話預覽」保留為 legacy/internal 欄位，不再是日常流程，也不是發布前置條件。

## 2. 發布流程

```
Notion 編輯
→ 勾「發布」
→ fresh-read Notion + current main
→ schema / validation / candidate digest
→ throwaway worktree build + full quality + path allowlist
→ 第二次 fresh-read（防止建置期間內容被改）
→ branch notion-publish/<domain>/<record>-<digest8>
→ GitHub App 建 PR
→ GitHub native auto-merge enabled
→ required checks: validate / browser / secrets / publication-path-guard
→ 全綠後 GitHub 自動 squash merge
→ Pages deploy
→ HTTP / snapshot / native 分層驗證
→ 回寫 Notion
```

任何一個 required check 失敗，GitHub 不得 merge。

Publisher 程式仍拒絕 direct merge endpoint；唯一允許的是對合法 `notion-publish/* → main` PR 啟用 GitHub native auto-merge。

## 3. 發布授權語意

Notion 的「發布」現在是 **Production authorization signal**。

因此：

> 能編輯並勾選「發布」的人，就具備該內容 domain 的正式發布權。

資料庫只應授權可信任的 Editor / Publisher 使用。

發布按下後，系統會綁定第一次 fresh-read 的 candidate digest；build / quality 結束前會再 fresh-read 一次。若受管欄位或網站基準已變更，本次發布 fail closed，狀態改為「需重新發布」，不 push、不建 PR。

## 4. GitHub identity / merge safety

Publisher 使用專用 GitHub App，只安裝在本 repository。

App 權限：
- Contents: write
- Pull requests: write
- Actions: read
- Checks: read
- Metadata: read

禁止：
- Administration
- Workflows
- ruleset bypass
- direct merge endpoint

Repository：
- `main-publication-gate` 必須 active
- PR required
- required checks：`validate` / `browser` / `secrets` / `publication-path-guard`
- force push / deletion 禁止
- bypass actors 空白
- `allow_auto_merge=true`
- `main-human-review` 保留 disabled standby；未來若改回雙人治理可再啟用

## 5. Domain ownership

### 活動
Authoring：活動 Pilot DB
Canonical published source：`data/events.json`

### 律師時間表
Authoring：月表 + 時段 DB
Canonical published source：`data/legal-schedule.json`

### 政績
**不搬資料。**

仍以既有 Notion 政績資料庫為唯一 authoring authority，之後若接入同一 Publisher，新增 `achievements` domain adapter，而不是複製 rows 到活動／律師 DB。

## 6. 重新部署正式站

Publishing Center 內有「官網發布控制｜正式站」一列。

勾選「重新部署正式站」：

```
current main
→ dispatch pages.yml@main
→ full quality
→ build public artifact
→ GitHub Pages deploy
→ 狀態回寫
```

這條流程：
- 不修改 source
- 不建立假 commit
- 不建立內容 PR
- 不變更 Notion 內容資料

狀態：
- 待命
- 重新部署中
- 重新部署完成
- 重新部署失敗

## 7. Runtime configuration

Environment：`notion-publisher`，只允許 `main`。

Secrets：
- `NOTION_PUBLISH_TOKEN`
- `HUIWEN_PUBLISH_APP_ID`
- `HUIWEN_PUBLISH_APP_KEY`

Repository variables：
- `NOTION_EVENTS_DS`
- `NOTION_LEGAL_MONTH_DS`
- `NOTION_LEGAL_SESSION_DS`
- `NOTION_DEPLOY_CONTROL_DS`
- `PUBLISHER_GIT_NAME`
- `PUBLISHER_GIT_EMAIL`
- `PUBLISHER_APP_LOGIN`
- `PUBLISHER_SINGLE_MAINTAINER=true`
- `PUBLISHER_AUTO_PUBLISH=true`
- `NOTION_PUBLISHER_ENABLED=true`

Notion connection `huiwen-publisher` 只分享：
- 活動 DB
- 律師月表 DB
- 律師時段 DB
- 官網發布控制｜正式站

政績 DB 在 achievements adapter 實作前不要分享給此 Publisher。

## 8. Verification

`verify` 分層回報：
- pr_created
- ci_passed
- review_approved（UI 語意為「發布授權」）
- merged
- deployed
- http_verified
- snapshot_verified
- native_verified

Auto-publish 模式下，發布授權只對 Publisher App 建立的 `notion-publish/*` PR 算 PASS。

`BLOCKED != PASS`。Native edge 若因 Cloudflare 403 為 BLOCKED，必須原樣保留。

## 9. Rollback

Publisher 異常時：
1. 設 `NOTION_PUBLISHER_ENABLED=false`。
2. 已建立但未 merge 的 PR 可直接關閉。
3. 已 merge 的內容以正常 revert PR 回滾。
4. 不關閉 `main-publication-gate`。
5. 不用搬移或還原政績資料庫。

Pre-auto-publish rollback baseline 已封存在 Notion Archive；變更前 `main` 為 `4ad71945245be22163827d2ef8abb654924f2196`。
