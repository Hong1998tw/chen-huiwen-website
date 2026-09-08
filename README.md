# 陳慧文議員官方網站

網站：https://hong1998tw.github.io/chen-huiwen-website/

以 HTML、CSS、原生 JavaScript 製作的靜態網站，使用 GitHub Pages 發布。無需 API 金鑰、Notion 登入或伺服器即可瀏覽。

## Canonical Source

本 repository 的 `main` 分支是官網程式碼、結構化資料、build script、template 與版本歷史的唯一 canonical source。Production URL 代表實際對外狀態；Google Drive 僅保存 candidate／release artifact／備份，Notion 保存治理與操作紀錄，不建立第二套可編輯 source。

維護前先讀：

- [`docs/CANONICAL-SOURCE.md`](docs/CANONICAL-SOURCE.md)：權威來源、系統角色與衝突判定。
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)：發布、部署與回滾流程。
- [`docs/TEST-CHECKLIST.md`](docs/TEST-CHECKLIST.md)：發布前最低測試基準。
- [`docs/CONTENT-SOURCES.md`](docs/CONTENT-SOURCES.md)：公開內容來源、事實狀態與資料邊界。

## 網站內容

- `index.html`：首頁與近期公告摘要
- `about.html`：學經歷、社群及議會資訊
- `news.html`：近期動態詳細內容
- `service.html`：服務處聯絡資料及公益律師諮詢
- `styles.css`、`site.js`：響應式版型、手機導覽
- `assets/`：肖像及網站圖示
- `content.json`：本次公告資料快照，供後續維護參考。網站內容已預先寫入 HTML；單獨修改此檔不會自動更新頁面。

## 維護與發布

GitHub Pages 從 `main` 分支根目錄發布。一般更新應從最新 `main` 建立工作 branch；修改完成後先 build、測試與檢查 diff，再經 review 進入 `main`。重大版面、資料或流程變更優先使用 Pull Request，不以 Google Drive candidate 直接覆寫 production。

可用 `python3 -m http.server 8000` 在本機預覽。各頁採相對連結，可在 GitHub Pages 專案子路徑運作。

政績資料更新以 `data/achievements.json` 為 source，執行 `python3 scripts/build_cases.py` 產生 `achievements.html` 與各 `achievement-*.html`。CI 會重新 build 並檢查產生檔是否與 source 同步。

## 內容與素材來源

網站文字依服務處 Notion 的公開官網內容、關於慧文、公益律師諮詢及公告資料整理。只移入對外的專業介紹、服務資訊與公告摘要，未移入內部研究、選務策略或民眾個案。

議會介紹及照片：https://www.kcc.gov.tw/MemberInfo_New.aspx?msn=2215&n=39&sms=9028

肖像原圖：https://ws.kcc.gov.tw/001/Upload/member/2215/22a6e534-48f2-456f-a5fb-822d226b3078.png

肖像及相關內容的權利仍歸原權利人所有，本儲存庫不另行授予其素材授權。

未設定自訂網域，原有 huiwen.tw 網站及 DNS 不受此專案影響。

## 每月公益律師時間表

首頁連結至站內服務頁，服務頁嵌入 Canva 公開檢視版時間表。時間表由服務處在 Canva 維護，網站不複製容易過期的月份與時段。

2026-09-08：完成第二版視覺設計，採墨綠、萊姆綠、浮動導覽與編輯式大字版型。

## 2026-09-08 內容擴充

新增政績紀錄（achievements.html）、政見與願景（vision.html）、活動花絮（activities.html）、相片集（gallery.html）與服務案件表單入口（petition.html）。新聞頁加入具名媒體原文連結。政績頁提供關鍵字篩選；照片可放大，無 JavaScript 時仍可開啟原圖。

案件表單沿用服務處現有 Notion 公開表單：https://lihong-tw.notion.site/1ffbd1468054800b9940fbfde5fee74d 。本網站不收集或儲存案件內容。已確認填寫頁可開啟，未送出測試案件。

法律諮詢網頁：https://www.canva.com/design/DAFtNuTWpPI/yUqaUJ0UAD4Kda0_gcL6rw/view
每月時間表：https://canva.link/ty6cqsy53ypef5l

新增照片取自服務處既有公開網站的五福市場職人展、錦田路綠帶會勘、文聖街道路刨鋪與2024年「議起做月餅」頁面，已另存靜態圖片，避免暫時網址到期。圖片權利歸原權利人所有。活動依原資料標明歷年回顧與結束狀態；推動中的案件未標為完工。政見頁整理歷年主題，非新增競選承諾。

## 政績地圖與站內歷程（2026-09-08）

`achievements.html` 提供 75 里、關鍵字、5 種主題、6 種進度篩選，41 個專題均有獨立 HTML 頁面；27 個專題有代表點位，28 個有里別分類，共 77 筆歷程。未取得完成證據者保留爭取、追蹤或歷年紀錄狀態。地圖底圖為 OpenStreetMap，Leaflet 1.9.4 已存於 assets/vendor 並附授權。

里界採內政部國土測繪中心「村(里)界(TWD97經緯度)」2026-08-17 版本，來源 https://data.gov.tw/dataset/7438 ，依政府資料開放授權條款第1版使用。裁切為鳳山區75里並保留原始多邊形，座標保留6位小數。代表點位不是工程範圍，原始里名與座標矛盾時以文字註記並暫停不可靠點位。

更新流程：

1. 編輯經人工審閱的 `data/achievements.json`，保留固定 `id`、資料來源、階段、日期精度及缺漏說明。
2. 執行 `python3 scripts/build_cases.py`，生成政績地圖與41個詳情頁。共用詳情版型在 `templates/case-page.html`。
3. 預覽、檢查來源與連結後提交工作 branch，經測試／review 後再進入 `main`。新增/移除專題時一併更新 sitemap.xml；移除需處理舊網址。

Notion 自動同步尚未建置；瀏覽政績不需要連線 Notion。未把原始工作資料、內部協調文件或私人研究附件加入公開 JSON。`content.json` 為舊公告快照，不是政績產生器資料來源。

首頁及新聞頁嵌入 Facebook 官方粉絲專頁；服務頁嵌入 Canva 律師時間表，均保留另開原頁連結。這兩項第三方嵌入可能因瀏覽器隱私設定或供應商限制而無法顯示。LINE 官方帳號使用 https://line.me/R/ti/p/@yve2766q 。

活動頁的市場展覽與月餅活動已有站內回顧頁；綠帶會勘導向站內政績專題。現有服務案件仍透過正式公開表單收件，未建立原生案件後端或送出測試個資。
