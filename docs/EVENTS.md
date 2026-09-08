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

執行：`python3 scripts/build_events.py`。
驗證：`python3 -m unittest discover -s tests/events`、`python3 scripts/validate_site.py`。

Google 日曆按鈕以公開活動資料產生預填連結，台灣時間顯示、UTC 傳遞起訖時間。訪客開啟後仍需確認儲存，加入日曆不代表報名成功。網站不存取訪客日曆、不收集報名個資。

目前 events 陣列為空，公開頁只顯示新活動將於本頁發布。不將測試資料寫入公開 JSON 或 HTML。

活動公告沿用 activities.html URL。舊花絮與 gallery 的頂層導覽已移除；歷史 URL 暫保留相容，沒有新增曝光入口。
