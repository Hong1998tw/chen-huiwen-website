# 全生命週期品質查核｜2026-09-16

本報告為 baseline `e92bce7c31236f21428ff0da2ace9df214defa8c` 的查核與品質維護增量。**整站無條件 ready：BLOCKED**。本次工程品質修復可獨立依 current-head PR／CI Gate 發布；公開事實、權利、管理設定仍依各項範圍處理。final tested revision／PR／Pages／runtime 以 release receipt 為準，非本文件自引用 SHA。

## 清冊與分母

as_of=2026-09-16 Asia/Taipei；全部 tracked/unignored deployable source。

- 94 個 HTML 路徑：91 個根目錄頁面＋3 個 legacy path 頁。90 個 indexable／sitemap／search entries；404 排除。
- 72 筆政績 source：54 筆有公開詳情、18 筆待核驗。54 筆中的狀態分布：持續追蹤 26、爭取規劃 18、政策實施 1、已完成 9；95 個公開歷程節點、16 個代表點位。這些不是新增核驗比例。
- 26 張新聞卡、17 篇新聞稿、1 筆活動、6 組政見。新聞 discovery 日期窗 2026-06-18 至 2026-09-16；既有卡片全量 metadata 清冊，不宣稱原文全部重查或近90天完整收錄。
- 85 個圖片檔完整列入 manifest；權利與照片內容需逐案審閱，舊 credit 不等於新的完整授權。
- 141 個外部 URL 一輪 bounded availability audit：52 PASS、89 BLOCKED、0 FAIL。GET response headers，沒有全頁正文核驗；403／429／網路錯誤未判不存在，禁止以這個結果宣稱全部來源有效。

用 `scripts/inventory_site.py` 重建清冊與 Route × Content × Template × Asset × External dependency graph；詳細輸出在當次交付包。私人候選輸入／比對結果不進 repository 或 CI。

## 可重現工程修復與測試

| check_id | scope／method | 結果與邊界 |
| --- | --- | --- |
| Q-01 | README 對照 Pages native metadata | PASS：修正 production domain 與過期未設定網域敘述；歷史數字標為歷史。 |
| Q-02 | 外部查核工具 | PASS：動態觀測時間、結構化解析、逐項 receipt、sequential 有界重試；取代寫死日期與8連線掃描。 |
| Q-03 | 單一 deterministic quality | PASS（本機）：沿用所有現有 validators，兩次 build 無 drift；49 個 Python tests＋4 個 events tests。 |
| Q-04 | 負向 fixtures | PASS（本機）：broken link、metadata、schema、stable ID、private URL、stale generation、event end；另測資料同步至列表／詳情／search。 |
| Q-05 | Chromium baseline | PASS：既有全站 suite；補充12頁×320/390/768/1280/1440共60組，console／request／axe／overflow／CLS gates；來源未修改。 |
| Q-05b | WebKit automation | PASS：12頁×390/768/1440共36組；不等同實機Safari。 |
| Q-06 | 韌性與 browser negatives | PASS（本機）：12 個 check IDs；包含 overflow/a11y 負向樣本、搜尋 fallback、台／臺與超長零結果、圖片故障、no-JS、reduced motion、選單取消、observer無回報。 |
| Q-07 | workflow detection | 已接入 quality 與 lifecycle tests；移除 browser path filter以支援 required checks。實際 CI 以 current-head receipt 判定。 |
| Q-08 | main enforcement | FAIL：native read-back rulesets=[]、branch protection 404；修復 BLOCKED，需 repo admin 核准 MAINTENANCE.md exact proposal。 |
| Q-09 | deployment constraint | BLOCKED：Pages 從 main root legacy branch 發布，不是經驗證 artifact 的強制 promotion。改架構須另核准。 |
| Q-10 | field performance／真實 AT | BLOCKED：沒有本輪 field p75 CWV；未操作實機 Safari／iPhone／screen reader，不以 Lighthouse、WebKit automation 代替。 |

負向測試從隔離 fixture 產生錯誤，未修改 live content。全部 review 由同一執行者進行，沒有偽稱獨立第二人 review。時間與完整結果以測試 receipts 為準。

## 內容完整度與處置

| 頁型／用途 | 現有資訊與處理 | 尚缺／owner／下一動作 |
| --- | --- | --- |
| 首頁／首次理解 | 人物、服務、聯絡、既有選舉資訊、第三方 click-to-load；保留原設計 | 個別服務時間仍需服務處 owner 定期確認。 |
| 人物 | 官方議會來源及歷史介紹存在 | 早期完整公報／任期資料逐條再查；內容 owner 未指派，禁止補猜。 |
| 新聞／新聞稿 | 分開索引；搜尋、標籤、多來源、無圖可用 | 90天新線索與歷史來源正文未全部重查；逐事件 Evidence Gate。 |
| 政績 | 54詳情／95歷程／16點位；11項legacy attribution warnings仍存在 | 歸因與工程完成分開；已有來源的行動可查，不能直接升級功勞。內容 owner逐案review。 |
| 待核驗 source | 詳情／search不生成18筆 | FAIL：公開 JSON仍含待核驗資料；遷入私人 intake、stable tombstone與history策略須明確方案和授權，不以隱藏頁面當修復。 |
| 議會／政見 | 官方來源、摘要、歷屆公報欄位 | 歷史逐字轉錄未全量重查；摘要不得冒充逐字稿。 |
| 活動 | 1筆10/8 16:00–16:50官方議程；來源排程對應 | current schema沒有取消／改期狀態欄；需要時先核准相容schema，未擅自擴充。 |
| 相簿／下載／影音 | 原圖連結、基本lightbox、外部影音來源 | 權利、EXIF／影像個資、字幕、實機輔具仍需人工審閱；不自動換圖。 |
| 服務／表單 | 電話、地址、LINE、Canva與表單fallback | 不送真實案件；收件端保留／刪除流程由外部系統owner確認。 |
| 法律／捐款 | 官方法規與專戶查詢入口 | 2026-09-16法規頁修正日期仍107-06-20；現行專戶許可結果與內部收據／退費流程需權責人複核；不付款、不新增法律結論。 |
| 隱私 | terms.html 有既有說明；網站含第三方請求與service worker | 外部服務保存期間、實際資料流與權利完整審查未完成；未新增analytics或cookie banner。 |
| 404／舊址 | noindex、正確canonical、逐址mapping | live edge mapping抽查與Search Console落地頁仍需逐URL核對；不全面轉首頁。 |

NOT_APPLICABLE：本站無登入／CMS／原生後端／付款處理器，因此不建立其備份、帳號或transaction測試。外部服務故障、來源不足或原始權利缺件不是 N/A。

## 可得 runtime／SEO 觀測

- fresh main `e92bce7...`；既有 Pages run `35043783849`、post-Pages verification `35043862845` success，屬 baseline直接讀回，非本次新release。
- 2026-09-16 live HTTP：apex 301→www；www 200；Pages cname=www.huiwen.tw、HTTPS enforced、certificate approved。Cloudflare response headers實際可見，但未讀Cloudflare控制面，因此不宣稱目前全部DNS／SSL設定。
- GSC connected property已可讀；sitemap.xml errors=0，provider回報89 submitted、indexed=0；後者不當作全站零索引證明。舊 `/laf` 被當sitemap提交且 errors=1，需SEO owner在GSC移除錯誤sitemap項目（不刪網站URL）；此執行端未提供修改sitemap工具。Stored URL inspections清單為空，不代表Google從未爬取。

## 維護／回滾與決策

見 MAINTENANCE.md 的 owner／frequency／trigger／scheduler／idempotency／retry／fallback／enforcement proposal。既有PR與發布觸發CI可直接觀測；新增每日、週、月、季排程與通知未啟用。未知owner均未指派。

必須保留的未完成範圍：來源與圖片權利、候選欄位對接、待核驗source公開邊界、法律作業、實機AT、field CWV、GSC錯誤sitemap、branch/deployment enforcement。這些阻擋「整站全面ready」聲明；不把已驗證而獨立的工程維護修復與未核准架構變更混成同一release。

技術基線重新讀取：[WCAG 2.2](https://www.w3.org/TR/WCAG22/)、[Core Web Vitals](https://web.dev/articles/vitals)、[GitHub branch protections](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)、[Actions security](https://docs.github.com/en/actions/reference/security/secure-use)、[sitemap lastmod](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)。
