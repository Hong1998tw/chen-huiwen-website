# 部署、發布與回滾

## Production

- 平台：GitHub Pages（origin）＋ Cloudflare edge
- Repository：`Hong1998tw/chen-huiwen-website`
- Production branch：`main`
- Production canonical URL：`https://www.huiwen.tw/`

## 標準發布流程

1. 從最新 `main` 建立工作 branch。
2. 讀取本次任務相關 source 與公開資料來源。
3. 完成最小必要修改。
4. 政績資料變更時，優先編輯 `data/achievements.json`，再執行：

   ```bash
   python3 scripts/build_cases.py
   ```

5. 檢查 `git diff`，確認沒有非預期輸出、placeholder、token、私人資料或內部網址。
6. 完成 `docs/TEST-CHECKLIST.md` 的必要項目。
7. 建立 Pull Request，讓 CI 與必要 browser／Accessibility QA 驗證修改。
8. 依下方「預設直接部署；有疑慮才等待」規則處理，不再對例行安全修改逐次詢問是否部署。
9. 合併至 `main` 後，由 GitHub Pages 發布。
10. 部署完成後重新檢查 production，而不是只確認 GitHub commit 成功。
11. 需要正式 release／收尾時，將 release artifact、commit SHA、測試摘要歸檔至 Google Drive `03_releases/`；重大決策或流程變更更新 Notion。

## 預設直接部署；有疑慮才等待

自 2026-09-11 起，**官網修改只要已完成必要查核、build、test、diff review、PR 與 CI，且沒有具體疑慮，就預設直接 merge `main`、等待 GitHub Pages，並完成 Production Verification；不得再逐次詢問「是否要部署」。**

這裡的「直接部署」代表自動完成安全發布流程，不代表：

- 直接 push `main`。
- 略過 branch、PR、CI、build 或必要測試。
- 在 CI／Evidence Gate 失敗時強行發布。
- 使用 Drive candidate 覆蓋 GitHub source。
- 把尚未驗證的 AI 推論寫入公開網站。

通常可直接發布的例行變更包括：少量新聞／政績／活動／公開文字更新；已核驗的日期、數字、地址、電話與來源修正；權利清楚的同事件圖片更換；既有視覺語言內的小型 CSS、mobile、Accessibility、SEO metadata、broken link 修正；不改資料模型與核心流程的小型 JavaScript bugfix；以及既有 build pipeline 內的 source＋generated output 更新。

### 只有出現具體疑慮時才停在 PR／candidate

下列任一情況存在時，才停止自動 merge／Production 並等待使用者確認：

- 第一手／官方來源不足、來源互相衝突、日期／金額／狀態等公開事實仍無法可靠確認。
- build、test、CI、browser／Accessibility QA 失敗，或出現無法合理解釋的 warning、generated diff、console error、broken link。
- diff 超出原需求、修改到明確不修改範圍，或 blast radius／rollback 風險無法可靠判斷。
- 涉及個資、credential、權限、法律／著作權、未公開資料或其他安全與公開邊界疑慮。
- 全站重設計、資訊架構、資料模型、build／deployment architecture、自訂網域／DNS／Cloudflare、CMS、backend、database、analytics、auth、大量 URL／SEO migration 等重大變更，且使用者尚未在該任務中明確授權其範圍與 production 影響。
- Production Verification 顯示部署後異常，需先 rollback、修正或進一步診斷。

若只是一般例行修改且上述疑慮都不存在，**不得因「尚未另外取得部署確認」而停在 PR；應直接完成發布。**

重大變更並非永久禁止部署；若使用者已明確授權該重大變更的範圍與 production 影響，且 migration／SEO／rollback／安全與測試均已處理，則可依該授權完成部署。

資安事件、credential exposure、個資事件的 containment／rotation／刪除 evidence 仍依獨立安全授權邊界，不因本預設部署授權而自動執行高風險外部操作。

## Production Verification 狀態用語

- **未部署**：尚未 merge `main`。
- **Deployment pending**：已 merge，但 Pages 尚未完成。
- **Deployment failed**：source 已進 `main`，Pages deployment 失敗。
- **已部署待驗證**：Pages success，但尚未直接驗證 production 關鍵頁／修改點。
- **已部署並驗證**：`main`、CI、Pages 與 production 關鍵修改點均已確認。

不得把 Pages success 單獨寫成「Production Verification Passed」。若目前工具無法可靠讀取 live body，應明確標示「已部署待驗證」。

## 回滾

發布前記錄上一個已驗證的 `main` commit。

若 production 發生重大錯誤：

1. 先確認問題是否來自最新 release。
2. 優先以 Git history revert／回滾至上一個已驗證 commit，恢復服務。
3. 在新 branch 修正問題並重新測試。
4. 不在 production 直接進行無版本紀錄的熱修。
5. 不使用 Drive 舊 `index.html` 覆蓋 GitHub `main`。

## Release 最低紀錄

每個正式 release 至少應保存：

- 日期／時間（Asia/Taipei）
- commit SHA
- 變更摘要
- 資料來源／核驗狀態
- 測試結果
- 已知風險
- 是否已部署 production
- 可回滾 commit
- Drive release artifact 位置（若本次執行正式 release／收尾）

最後更新：2026-09-11。
