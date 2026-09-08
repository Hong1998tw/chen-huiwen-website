# 陳慧文議員官方網站

網站：https://hong1998tw.github.io/chen-huiwen-website/

以 HTML、CSS、原生 JavaScript 製作的靜態網站，使用 GitHub Pages 發布。無需 API 金鑰、Notion 登入或伺服器即可瀏覽。

## 網站內容

- `index.html`：首頁與近期公告摘要
- `about.html`：學經歷、社群及議會資訊
- `news.html`：近期動態詳細內容
- `service.html`：服務處聯絡資料及公益律師諮詢
- `styles.css`、`site.js`：響應式版型、手機導覽
- `assets/`：肖像及網站圖示
- `content.json`：本次公告資料快照，供後續維護參考。網站內容已預先寫入 HTML；單獨修改此檔不會自動更新頁面。

## 維護與發布

GitHub Pages 設定為從 `main` 分支根目錄發布。修改 HTML/CSS/JS 後提交，即會重新部署。本文資料為2026年9月8日人工整理的快照，未建立 Notion 自動同步。

可用 `python3 -m http.server 8000` 在本機預覽。各頁採相對連結，可在 GitHub Pages 專案子路徑運作。

## 內容與素材來源

網站文字依服務處 Notion 的公開官網內容、關於慧文、公益律師諮詢及公告資料整理。只移入對外的專業介紹、服務資訊與公告摘要，未移入內部研究、選務策略或民眾個案。

議會介紹及照片：https://www.kcc.gov.tw/MemberInfo_New.aspx?msn=2215&n=39&sms=9028

肖像原圖：https://ws.kcc.gov.tw/001/Upload/member/2215/22a6e534-48f2-456f-a5fb-822d226b3078.png

肖像及相關內容的權利仍歸原權利人所有，本儲存庫不另行授予其素材授權。

未設定自訂網域，原有 huiwen.tw 網站及 DNS 不受此專案影響。

## 每月公益律師時間表

首頁及服務資訊頁面連結至 https://canva.link/ty6cqsy53ypef5l 。時間表由服務處在 Canva 維護，網站不複製容易過期的月份與時段。

2026-09-08：完成第二版視覺設計，採墨綠、萊姆綠、浮動導覽與編輯式大字版型。

## 2026-09-08 內容擴充

新增政績紀錄（achievements.html）、政見與願景（vision.html）、活動花絮（activities.html）、相片集（gallery.html）與服務案件表單入口（petition.html）。新聞頁加入具名媒體原文連結。政績頁提供關鍵字篩選；照片可放大，無 JavaScript 時仍可開啟原圖。

案件表單沿用服務處現有 Notion 公開表單：https://lihong-tw.notion.site/1ffbd1468054800b9940fbfde5fee74d 。本網站不收集或儲存案件內容。已確認填寫頁可開啟，未送出測試案件。

法律諮詢網頁：https://www.canva.com/design/DAFtNuTWpPI/yUqaUJ0UAD4Kda0_gcL6rw/view
每月時間表：https://canva.link/ty6cqsy53ypef5l

新增照片取自服務處既有公開網站的五福市場職人展、錦田路綠帶會勘、文聖街道路刨鋪與2024年「議起做月餅」頁面，已另存靜態圖片，避免暫時網址到期。圖片權利歸原權利人所有。活動依原資料標明歷年回顧與結束狀態；推動中的案件未標為完工。政見頁整理歷年主題，非新增競選承諾。
