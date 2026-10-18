# 發布前測試清單

本清單是進入 `main`／GitHub Pages 前的最低測試基準。依實際修改範圍可增加測項，不應刪除與本次變更直接相關的檢查。

## A. Source／Build

- [ ] `data/achievements.json` 可正常解析。
- [ ] `python3 scripts/build_cases.py` 可成功執行。
- [ ] build 後沒有未預期 diff。
- [ ] 需要版本化的產生檔已納入 commit。
- [ ] 未出現 `YOUR_GITHUB_USERNAME`、`YOUR_REPOSITORY_NAME` 等 placeholder。
- [ ] 未出現 token、API key、密碼、私人案件個資、內部附件或內部網址。

## B. Desktop

- [ ] 首頁可正常顯示。
- [ ] 首頁「勝選倒數」緊接在「慧文會武／會做事」下方，只顯示倒數與 `2026.11.28`，不再出現獨立選戰卡或 10/23 抽籤資訊。
- [ ] 主要導覽可開啟：關於、政績、政見、新聞、新聞發稿、活動、相片集、服務資訊、案件表單。
- [ ] 字型、圖片、CSS、JavaScript 無明顯缺漏。
- [ ] Browser console 無阻斷功能的 error。

## C. 390px 行動版

- [ ] 導覽可開關且不遮蔽主要內容。
- [ ] 文字、卡片、表單、地圖與按鈕沒有橫向溢出。
- [ ] 主要 CTA 可點擊。
- [ ] 圖片與 iframe 不破版。
- [ ] 「關於慧文」人物照寬度不超過 120px，與姓名／身分並排，介紹文字接續在下方。

## D. 政績與地圖

- [ ] 不顯示頁首件數、里數或「政績統計總覽」；頁面由搜尋／篩選、地圖及逐案列表開始。
- [ ] 關鍵字搜尋。
- [ ] 里別／服務範圍篩選。
- [ ] 主題篩選。
- [ ] 進度篩選。
- [ ] 地圖點位／里界互動。
- [ ] 詳情頁與歷程紀錄可開啟。
- [ ] 無 JavaScript 時仍能閱讀基本政績列表／詳情。
- [ ] 新增／刪除專題時同步檢查 sitemap 與舊網址處理。

## E. 新聞／新聞發稿

- [ ] 「新聞」只呈現媒體／議會相關新聞報導，不混入服務處新聞稿。
- [ ] 「新聞發稿」完整列出既有新聞稿詳情頁。
- [ ] 兩頁主題分類與 # 標籤皆為可複選選單，搜尋、重要／日期排序可用。
- [ ] 每筆新聞／新聞稿卡片皆有至少一個可見 # 標籤；主題與 # 標籤組合篩選結果正確。
- [ ] JavaScript 啟用時每頁最多 10 筆，分頁可操作。
- [ ] 390px 與 Desktop 無橫向溢出，導覽中的「新聞發稿」可正常進入。
- [ ] 新聞照片為同一事件且具可重製權，並顯示日期脈絡、caption、credit 與可追溯來源；權利未明的媒體照片不進入 repository。

## F. 外部服務與聯絡

- [ ] 電話連結。
- [ ] 服務處地址／地圖連結。
- [ ] LINE。
- [ ] Facebook。
- [ ] Instagram。
- [ ] YouTube。
- [ ] 高雄市議會公開資料／質詢影音。
- [ ] Canva 公益律師資訊與每月時間表。
- [ ] 服務案件公開表單。

第三方 iframe 可能受瀏覽器隱私設定限制；即使 iframe 失敗，也必須保留可用的直接連結。

- [ ] 首頁／新聞頁 Facebook 與服務頁 Canva 律師時間表會自動載入；第三方受限時仍保留重新載入與原站直接連結，且不出現異常大面積空白。

## G. Accessibility／基本品質

- [ ] `lang="zh-Hant-TW"`。
- [ ] 主要圖片有合理 alt。
- [ ] 鍵盤可操作主要導覽與互動。
- [ ] 焦點狀態可辨識。
- [ ] skip link 可使用。
- [ ] 主要 heading 層級合理。
- [ ] broken link 抽查完成。

### 自動 WCAG 2.2 AA 與 target-size 基準

`tests/donation/` 的 axe 執行保留既有 WCAG 2.0／2.1 tags，並實際加入 `wcag22aa`；本次不移除既有 axe 規則或 Lighthouse best-practices 門檻。target-size 使用鎖定的 `@axe-core/playwright` 4.10.2／axe-core 4.10.3。

PR browser 與 Production browser 使用 `WCAG22AA_TARGET_SIZE_MODE` 精確選擇 `capture-pending` 或 `compare`；未設定時為 `capture-pending`。此模式輸出目前 target-size 違規、量測結果與例外證據，gate 標示 `capture-pending`，已知基準數維持 `null`，不宣稱比較或通過；同時其他 axe 嚴格斷言照常執行。零筆目前 entries 也不會核定成零違規基準。

PR 使用 `tests/donation/wcag22aa-baseline.json` 與 `full-site-candidate-qa` scope；Production 使用獨立的 `tests/donation/wcag22aa-production-baseline.json` 與 `production-live-core-pages-default` scope。只有明確設定 `WCAG22AA_TARGET_SIZE_MODE=compare` 才進行比較；必須有相同 scope、真實 workflow run／artifact 來源、相符 axe 版本、明確 entries（零筆時也須為已核准的空陣列），且每筆既有違規都有人工作成 WCAG 2.5.8 例外判定與理由，否則 fail closed。核准後新增 selector／viewport 違規、已修復項目未自基準移除、或無法量得完整 target 尺寸都會使比較失敗。readiness 與 lifecycle runner 保留原有 strict-zero target-size gate。

Browser CI 會把 route、viewport、scenario、axe selector、量得的 CSS bounding box、axe check／exception 證據與基準狀態輸出到 `tests/donation/results/wcag22aa-target-size.json`。複合 frame／shadow selector 暫不以宿主元素或路徑片段代替；無法解析完整 target 時記為 `unresolved`，compare 會失敗並保留診斷。

自動 axe 規則只提供工具能檢查的頁面線索，不等於完整 WCAG 2.2 AA 符合性認證。WCAG 2.5.8 例外、控制用途與上下文仍須人工覆核；鍵盤、真實輔助科技及其他無法由該規則確認的項目仍按各自流程檢查。

## H. Release Gate

- [ ] 已閱讀完整 diff。
- [ ] 變更內容與需求一致。
- [ ] 不修改範圍沒有被誤動。
- [ ] 已記錄上一個可回滾 commit。
- [ ] 已檢查是否存在 Evidence、CI、安全、diff、rollback 或重大變更範圍等具體疑慮；若沒有疑慮，預設直接部署，不再等待額外確認。
- [ ] 若本次停在 PR／candidate 未部署，已明確記錄阻擋部署的具體疑慮與解除條件。
- [ ] 部署後已重新驗證 production URL。
- [ ] Production Browser QA 實際使用 `tests/donation/production-browser.mjs` 連線 `https://www.huiwen.tw/`，不是以 checkout candidate 取代 live 驗證。

最後更新：2026-10-18。

## Full-site candidate QA

- python3 scripts/build_cases.py
- python3 scripts/build_platforms.py
- git diff --exit-code （generated consistency）
- python3 scripts/validate_donation.py
- python3 scripts/validate_site.py
- npm ci --prefix tests/donation
- npx --prefix tests/donation playwright install --with-deps chromium
- node tests/donation/browser.mjs

Browser report/screenshots/axe：tests/donation/results（CI artifact，勿commit）。外部URL另以 scripts/audit_external_links.py 審核，不作merge blocker。上述為指令清單，執行狀態以當次head CI及報告為準。
