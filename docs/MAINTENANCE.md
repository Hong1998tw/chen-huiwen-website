# 官網維護與品質入口

本文件維護工程操作；編輯政策仍依現行內容 owner 規範，不在此複製第二份正文。

## 安裝與單一入口

沿用 Python、靜態 HTML/CSS/JavaScript。Python 3.12；安裝 `beautifulsoup4==4.13.5 html5lib==1.1`。瀏覽器測試用 Node >=22.19.0、`npm ci --ignore-scripts --prefix tests/donation`，依現有 workflow 安裝 Chromium。

```sh
python3 scripts/build_all.py
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
| 政見 | data/platforms.json | sections.items 保留原文；itemsById 穩定 ID 與關聯來源依下方契約維護。原始公報頁碼與歷史版本不可改成當前承諾；無來源不補日期精度。 |
| 活動 | data/events.json | 核對時區、start/end 與官方來源。status 為 scheduled／rescheduled／cancelled；改期與取消須 updatedAt、changeNote、sourceUrl，改期另須 previousSchedule.start/end。保留 id 及原頁錨點，取消不刪歷史。 |
| 服務 | service.html、data/legal-schedule.json 與既有跨頁副本 | 服務處 owner 目前未指定。核對電話、地址、時間與原始 Canva；月份、observedAt、validThrough、nextReviewAt 一起更新；執行 build_service，再重建 search。實際點到聯絡入口，禁止提交案件。 |
| 人物身分 | data/site-profile.json | recordAsOf 為身分資料記錄截止日；reviewAfter 是人工核對期限。官方結果未核實前 result 保持 null、nextTermStatus 保持 unverified；執行 build_profile 投影說明，不能以日期推定任職。 |
| 法律／獻金 | political-donation.html + docs/POLITICAL-DONATION.md | 具體法條及官方公告現況，交權責人審閱；不測付款、不自動裁定資格。 |
| 素材 | assets + 原件權利紀錄 | 同事件、作者、授權範圍、到期、caption/alt 逐一核實。無圖版型可正常發布；不得用其他事件補圖。 |

目前原始政績 source 中仍有待核驗歷史資料。沒有生成詳情、noindex、gitignore 都不是私密保護。任何將資料搬到私人 owner、清理公開 history 或改變 canonical 模型的方案，須先保全 stable mapping、影響／回滾與授權；不得直接刪除或強推 history。

## 品質三層

- PR deterministic：既有 schema、stable ID、HTML／local links／SEO／public copy、search／OG、build 兩次一致性；新增 isolated mutation tests。瀏覽器負向樣本證明 overflow、缺 accessible name 會失敗。
- 發布前／週期：外部 URL、時間敏感資訊、來源、Lighthouse、dependencies、素材授權；紀錄觀測時間。403／429／TLS／網路錯誤為 BLOCKED；404／410 為 FAIL；2xx 只表示可達，不代表內容正確。外部查核 sequential、每次間隔 >=0.25s、最多兩次，不繞過限制。
- 人工：歸因、事實衝突、著作權、法律、品牌與真實輔助工具；責任人未明時標未指派。自動 a11y 不是 WCAG 認證。

負向 fixtures 在 temporary repository／獨立瀏覽器頁面運行，不改 live content；不得放真實秘密或私人資料。`tests/test_quality_gates.py` 覆蓋 broken link、metadata、schema、stable ID、private URL、stale output、來源更新傳播及錯誤活動日期。`tests/donation/lifecycle.mjs` 覆蓋 a11y／overflow 負向樣本、減少動態、連續選單取消、搜尋 fallback、台／臺、零結果、觀察器不啟動、圖片失敗與無 JS 五種寬度。

## 維護責任與節奏（人員未指定；執行狀態依 run 核對）

| 任務 | owner_role | Primary Scheduler Owner | trigger／頻率 | output／alert |
| --- | --- | --- | --- | --- |
| 品質／來源差異 | repo 維護者（人員未指派） | GitHub Actions | 每次 PR／main push，既有 workflow | current-head CI／有失敗才處理 |
| 發布驗證 | repo 維護者（人員未指派） | GitHub Actions | main push／手動觸發，既有 workflow | HTTP parity + 同輪 live snapshot browser；失敗阻擋發布完成判定 |
| 服務月份／活動複查／身分期限 | 服務資訊與公開紀錄 owner（未指派） | GitHub Actions；content-freshness.yml | repo 已定義每日台灣時間 08:35 與手動觸發；排程可能延遲 | 產生 JSON／Markdown 待辦；只對新增或變更的到期問題標記 run failure，未變狀態不重複告警，恢復只寫報告 |
| 新聞增量／候選覆蓋 | 內容編輯（未指派） | 未指定；未啟用 | 每週；新聞以 90 天範圍起始 | 原文 receipts、合併／排除理由；新增缺口才通知 |
| 聯絡／律師／來源／GSC／套件 | 內容＋工程 owner（未指派） | 未指定；未啟用 | 每月 | 服務及 sitemap／索引差異、漏洞與到期 |
| UX／a11y／rights／備份還原 | UX＋素材＋repo owner（未指派） | 未指定；未啟用 | 每季 | 固定環境對照、權利審閱、離線還原 receipts |
| 任期／改期／法規／到期 | 對應業務 owner（未指派） | 未指定；未啟用 | 事件觸發 | 校閱後走 PR 流程，未確認不改公開事實 |

每項 recurring 任務啟用前先查 existing scheduler。建議 idempotency key=`task_id:source_revision:period`；bounded_retry=2，403／429 不反覆要求；成功完成 source write＋native read-back 才推 cursor。告警只報新增／恢復，去重且不含個資。fallback 為手動執行上述命令並保存 receipt。last_success 以各次 receipt 為準，不預填。除下方明載的 content-freshness workflow 外，其餘未指定的排程仍未啟用，不另建立外部通知服務。

### 內容有效期檢查與實際告警邊界

`.github/workflows/content-freshness.yml` 是本 repo 唯一內容期限 scheduler；合併至預設分支後依 GitHub 排程執行，不能把 workflow 檔存在當作已執行。它只有 `contents: read`，不改公開內容、不寫 Issue、不呼叫通訊服務。GitHub 帳號既有 Actions 通知設定決定是否收到 run failure 通知。

```bash
python3 scripts/check_content_freshness.py --output-json work/freshness.json --output-markdown work/freshness.md
python3 scripts/check_content_freshness.py --as-of 2026-10-01 --previous-json work/freshness.json --output-json work/freshness-next.json --fail-on-new-expired
python3 -m unittest discover -s tests -p test_content_governance.py
```

第二條是固定時鐘演練，不得把未來日期結果冒充今天狀態。daily job 以 cache 保存上一輪 fingerprint，先保存觀測再針對新到期事項失敗；同一到期條件下次仍在 JSON 待辦但不再失敗。cache 被清除／淘汰後首次執行會重新提示仍到期的事項，不能宣稱永久恰一次通知。成果 artifact 保留 14 天；長期收尾另按 release 歸檔。

`backlog` 表示待補來源或責任未指定；`due` 表示尚有效但應複查；`expired` 表示當月服務缺版、仍未結束的活動超過複查期，或人物身分到複查日。狀態只針對維護期限，不聲稱來源事實錯誤。已結束／取消活動保留歷史，不因時間過去判定其內容無效。`reviewDueAt`／`nextReviewAt` 是人工維護期限，不能改寫 `verifiedAt` 或 `observedAt` 來消除告警；應實際核對來源後更新。

截至本次資料紀錄，3 個 owner role 均為 unassigned，`person`／`backupPerson` 保持 null。責任未指定、政見欠量化目標及跨屆關聯待核實都列入機器可讀待辦，但不能因工程發布成功標完成。

### 政見 stable ID 與跨屆對照契約

`sections.items` 仍為原文字串，兼容既有搜尋及選舉頁 consumer；`itemsById` 是新增旁表，每個 ID 綁定 `year`＋`sourceText`，不可按新排序重新編號。新增項目需新增 ID；原文修改需核對來源並同步同一 ID 的 `sourceText`。renderer 以精確原文尋找 ID，重排不會移動證據；孤兒、缺漏、重複或非公開政績關聯會 fail-closed。所有原有原文、年份與原始來源均保留。

`relatedRecordIds` 只代表可核對的相關公開紀錄，不等於該政見已完成。2026 的 `accountability.target/deadline/responsibleAuthority/councilAction` 缺原始資料就保持 null；目前 renderer 明示缺口，不代替本人或團隊創造承諾。`crossTermComparisons` 目前僅允許 `topic_comparison`＋`needs_confirmation`＋`not_assessed`，交通與托育兩組只對讀 2022／2026 原文。若要發布延續、終止或完成判斷，須先擴充已審閱的證據契約，不能只改一個 status。

### 行程異動與行事曆

`updatedAt` 是行程內容最近一次有來源的更新，不能因重建 HTML 自動改為今天；`reviewDueAt` 是下一次人工核對期限。舊資料未填 status 時 reader 兼容 scheduled，新增 source 應明填。rescheduled 保留 `previousSchedule` 原時間；cancelled 保留原時間、異動理由與官方連結並移除報名／日曆按鈕。Google 日曆 TEMPLATE 只建立一次性副本，官網不宣稱能更新使用者已存的行程；卡片及日曆說明均提醒出發前回本站核對，取消頁提示手動刪除或更正舊副本。

## 視覺、互動與驗證規格

沿用墨綠／萊姆綠、既有 `styles.css`／`layout.css`／`mobile.css`／`digital.css` tokens 與 components，不另建 palette。標題、內文、來源、階段需保持可讀；無圖、長標題、多來源不隱藏資訊。按鈕須有 focus 與 pressed 回饋；尊重 `prefers-reduced-motion`，observer 失效不能藏重要文字。現有 timeline 只做 transform，不設 opacity=0。

比較固定 browser version、字型、資料、390／1440 viewport、動畫條件；測 320／390／768／1280／1440，並區分 zoom/reflow、實機鍵盤、AT、WebKit automation 與實機 Safari。流程順序：首頁→搜尋→新聞來源→地點政績→服務→歷史政見→活動→404 回首頁。第三方失敗使用既有直接連結，不以 iframe 成功作本站唯一可用條件。不要為 polish 改寫公共事實。

## Release、enforcement 與 rollback

遵守 DEPLOYMENT.md。保存 baseline、candidate、PR head、merge main、Pages run、artifact digest、live receipt；每批差異分開審閱。測試後改檔須重跑受影響 Gate，PR current-head checks 不能套舊 revision。

2026-09-16 read-back：rulesets=[]；main branch protection API 回 404「Branch not protected」。CI detection 存在，但 merge enforcement 不存在。Pages 為 branch/main root legacy deployment；不能宣稱發布由驗證 artifact 強制約束。

管理員待核准設定（未套用）：main active ruleset；require PR；block deletion/force-push；strict up-to-date required checks `validate`、`browser`、`lighthouse`、`secrets`（來源 app=GitHub Actions）；bypass list 空。需要實際 owner review 時設至少 1 approval、dismiss stale approvals、resolve conversations；不得宣稱自我檢查等於第二人 review。瀏覽器 workflow 已移除 path filter，避免 docs-only PR 永遠等待 required check。2026-09-22「全面完善」授權範圍包含本次 public artifact 發布改造；`pages.yml` 先跑 quality，再產白名單 `_site/`。實際 Pages workflow source 切換需在本次 PR 驗證後執行及 read-back，receipt 才能宣告已切換。2026-09-16 branch/root 狀態為歷史，不可當新架構現況。

Rollback：先記錄 verified baseline；在隔離位置 `git archive <baseline>` 還原、安裝既有依賴、build／quality／代表頁 QA，對照預期 artifact；實際回退走 revert PR→CI→Pages→Production，不直接回滾 Production 演練。避免把含報告自己的 final SHA 寫回同一報告造成循環；final receipt 放 release 記錄。

證據保存：測試 log／screenshots 不進 deployable source，public CI artifacts 先確認沒有私密輸入，保留 14 天；release 必要 summary／digest／基準至少保留至後一版本驗證與回滾期結束，實際保留責任人未指派。私人候選／原件不進 public CI 或 repository。


## 2026-09-22 公開成品與共用元件

- `build_all.py` 明列生成順序，`quality.py` 重建兩次檢查 drift／determinism。搜尋生成器只讀公開 HTML；`_site/` 不進索引、SEO 或 Git。
- `build_public.py --projection-only` 生成54筆已公開案件的嚴格欄位投影。`--check` 驗 public projection 與 map 一致；完整執行產 `_site/`，舊 `data/achievements.json` URL 僅供應相同 sanitized projection。
- `_site/` 禁含 docs、scripts、tests、schema、content-governance、原始待核紀錄。這縮小網站 bytes 邊界，不代表公開 GitHub 歷史被刪除。
- 共用 header/footer 由明確 marker 替換，所有 CSS/JS 版本在最後集中雜湊；人物與聯絡事實仍保留原始依據。`data/page-metadata.json` 只記內容實際更新日，禁止用 build 當日洗 lastmod。
- 內容原文不因減少重複而遺失：單事件頁可見歷程一次，完整背景可展開；所有 history.text 與 paragraphs 仍可在 HTML 核對。
- Production 三層證據分開：HTTP exact critical fields＋asset parity、normalized verified snapshot browser、direct native edge browser。最後一層 BLOCKED 不得標 PASS。
- 選舉45筆搜尋、無JS靜態內容、逾時fallback、日期跨期、SW離線/升級：`runtime-maturity.mjs`；首筆可讀/原始事件127公尺不遺失/陳情main不變：`site-maturity.mjs`。
