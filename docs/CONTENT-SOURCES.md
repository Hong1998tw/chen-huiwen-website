# 內容來源、事實狀態與公開邊界

## 1. 公開內容來源優先序

對可能變動的內容，優先使用第一手／官方來源：

1. 高雄市議會與其他政府機關官方資料。
2. 陳慧文服務處正式公開渠道與正式網站／社群。
3. 政府資料開放平台與原始資料集。
4. 原始新聞、機關公告或具名公開資料。
5. 經人工審閱、保留來源欄位的 `data/achievements.json`。

二手新聞與 AI 摘要只能作補充，不應取代第一手來源。

## 2. 事實狀態

新增或修改公開內容時，應明確區分：

- **已確認事實**：有可驗證第一手／原始來源支持。
- **合理推論**：由已知資料推導，但來源沒有直接陳述。
- **待核驗**：有線索但尚未完成來源確認。
- **未知／資料不足**：目前無法可靠判定。

只有「已確認事實」可直接寫成官網確定敘述。合理推論不得被 AI 改寫成既成事實。

## 3. 政績資料規則

`data/achievements.json` 是政績 source data。更新時：

- 保留穩定 `id`，避免破壞既有網址。
- 保留來源、日期精度、狀態、缺漏與補充說明。
- 沒有完工證據時，不把「爭取／追蹤／規劃」改成「完成」。
- 代表點位不是工程範圍；位置不可靠時寧可不放點位。
- 原始里名、座標或來源互相矛盾時，先停用不可靠定位並記錄衝突。
- 新增／移除專題時同步檢查 sitemap 與舊網址。

## 4. 可以公開的內容

- 已確認的公開政績、政策、服務資訊。
- 正式公開聯絡方式、服務時間、社群與表單。
- 官方議會資料、政府公開資料、公開新聞來源。
- 已授權或符合使用條件的公開素材。
- 對外公開的法律諮詢／活動資訊。

## 5. 禁止進入公開 repository／網站的內容

- Notion token、API key、密碼或任何憑證。
- 民眾姓名、電話、地址、身分證號、案件細節等私人個資。
- 未公開服務案件、內部附件與私人研究文件。
- 選務策略、內部協調紀錄、未公開工作資料。
- AI Session、系統提示、內部 MCP／Runtime State 等不應公開資訊。
- 不應公開的 Notion、Drive 或其他內部存取網址。

## 6. 素材與第三方服務

- 圖片、地圖、圖資與第三方 library 必須保留合法來源／授權脈絡。
- Facebook、Canva 等第三方 iframe 可能因供應商或瀏覽器設定失敗，需保留直接連結作 fallback。
- 第三方內容變更時不得假設舊嵌入仍有效，發布前重新驗證。

最後更新：2026-09-08。

## 2026-09-08 v1 published source revision（歷史）

歷屆政見唯一 structured source 為 `data/platforms.json`，官方 CEC 公報逐年 URL 與頁碼在各筆 `sourceUrl`／`pdfPage`；由 `build_platforms.py` 獨立產生 `vision.html`。政績查核依 `ACHIEVEMENT-EVIDENCE-AUDIT.md`，待核驗資料不當作完成事實。v1 當時 Notion 一般公開內容入口禁止，服務案件例外尚未正式確認，因此 allowlist 為空。

政治獻金的官方來源、查核日期、條文對照、時間效力及待確認事項集中於 `docs/POLITICAL-DONATION.md`；公開頁面由 `political-donation.html` 與 `political-donation.css` 維護。歷屆政見原始內容與逐年官方公報來源集中於 `data/platforms.json`，不得以 generated `vision.html` 取代 source。

v1 於 2026-09-08 由 PR #2 至 #8 完成主要功能發布；發布追溯見 `docs/RELEASE-2026-09-08-V1.md`。

## 2026-09-08 v2 published source revision

v2 延續 v1 的政治獻金、人物圖片、歷屆政見、SEO、Accessibility 與全站前端治理，並新增兩項正式變更：

1. PR #9：移除 `vision.html` 頁首的編輯說明文字；`data/platforms.json` 的各屆正式選舉公報政見、來源 URL、頁碼與 `verifiedAt` 均未改動。政見仍不得被視為已完成政績。
2. PR #11：正式確認「服務案件登記」為唯一允許公開導向 Notion 的例外。公開入口固定為 `https://lihong-tw.notion.site/1ffbd1468054800b9940fbfde5fee74d`，並由 `data/public-link-allowlist.json` 採 exact URL allowlist；其他 Notion URL 仍由 `scripts/validate_site.py` 阻擋。

服務案件只公開入口 URL，不將 Notion 內案件內容、民眾個資、附件、workspace URL 或 credential 複製到 GitHub／Production。若 Notion publish/share 設定變更，需重新驗證未登入公開可達性。

政治獻金 evidence 仍以 `docs/POLITICAL-DONATION.md` 為 canonical；本次未更改專戶、法規、限額或收受期間等公開事實。歷屆政見 evidence 仍以 `data/platforms.json` 為 canonical。完整 release 追溯見 `docs/RELEASE-2026-09-08-V2.md`。
