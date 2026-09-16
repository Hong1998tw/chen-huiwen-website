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

## H. Release Gate

- [ ] 已閱讀完整 diff。
- [ ] 變更內容與需求一致。
- [ ] 不修改範圍沒有被誤動。
- [ ] 已記錄上一個可回滾 commit。
- [ ] 已檢查是否存在 Evidence、CI、安全、diff、rollback 或重大變更範圍等具體疑慮；若沒有疑慮，預設直接部署，不再等待額外確認。
- [ ] 若本次停在 PR／candidate 未部署，已明確記錄阻擋部署的具體疑慮與解除條件。
- [ ] 部署後已重新驗證 production URL。
- [ ] Production Browser QA 實際使用 `tests/donation/production-browser.mjs` 連線 `https://www.huiwen.tw/`，不是以 checkout candidate 取代 live 驗證。

最後更新：2026-09-16。

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
