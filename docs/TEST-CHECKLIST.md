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
- [ ] 主要導覽可開啟：關於、政績、政見、新聞、活動、相片集、服務資訊、案件表單。
- [ ] 字型、圖片、CSS、JavaScript 無明顯缺漏。
- [ ] Browser console 無阻斷功能的 error。

## C. 390px 行動版

- [ ] 導覽可開關且不遮蔽主要內容。
- [ ] 文字、卡片、表單、地圖與按鈕沒有橫向溢出。
- [ ] 主要 CTA 可點擊。
- [ ] 圖片與 iframe 不破版。

## D. 政績與地圖

- [ ] 關鍵字搜尋。
- [ ] 里別／服務範圍篩選。
- [ ] 主題篩選。
- [ ] 進度篩選。
- [ ] 地圖點位／里界互動。
- [ ] 詳情頁與歷程紀錄可開啟。
- [ ] 無 JavaScript 時仍能閱讀基本政績列表／詳情。
- [ ] 新增／刪除專題時同步檢查 sitemap 與舊網址處理。

## E. 外部服務與聯絡

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

## F. Accessibility／基本品質

- [ ] `lang="zh-Hant-TW"`。
- [ ] 主要圖片有合理 alt。
- [ ] 鍵盤可操作主要導覽與互動。
- [ ] 焦點狀態可辨識。
- [ ] skip link 可使用。
- [ ] 主要 heading 層級合理。
- [ ] broken link 抽查完成。

## G. Release Gate

- [ ] 已閱讀完整 diff。
- [ ] 變更內容與需求一致。
- [ ] 不修改範圍沒有被誤動。
- [ ] 已記錄上一個可回滾 commit。
- [ ] 已檢查是否存在 Evidence、CI、安全、diff、rollback 或重大變更範圍等具體疑慮；若沒有疑慮，預設直接部署，不再等待額外確認。
- [ ] 若本次停在 PR／candidate 未部署，已明確記錄阻擋部署的具體疑慮與解除條件。
- [ ] 部署後已重新驗證 production URL。

最後更新：2026-09-11。

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
