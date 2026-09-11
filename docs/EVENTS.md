# 活動公告維護

Canonical source：`data/events.json`；模板：`templates/events-page.html`。
產生頁：`activities.html`。不直接手改產生頁。

每筆活動放在 `events` 陣列，欄位如下：

| 欄位 | 必填 | 內容 |
| --- | --- | --- |
| id | 是 | 唯一小寫英數 slug，以連字號分隔 |
| name | 是 | 正式活動名稱 |
| start / end | 是 | 含時區的 ISO 8601 起訖時間；台灣使用 +08:00 |
| content | 是 | 活動公開內容，純文字；可換行 |
| registration | 是 | 正式報名方式、期限或免報名說明；不得猜測 |
| registrationUrl | 否 | 已確認可公開的 HTTPS 報名入口 |
| location | 否 | 已確認地點；若未提供，不顯示 |
| sourceUrl | 否 | 第一手／官方公開來源 URL；議會議程優先使用高雄市議會官方來源 |
| verifiedAt | 否 | 最後查核日期，格式 `YYYY-MM-DD` |

## 議會議程自動納入規則

**市政總質詢／議會議程應自動列為官網活動公告。**

只要高雄市議會官方日程表、質詢順序或其他正式公開議程已明確確認陳慧文參與，且日期／時間可公開，就應新增或更新 `data/events.json`，再執行 build 產生 `activities.html`；不得因未另行建立服務處活動而省略。

- 市政總質詢：以高雄市議會官方「議員市政總質詢／質詢順序」為優先來源；名單、日期或時間異動時，更新原事件，不重複建立。
- 其他議會議程：須有官方來源明確確認陳慧文參與，才列為個人活動公告；只有全體議會日程、但無法確認個人參與時，不得自行推定。
- 未公布精確時間、議程仍待確認或來源互相衝突時，先標示待確認並停止公開寫入，不得猜測時段。
- 每筆議會活動應保留 `sourceUrl` 與 `verifiedAt`，公開文字並註明「議程如有調整，以高雄市議會官方最新公告為準」。

本規則是官網 canonical source 的強制納入規則；網站前端不直接抓取或改寫高雄市議會資料。任何自動同步器／排程若日後建立，也必須先核驗官方來源後寫入 `data/events.json`，再經 build、test、PR／CI 流程發布。

執行：`python3 scripts/build_events.py`。
驗證：`python3 -m unittest discover -s tests/events`、`python3 scripts/validate_site.py`。

Google 日曆按鈕以公開活動資料產生預填連結，台灣時間顯示、UTC 傳遞起訖時間。訪客開啟後仍需確認儲存，加入日曆不代表報名成功。網站不存取訪客日曆、不收集報名個資。

活動公告沿用 activities.html URL。舊花絮與 gallery 的頂層導覽已移除；歷史 URL 暫保留相容，沒有新增曝光入口。
