# SEO Migration Stage 2｜高價值內容完整性稽核

查核日期：2026-09-09（Asia/Taipei）

## Gate 2 原則

任何舊高價值頁都不能因 migration 變成較舊、較短、較不完整的內容。Stage 2 先完成內容等價／升級；舊 URL 的 redirect、canonical migration 與 404/410 判定留到 Stage 3。

| 舊站高價值內容 | Stage 2 決策 | 新站承接 | 狀態 |
| --- | --- | --- | --- |
| 特教復康巴士／校園照護 | 轉政績並更新最新執行情形 | `data/achievements.json` → `achievement-special-education-support.html` | 已補官方2026執行情形 |
| 八德滯洪池 | 保留政績、釐清金額／期程口徑 | `data/achievements.json` → `achievement-bade-detention.html` | 已補不同口徑與最新進度 |
| 鳳山車站長篇 hub | 保留整合 hub，並連回細分政績 | `achievement-fengshan-station-overview.html` | 新增 |
| 五福市場職人展 | 保留獨立活動／地方故事頁 | `activity-market.html` | 已恢復長文密度 |
| 美麗島事件 | 保留獨立歷史／人權 evergreen 頁，不列政績 | `history-meilidao.html` | 新增 |
| 問政紀錄 | 整併為站內議題頁的證據來源＋官方議會索引，不複製整套議會資料 | `news.html`、政績詳情頁、KCC official link | 保留入口，不做404/410 |
| 其他歷史／地方議題 | 個案判定：evergreen 留獨立頁；活動留活動頁；可驗證服務成果進政績 | 後續逐頁 audit | Stage 3 前不得批次刪除 |

## URL 邊界

本階段不對舊 `huiwen.tw` URL 做 404/410。正式切換自有網域前，Stage 3 應建立 old→new URL map、301 規則、canonical、sitemap 與 Search Console 驗證。
