# Canonical Source 與權威來源

本文件定義「陳慧文官網」的長期維護權威來源，避免 GitHub、Google Drive、Notion、ChatGPT 專案與舊版檔案彼此漂移。

## 1. 唯一程式碼 Canonical Source

- Repository：`Hong1998tw/chen-huiwen-website`
- Canonical branch：`main`
- Production：GitHub Pages，`https://hong1998tw.github.io/chen-huiwen-website/`
- `main` 中的 source、結構化資料、build script、template 與版本歷史，是網站程式碼的唯一權威來源。

Production URL 代表「目前實際對外看到的狀態」，但不應反向覆蓋 GitHub source。

## 2. 系統角色分工

| 系統 | 權威範圍 | 不應扮演的角色 |
| --- | --- | --- |
| GitHub `main` | source code、資料、build、template、版本歷史 | 不保存私人案件或內部研究 |
| GitHub Pages | 對外 production runtime | 不作為人工編輯來源 |
| Google Drive | candidate、release artifact、備份、維護文件 | 不建立第二套可編輯 source code |
| Notion | 治理、規格、Decision Log、操作紀錄、來源說明 | 不覆蓋 GitHub 最新 source |
| ChatGPT Project | 工作調度與上下文 | 不作 Runtime State 的權威來源 |

## 3. 現行 Source Architecture

- `data/achievements.json`：政績結構化資料主來源。
- `scripts/build_cases.py`：從已審閱公開資料產生政績地圖與獨立詳情頁。
- `templates/case-page.html`：政績詳情頁共用模板。
- `assets/`：公開靜態素材、鳳山里界與 vendor assets。
- `styles.css`、`site.js`、`map.css`、`map.js`：前台樣式與互動。
- `achievement-*.html`、`achievements.html`：build output／部署成果；相關資料變更時優先修改 source，再重新 build。

`content.json` 為既有公告快照，不是政績產生器的資料來源。

## 4. Drive 單檔 Candidate 的定位

2026-09-08 Google Drive 中另有約 2.7 MB 的單一 `index.html` candidate。該檔案是候選部署 artifact，不是本 repository 的 canonical source。

該 candidate 目前仍含 `YOUR_GITHUB_USERNAME`／`YOUR_REPOSITORY_NAME` canonical URL placeholder，因此不可直接視為 production 成品。

若未來要採用其中的 UI、資料或功能，流程必須是：

1. 先比對目前 `main`。
2. 將需要的變更拆回可維護 source／data／template／CSS／JS。
3. 執行 build 與測試。
4. 經 diff review 後進入 `main`。
5. 由 GitHub Pages 發布。

不得以 Drive candidate 直接覆蓋 repository source。

## 5. 衝突判定

發現不同系統內容不一致時，依下列順序判定：

1. GitHub `main` 的最新 commit：程式碼與資料版本。
2. Production URL：實際線上狀態。
3. 官方／第一手公開來源：可變動事實內容。
4. Notion 最新治理／規格文件：流程與決策。
5. Drive candidate／release：候選與歷史 artifact。
6. 舊聊天、Memory、AI 摘要：僅供背景參考。

無法確認時標示未知，不得猜測。

## 6. 更新主流程

`需求／官方來源 → branch → 修改 source → build → test → diff review → main → GitHub Pages → Drive release archive → Notion 紀錄`

最後更新：2026-09-08（Asia/Taipei）。
