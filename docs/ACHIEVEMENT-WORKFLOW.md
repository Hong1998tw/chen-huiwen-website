# 政績候選、證據與 Coverage Audit

新接手的維護者先讀本文件，再讀最新 `docs/CANONICAL-SOURCE.md`、`docs/CONTENT-SOURCES.md`、`docs/DEPLOYMENT.md` 與當次任務限制。

## Authority

| 資料 | 權威與用途 |
| --- | --- |
| GitHub `main` | 網站公開 source；`data/achievements.json` 是唯一政績資料來源 |
| 私人 Candidate Registry | 候選 backlog、原始來源定位、查核與排除記錄；不直接供網站或 build 讀取 |
| 官方／第一手資料 | 工程狀態、日期、位置、歸因與現任里長的事實依據 |
| Notion Editorial Policy | 讀取最新「陳慧文官網｜內容・新聞・素材發布規範」；不在此複製政策正文或私人網址 |
| Production | 實際上線狀態，只用於驗證 |

Candidate Registry 保存於專案 Drive 的 `00_current/achievement-candidates.xlsx`。不得提交工作簿、原始服務案件、私人 mapping 或 audit report 到 repository，也不得建立第二份公開政績 JSON。GitHub 中既有待核驗紀錄仍須保留 stable ID；新增線索一律先進私人候選池。

## Workflow

原始服務案件／行程／議會／政府資料 → 私人 Candidate Registry → Coverage Audit → 官方證據查核 → 編輯審閱 → `data/achievements.json` ＋ `data/villages.json` → Build → Test → PR／CI → 依當次授權部署。

**當次任務若明定不部署，就必須停在 PR／candidate。** 不得因其他文件的預設部署流程而覆蓋明確限制。

## 新 Excel 加入方法

1. 取得最新 main commit，讀取原始檔與工作表，記錄檔名、定位、日期範圍及掃描是否完整。未取得原件不得宣稱已掃描。
2. 每個可辨識公共工程／政策建立穩定 `candidate_id`；不同道路、巷道、範圍、工程與時程分開。標題修改不改 ID。未提供足夠範圍的概括線索保留待拆分，不虛構多筆工程。
3. 原始案件 ID、姓名、電話、住址、私人附件與內部備註只留私人原件／候選池。另整理公開工程位置；不能把陳情人的住宅當作工程座標。
4. 執行 Coverage Audit。先處理 existing／needs_update，再確認 missing；possible_duplicate／conflict 必須人工檢視，不能自動新增。
5. 查官方資料，分開判定工程存在、進度及議員行動。只有政府工程紀錄，不能推成個別議員促成。缺證據留 `needs_verification`。
6. 讀取當時有效編輯規範，保全數字、日期、否定、條件及不確定性。提出、質詢、會勘、爭取、核定、發包、施工與完成不能互換。
7. 明確通過查核才更新原 ID 或新增公開 ID。Candidate Registry 不能直接匯出覆寫 achievements。
8. PR／CI 與授權發布後，再從最新 main 重新執行 Audit，更新 `last_compared_main_commit`，不要把未合併 branch 當成網站已收錄。

## Registry 欄位與狀態

工作簿包含候選總表、來源索引、Coverage Audit、位置與里界待查、排除／不公開。總表保留來源定位、原始案件 ID、草稿、位置、里別、查核、歸因、公開性、對應 ID、比對 main 與私人備註。總表首列為機器可讀欄名，輸入頁只放值；公式統計放 Coverage Audit 頁。

- `source_type`：service_case、schedule、council、government、news、manual、other。
- `candidate_status`：沿用 `achievement_metadata.STATUSES`。現行為待核驗、持續追蹤、爭取規劃、已完成、政策實施。
- `verification_status`：verified、partially_verified、pending、conflict、insufficient。
- `attribution_status`：direct、supported、joint、oversight、unclear。
- `publicability`：publishable、needs_verification、private_only、rejected。
- `coverage_status`：existing、needs_update、missing、possible_duplicate、conflict、insufficient_evidence、excluded。
- 多值以 `|` 分隔；日期用 ISO 格式，未知留白。日期精度不得靠補 1 日偽造。
- 既有公開紀錄可匯入作基準，但標明其 publishable 是既有 main 公開狀態，不代表此次重新驗證。

## Audit CLI 與判定

```bash
python scripts/audit_achievement_coverage.py \
  --candidate /private/achievement-candidates.xlsx \
  --public data/achievements.json \
  --main-commit ACTUALLY_OBSERVED_MAIN_SHA \
  --output audit-results/
```

支援 XLSX（預設 `候選總表`，可用 `--sheet`）、CSV、JSON。全程離線，不需要額外 Excel 套件或 API。輸入總表不執行公式；有公式會拒絕，避免過期快取被當作新資料。最多讀取 150 MB 解壓縮內容。數萬列應先由來源層清理為標準欄位；CLI 不會自動猜測不同來源的 schema。

比對順序：明確 achievement ID → 人工確認 stable mapping → 標準化位置 → 行政區＋里別＋分類＋日期交集。`--mapping` 可讀私人 JSON object（candidate ID 對 achievement ID），但有明確 ID 衝突時不覆蓋、不降級搜尋。

位置處理全半形、空白、台／臺、鳳山地址前綴、中文段巷弄號數字與路口分隔符號；不同巷號不能相同。**位置相同只能找出可能相同案件，不能證明工程相同**；同址可能有道路、排水、校園等不同案件，故先列 possible_duplicate。人工核對後把 stable ID 寫回總表，下一次才可判 existing。

最後的語意比對由人工／AI 輔助深讀執行；本 CLI 沒有假裝提供 AI semantic matching，也不會把私人輸入傳到外部模型。標題相似不能單獨決定 ID。

- main 中待核驗項目不計 Published，也不計 existing。
- 明確 ID 命中已公開項目後，里別／區別／位置／狀態矛盾列 conflict；新日期或已審閱 needs_update 標記列更新候選，並非自動核准。
- missing 須同時具備 publishable、verified、來源與明確歸因；無證據的未命中項目仍列 insufficient_evidence。
- 排除狀態不納入分母。Coverage＝**可公開候選中** existing＋needs_update／可公開候選數；分母為零輸出 null。另顯示候選總數、待查核數與 Published，不能把 100% Coverage 說成全部線索都已查完。
- 日期／金額／工程範圍的原始證據仍由人工核對；腳本無法證明來源正文與欄位完全一致。

報告為 `achievement-coverage.csv`、`achievement-coverage.json`，只輸出候選 ID、匹配 ID、狀態、比對階段、理由代碼與 main commit，不複製姓名、電話、原始案件 ID、私有備註或草稿。報告仍屬私人資料。JSON 另保存輸入 SHA-256 以辨認快照；不自動回寫 Registry 或網站。

Repository 內報告目的地必須在 gitignore 中；檔案建立為 0600。`.gitignore` 是防誤提交，不能代替權限管理，也不能擋 `git add -f`；PR 前須檢查 staged paths。

## 里別與位置

`data/villages.json` 使用 **district＋name** 複合鍵，避免同名里跨區錯配。只保存官方公開姓名、任期、來源、查核日期及里界名稱，不保存里長電話／生日／住址。

首次名冊來自鳳山區公所[第四屆里長名冊](https://fsdo.kcg.gov.tw/cp.aspx?n=45401A5D47F711ED)。`verifiedAt` 為實際讀取日期；網頁未提供個別名冊修訂日，`sourceDate` 留 null，不把網站頁尾更新日當成每列發布日。

既有里界採[內政部國土測繪中心村里界圖](https://data.gov.tw/dataset/7438)，實際網站檔案為 `assets/fengshan-villages.geojson`。`boundaryName` 必須對應圖資名稱。此版不更新里界快照、不宣稱重新驗證所有案件的落點。跨區案件可加入其他區的官方名冊；沒有該區 polygon 不妨礙文字列表與已核對點位使用。

build 依案件 villages join 現任里長；跨里全部顯示，不暗示現任者曾參與歷史工程。全市政策 villages 為空、coordinates 為 null，顯示高雄市／現任里長不適用。其他未分里的跨區案件顯示服務範圍，不亂填一位里長。

`locationName` 為公開工程／場館位置；`locationNote` 記錄有證據的起訖、跨里與代表點限制。**範圍未知時顯示位置說明，不創造工程起訖。** 座標僅為代表位置，不是工程 polygon；不確定就 null。

## Build、搜尋與驗證

`scripts/achievement_metadata.py` 提供共用 lookup、可公開判定、semantic facts 與搜尋文字。`build_cases.py` 先驗證再生成，僅使用明確公開欄位，從不載入 Registry。`build_search.py` 繼續從公開 HTML 產生唯一全站搜尋索引。地址、里長可搜尋的前提是已有通過公開範圍的案件；未公開的候選搜不到是正確行為。

```bash
python -m json.tool data/achievements.json > /dev/null
python -m json.tool data/villages.json > /dev/null
python scripts/validate_achievements.py --baseline-ref BASELINE_REF
python -m unittest discover -s tests -p 'test_achievement*.py'
python scripts/build_cases.py
python scripts/build_platforms.py
python scripts/build_events.py
python scripts/build_search.py
# 審閱並提交預期 generated output 後，重跑 build：
git diff --exit-code
python scripts/validate_site.py
python scripts/validate_donation.py
python scripts/validate_seo.py
python scripts/validate_p0.py
python scripts/validate_public_copy.py
```

新增／刪除詳情頁時還要更新 sitemap 與 `scripts/build_share_cards.py` 所需分享圖；檢查 Article／Breadcrumb JSON-LD、canonical、OG、Twitter Card 與 `zh-Hant-TW`。本次保留既有 stable ID 與 20 個公開詳情頁，無新增分享圖需求。

`validate_achievements.py` 阻擋重複／無效 ID、未知里別、缺失里長／官方來源／查核日、無效座標、缺失可追溯來源、私人欄位與常見個資／憑證。手機、身分證樣式、住戶姓名加門牌及私有文件 URL 採保守規則；錯誤不輸出偵測內容。正規表示式不能證明個資不存在，仍須差異審閱。既有 attribution 待證據記錄目前明確 warning，不能因此替它新增功勞或升級成果。

CI 不持有私人 Excel；只跑 synthetic unit tests 與 CLI help。完整瀏覽器 QA 包含桌面／390px、搜尋、篩選、10 筆分頁、Dashboard、地圖、跨里 facts、鍵盤、無 JS 閱讀、Accessibility 與 SEO。不要把 Not Run 寫成 Passed。

## 本版與後續

本版先完成治理架構；新線索未查核者不新增公開頁。既有資料中的來源只是追蹤入口、歸因不足、里界尚未逐案確認等問題，須逐筆補證據，不把 validator 通過當作事實查核成功。

P1：補原始案件／行程檔、官方逐案證據、里界與工程範圍；成熟後再做里別探索頁。P2：大量資料分批 intake、來源快照 freshness、人工確認映射回饋與可衡量的語意配對準確率。任何模型／schema／部署架構擴充另依任務授權。
