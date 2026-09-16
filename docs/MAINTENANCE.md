# 官網維護與品質入口

本文件維護工程操作；編輯政策仍依現行內容 owner 規範，不在此複製第二份正文。

## 安裝與單一入口

沿用 Python、靜態 HTML/CSS/JavaScript。Python 3.12；安裝 `beautifulsoup4==4.13.5 html5lib==1.1`。瀏覽器測試用 Node >=22.19.0、`npm ci --ignore-scripts --prefix tests/donation`，依現有 workflow 安裝 Chromium。

```sh
python3 scripts/build_cases.py
python3 scripts/build_platforms.py
python3 scripts/build_events.py
python3 scripts/build_search.py
python3 scripts/quality.py --baseline-ref origin/main
python3 scripts/quality.py --baseline-ref origin/main --browser
python3 scripts/inventory_site.py --as-of YYYY-MM-DDTHH:MM:SS+08:00 --output /path/outside/repository/inventory
python3 scripts/audit_external_links.py /path/outside/repository/external-links.json
```

清冊是 source 的派生報告，不可反向當 CMS。`assets.csv` 含每個資產的目的、owner role、依賴、觸發、頻率、公開性與處置；`routes.csv`、`records.csv`、`images.csv`、`dependency_graph.csv`、`external_dependencies.csv` 供影響範圍查找。以重新生成取代人工複製。素材 rights_status 預設未完成複查，不能把檔案存在誤當授權。

## 內容操作與人工 Gate

| 類型 | 可編輯 source | 操作與審閱 |
| --- | --- | --- |
| 新聞 | news.html | 先辨識事件與來源；原文標題、日期、內容與照片權利逐篇讀；一事件一張卡，使用既有 `.news-report-card` 與分類／標籤；多來源列完整報導。最後重建 search。 |
| 新聞稿 | press.html + news-*.html | 原稿 owner 校閱，摘要與全文同步，維持既有 URL；不得把新聞稿當第三方證實。 |
| 政績 | data/achievements.json | 依 ACHIEVEMENT-WORKFLOW，stable ID、範圍、階段與議員行動各自核驗；保留歷程；生成列表／詳情／search 並核對 sitemap／OG。 |
| 政見 | data/platforms.json | 原始公報頁碼與歷史版本不可改成當前承諾；無來源不補日期精度。 |
| 活動 | data/events.json | 核對時區與 start/end、主辦單位來源、改期／取消。現有 schema 尚無 cancellation lifecycle；未支援的狀態不可直接塞欄位或假裝已自動處理。 |
| 服務 | service.html 與既有跨頁副本 | 服務處 owner 確認電話、地址、時間；修改後全站搜尋舊值、重建 search、實際點到聯絡入口，禁止提交案件。 |
| 法律／獻金 | political-donation.html + docs/POLITICAL-DONATION.md | 具體法條及官方公告現況，交權責人審閱；不測付款、不自動裁定資格。 |
| 素材 | assets + 原件權利紀錄 | 同事件、作者、授權範圍、到期、caption/alt 逐一核實。無圖版型可正常發布；不得用其他事件補圖。 |

目前原始政績 source 中仍有待核驗歷史資料。沒有生成詳情、noindex、gitignore 都不是私密保護。任何將資料搬到私人 owner、清理公開 history 或改變 canonical 模型的方案，須先保全 stable mapping、影響／回滾與授權；不得直接刪除或強推 history。

## 品質三層

- PR deterministic：既有 schema、stable ID、HTML／local links／SEO／public copy、search／OG、build 兩次一致性；新增 isolated mutation tests。瀏覽器負向樣本證明 overflow、缺 accessible name 會失敗。
- 發布前／週期：外部 URL、時間敏感資訊、來源、Lighthouse、dependencies、素材授權；紀錄觀測時間。403／429／TLS／網路錯誤為 BLOCKED；404／410 為 FAIL；2xx 只表示可達，不代表內容正確。外部查核 sequential、每次間隔 >=0.25s、最多兩次，不繞過限制。
- 人工：歸因、事實衝突、著作權、法律、品牌與真實輔助工具；責任人未明時標未指派。自動 a11y 不是 WCAG 認證。

負向 fixtures 在 temporary repository／獨立瀏覽器頁面運行，不改 live content；不得放真實秘密或私人資料。`tests/test_quality_gates.py` 覆蓋 broken link、metadata、schema、stable ID、private URL、stale output、來源更新傳播及錯誤活動日期。`tests/donation/lifecycle.mjs` 覆蓋 a11y／overflow 負向樣本、減少動態、連續選單取消、搜尋 fallback、台／臺、零結果、觀察器不啟動、圖片失敗與無 JS 五種寬度。

## 維護責任與節奏（設定設計，非已啟用）

| 任務 | owner_role | Primary Scheduler Owner | trigger／頻率 | output／alert |
| --- | --- | --- | --- | --- |
| 品質／來源差異 | repo 維護者（人員未指派） | GitHub Actions | 每次 PR／main push，既有 workflow | current-head CI／有失敗才處理 |
| 發布驗證 | repo 維護者（人員未指派） | GitHub Actions | Pages workflow 完成，既有 workflow | HTTP parity + 同輪 live snapshot browser；失敗阻擋發布完成判定 |
| 重要 route／服務／活動期限 | 服務資訊 owner（未指派） | 未指定；未啟用 | 每日及異動 | 路徑／異動差異，失敗及恢復才通知 |
| 新聞增量／候選覆蓋 | 內容編輯（未指派） | 未指定；未啟用 | 每週；新聞以 90 天範圍起始 | 原文 receipts、合併／排除理由；新增缺口才通知 |
| 聯絡／律師／來源／GSC／套件 | 內容＋工程 owner（未指派） | 未指定；未啟用 | 每月 | 服務及 sitemap／索引差異、漏洞與到期 |
| UX／a11y／rights／備份還原 | UX＋素材＋repo owner（未指派） | 未指定；未啟用 | 每季 | 固定環境對照、權利審閱、離線還原 receipts |
| 任期／改期／法規／到期 | 對應業務 owner（未指派） | 未指定；未啟用 | 事件觸發 | 校閱後走 PR 流程，未確認不改公開事實 |

每項 recurring 任務啟用前先查 existing scheduler。建議 idempotency key=`task_id:source_revision:period`；bounded_retry=2，403／429 不反覆要求；成功完成 source write＋native read-back 才推 cursor。告警只報新增／恢復，去重且不含個資。fallback 為手動執行上述命令並保存 receipt。last_success 以各次 receipt 為準，不預填。此文件不建立通知、排程或新的外部服務。

## 視覺、互動與驗證規格

沿用墨綠／萊姆綠、既有 `styles.css`／`layout.css`／`mobile.css`／`digital.css` tokens 與 components，不另建 palette。標題、內文、來源、階段需保持可讀；無圖、長標題、多來源不隱藏資訊。按鈕須有 focus 與 pressed 回饋；尊重 `prefers-reduced-motion`，observer 失效不能藏重要文字。現有 timeline 只做 transform，不設 opacity=0。

比較固定 browser version、字型、資料、390／1440 viewport、動畫條件；測 320／390／768／1280／1440，並區分 zoom/reflow、實機鍵盤、AT、WebKit automation 與實機 Safari。流程順序：首頁→搜尋→新聞來源→地點政績→服務→歷史政見→活動→404 回首頁。第三方失敗使用既有直接連結，不以 iframe 成功作本站唯一可用條件。不要為 polish 改寫公共事實。

## Release、enforcement 與 rollback

遵守 DEPLOYMENT.md。保存 baseline、candidate、PR head、merge main、Pages run、artifact digest、live receipt；每批差異分開審閱。測試後改檔須重跑受影響 Gate，PR current-head checks 不能套舊 revision。

2026-09-16 read-back：rulesets=[]；main branch protection API 回 404「Branch not protected」。CI detection 存在，但 merge enforcement 不存在。Pages 為 branch/main root legacy deployment；不能宣稱發布由驗證 artifact 強制約束。

管理員待核准設定（未套用）：main active ruleset；require PR；block deletion/force-push；strict up-to-date required checks `validate`、`browser`、`lighthouse`、`secrets`（來源 app=GitHub Actions）；bypass list 空。需要實際 owner review 時設至少 1 approval、dismiss stale approvals、resolve conversations；不得宣稱自我檢查等於第二人 review。瀏覽器 workflow 已移除 path filter，避免 docs-only PR 永遠等待 required check。若要把 Pages 改為從 validated artifact 部署，屬獨立架構變更，需核准後才實作。

Rollback：先記錄 verified baseline；在隔離位置 `git archive <baseline>` 還原、安裝既有依賴、build／quality／代表頁 QA，對照預期 artifact；實際回退走 revert PR→CI→Pages→Production，不直接回滾 Production 演練。避免把含報告自己的 final SHA 寫回同一報告造成循環；final receipt 放 release 記錄。

證據保存：測試 log／screenshots 不進 deployable source，public CI artifacts 先確認沒有私密輸入，保留 14 天；release 必要 summary／digest／基準至少保留至後一版本驗證與回滾期結束，實際保留責任人未指派。私人候選／原件不進 public CI 或 repository。
