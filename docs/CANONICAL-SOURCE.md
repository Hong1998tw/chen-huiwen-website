# Canonical Source 與權威來源

本文件定義「陳慧文官網」的長期維護權威來源，避免 GitHub、Google Drive、Notion、ChatGPT 專案與舊版檔案彼此漂移。

## 1. 唯一程式碼 Canonical Source

- Repository：`Hong1998tw/chen-huiwen-website`
- Canonical branch：`main`
- Production origin：GitHub Pages
- Production canonical URL：`https://www.huiwen.tw/`
- Cloudflare：DNS／Proxy／Redirect edge，不是網站 source。
- `main` 中的 source、結構化資料、build script、template、assets、generated output 與 Git history，是網站程式碼的唯一權威來源。

Production URL 代表「目前實際對外看到的狀態」，但不應反向覆蓋 GitHub source。若 Production 與 `main` 不一致，先查 GitHub Pages deployment、Cloudflare edge、cache、asset path 與對應 commit。

## 2. 系統角色分工

| 系統 | 權威範圍 | 不應扮演的角色 |
| --- | --- | --- |
| GitHub `main` | source code、資料、build、template、assets、generated output、版本歷史 | 不保存私人案件或內部研究 |
| GitHub Pages | production origin／deployment runtime | 不作為人工編輯來源 |
| Cloudflare | DNS、Proxy、TLS、Redirect edge | 不成為網站 source code |
| Google Drive | candidate、release artifact、備份、維護文件 | 不建立第二套可編輯 source code |
| Notion | 治理、規格、Decision Log、操作紀錄、來源說明、Editorial Policy | 不覆蓋 GitHub 最新 source |
| ChatGPT Project | 工作調度與上下文 | 不作 Runtime State 的權威來源 |

## 3. 現行 Source Architecture

- `data/achievements.json`：政績結構化資料主來源。
- `data/platforms.json`：歷屆政見結構化資料主來源。
- `data/events.json`：活動資料來源（依現行 build 實作使用）。
- `scripts/build_cases.py`：從已審閱公開資料產生政績地圖與獨立詳情頁。
- `scripts/build_platforms.py`：產生歷屆政見頁。
- `scripts/build_events.py`：產生活動相關 output。
- `templates/case-page.html`：政績詳情頁共用模板。
- `assets/`：公開靜態素材、鳳山里界與 vendor assets。
- `styles.css`、`site.js`、`map.css`、`map.js`：前台樣式與互動。
- `achievement-*.html`、`achievements.html` 等 generated pages：build output／部署成果；相關資料變更時優先修改 source，再重新 build。
- `news.html`：現行新聞正式 source；新聞量或維護成本達既有 migration trigger 前，不另建第二套新聞 Runtime State。

`content.json` 為既有公告快照，不是政績產生器的資料來源。

## 4. Drive 單檔 Candidate 的定位

2026-09-08 Google Drive 中另有約 2.7 MB 的單一 `index.html` candidate。該檔案是候選部署 artifact，不是本 repository 的 canonical source。

該 candidate 為歷史候選成果，不得因更新時間較新而取代 GitHub `main`。若未來要採用其中的 UI、資料或功能，流程必須是：

1. 先比對目前 `main`。
2. 將需要的變更拆回可維護 source／data／template／CSS／JS。
3. 執行 build 與測試。
4. 經 diff review、PR、CI 後進入 `main`。
5. 由 GitHub Pages 發布並驗證 `https://www.huiwen.tw/`。

不得以 Drive candidate 直接覆蓋 repository source。

## 5. 衝突判定

發現不同系統內容不一致時，依資料原生責任判定：

1. GitHub `main` 最新 commit：網站程式碼、資料、generated output 與版本。
2. `https://www.huiwen.tw/`：實際對外 Runtime State。
3. 官方／第一手公開來源：政績、政策、日期、金額、工程等可變動公開事實。
4. 原始媒體報導：新聞原文標題、日期、URL、報導內容與圖片 credit。
5. Notion 最新有效治理／規格／Decision：流程、發布授權、Editorial Policy、人工裁決規則。
6. Drive candidate／release：候選與歷史 artifact。
7. 舊聊天、Memory、AI 摘要：僅供背景參考。

無法確認時標示未知，不得猜測。

## 6. 更新與發布主流程

`需求／官方或原始來源 → 最新 main → branch → 修改 source → 必要 build → test → diff review → PR → CI → merge main → GitHub Pages → Production Verification`

發布授權與重大變更 Gate 依 Notion 最新有效治理與 `docs/DEPLOYMENT.md` 的 operational contract 執行：一般小型／中型變更在測試與 CI 通過後預設完成部署；重大變更才停在正式發布前等待明確核准。

最後更新：2026-09-10（Asia/Taipei）。
