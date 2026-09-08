# Full-site candidate review — 2026-09-08

Production 未部署。Drive 未更新。Notion 未更新。僅更新既有 Draft PR #2，不 merge、不 push main、不變更 Pages、Release 或管理設定。

## Runtime / baseline

- Main HEAD / baseline: `b65316777405ac7c6c8e2bc489249c6227d8c642`。
- Working branch: `feat/political-donation-page`。
- 本次修改前 PR head: `466c33cd4538c4d04134e17aa2c3afdb87791b10`。
- 實讀 main、open PR、PR #2、Actions、rulesets、branch metadata。PR #2 open/draft/mergeable；main drift No，無需同步。
- 修改前 CI: Validate canonical source / Political donation page QA 均成功；分別 run 34208279498 / 34208279444。
- 既有 Pages run 34198422729 成功，屬原 main 部署；本次不觸發發布。
- 既有架構保留：靜態 HTML、共用 styles.css/site.js、map.css/map.js、JSON → Python → HTML。無整站 redesign、URL migration 或新 CMS。

## Portrait and performance

沿用 repository `assets/chen-huiwen.png`（原頁標示議會公開人物素材），不換網路照片、不 AI 生成人像。保留完整 1348 × 1728 master（1,987,242 bytes）。衍生圖使用完整畫面，`object-fit: contain; object-position: right top`，width/height + aspect-ratio 預留空間。

| 來源 | WebP bytes | AVIF bytes |
|---|---:|---:|
| 240w | 6,650 | 6,996 |
| 480w | 17,090 | 19,718 |
| 800w | 35,606 | 44,076 |

首頁桌面280px、390px手機160px；政治獻金桌面180px靠右上、手機120px在文字後靠右。homepage eager + high priority；donation eager + auto priority；about lazy。實際下載依 DPR/srcset，不能把最小檔案說成所有裝置的下載量。視覺檢查衍生圖未見臉部失真或截頭；CLS 與 browser 結果以本次 CI artifact 為準，不將尺寸預留等同測得 CLS=0。

首頁與新聞頁 Facebook 改 click-to-load；保留直接連結與失敗提示。Canva、地圖底圖等第三方仍有外部請求。新聞／活動維持手寫 HTML，P2 才考慮獨立 data/news.json、data/activities.json，各自模板/build，由內容維護者審稿；逐頁遷移、同一 PR 可 revert，避免把所有內容塞入政績 build。

## Historical platforms

`data/platforms.json` → `python3 scripts/build_platforms.py` → `vision.html`，模板 `templates/platform-page.html`。政見與政績分離，全部年份與正文不依賴 JS。

| 年份 | 選舉／屆次 | 當時身分 | 原始 PDF 頁 |
|---|---|---|---:|
| 2005 | 高雄縣議員第16屆，第1選區 | 第15屆縣議員 | 1 |
| 2010 | 高雄市議員第1屆，第9選區 | 第15、16屆縣議員 | 1 |
| 2014 | 高雄市議員第2屆，第9選區 | 第1屆市議員 | 1 |
| 2018 | 高雄市議員第3屆，第9選區 | 第1、2屆市議員 | 2 |
| 2022 | 高雄市議員第4屆，第9選區 | 第1、2、3屆市議員 | 2 |

完整官方 PDF URL、投票日、原始分類、逐項政見存於 structured source。原始文件未載確切發布日期則 sourceDate=null，不能用投票日冒充發布日。2002縣議員公報、鳳山市第8屆代表選舉年份及公報仍缺第一手完整政見；2026尚無已核對的正式選舉公報政見，不挪用2022。

## Notion Link Audit / public boundary

全文掃描 tracked source + new source：HTML/CSS/JS/JSON/Python/Markdown/XML/YAML/templates/workflows/config/comments/generated HTML。原有1個完整外部案件入口 URL，出現在 README.md 與 petition.html，重新連線403且未取得正式公開入口確認。原識別碼 `1ffbd1468054800b9940fbfde5fee74d`；為避免在公開 repository 重引未確認入口，不在本報告保留完整可點網址。

- Notion unique URLs: 原1 → 最終0；保留0、移除1、待重新確認1。
- 2個引用位置已改為 petition.html / service.html#contact，無 iframe、JS/JSON 隱藏引用。
- 舊 vision 的自訂網域全文入口無法核驗，已改本站完整年份內容；不推定該網址必為 Notion。
- 無法確認外部入口是否包含私人 database；因此撤下，沒有嘗試曝光或遍歷內部頁面。
- `data/public-link-allowlist.json` 為空；只能加入服務處正式確認的完整服務登記 URL。
- `scripts/validate_site.py` 全 repository exact URL allowlist guard；一般內容不得透過 Notion runtime、embed 或內容目的地提供。
- petition 僅提供既有公開服務處聯絡。未建立姓名、身分證、地址或附件收集表單；實際告知、保存期限、處理者/權限/委外及個資流程仍需服務處確認。

## Evidence / consistency

詳見 ACHIEVEMENT-EVIDENCE-AUDIT.md。41筆逐筆檢查；13筆依第一手政府/議會資料重寫，其餘不當作已完成政績。保留原4筆中的既有查核連結不代表全部原聲明已證實。

修正八德滯洪池8,350萬元與公告時預定2026-10；過勇路2,977萬元；撤下未驗證經費與完工敘述。簡體「凤山车站」「台湾」「前镇区」改繁體；about補第4屆，撤下無法確認的現任學校監事職稱；歷史EMPP經歷標明2010公報。過埤/過碑官方文字差異公開註明待確認，不自行當作同一精確位置。

## SEO / accessibility / QA

54頁保留 zh-Hant-TW/title/description/canonical/favicon，補 OG image + Twitter Card。1200×630分享圖僅文字品牌；PNG與SVG，不使用新人物圖。首頁 root canonical 與 sitemap一致，internal home使用 ./；未改其他URL，無需redirect。首頁 WebSite/Person/Organization；詳情保留 Article + BreadcrumbList。

`python3 scripts/validate_site.py`：HTML5、JSON、內部target/anchor、srcset、圖片尺寸、SEO/sitemap一致性、敏感pattern與Notion guard。`validate_donation.py` 保留帳戶及法律整合檢查。`tests/donation/browser.mjs` 雖保留路徑，已擴為全站 Chromium，Desktop/390px核心頁 axe serious/critical、54頁導覽/overflow、功能、照片與no-JS。截圖及報告存CI artifact，外部偶發403/429不作CI blocker。

本地已執行：兩個 build、兩個validator、JS syntax、git diff --check。遠端browser結論以本次head CI為準；不可沿用舊head的passed。未執行電話撥打、Email寄送、實際案件/付款提交；無測試個資。

## Main protection read-only audit

main protected=false；rulesets=[]；branch metadata required status checks off。精確 protection endpoint 回403（integration缺 administration read），因此 force push、deletion、required PR、merge methods的獨立細項無法確認，不能寫成已啟用。

建議另行授權管理者：Require PR；Require canonical-source及full-site QA checks；Require latest main before merge；禁止force push及刪除main。此任務沒有修改管理設定。

## Required Information Before Publication

P0：服務處逐字確認政治獻金專戶仍有效、收受期間/截止、戶名/帳號/分行；確認轉帳後捐贈人資料的安全接收方式、收據及退款/繳庫流程、個資告知。若恢復外部案件登記，先確認正式完整入口及公開邊界。未核驗政績不得恢復為完成／經費確定聲明。

P1：補2002與代表選舉原始公報、核對歷史政見轉錄；補最新工程證據/位置核驗/個人功績歸因；正式服務處時間、Email、社群與素材公開性複核；人工真機、Safari/Firefox、完整鍵盤與第三方服務驗證。

P2：新聞活動structured source遷移、進一步效能量測與LCP改善。

## Rollback / publication

所有source+generated在同一工作branch，人工review後可逐commit revert；兩個build應可重現。候選變更不影響正式站，Production 未部署。此文件不代表已獲merge或正式收款頁發布授權。
