# 部署、發布與回滾

## Production

- 平台：GitHub Pages
- Repository：`Hong1998tw/chen-huiwen-website`
- Production branch：`main`
- Production URL：`https://hong1998tw.github.io/chen-huiwen-website/`

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
7. 以 Pull Request review 重大內容／版面／資料變更。
8. 合併至 `main` 後，由 GitHub Pages 發布。
9. 部署完成後重新檢查 production，而不是只確認 GitHub commit 成功。
10. 將 release artifact、commit SHA、測試摘要歸檔至 Google Drive `03_releases/`；重大決策或流程變更再更新 Notion。

## 發布安全線

未取得明確「發布／部署／上線／合併至 production」指令時：

- 可以建立 branch、candidate、preview、PR。
- 不直接以 Drive 檔案覆蓋 `main`。
- 不刪除 production 檔案。
- 不將尚未驗證的 AI 推論寫入公開網站。

## 回滾

發布前記錄上一個已驗證的 `main` commit。

若 production 發生重大錯誤：

1. 先確認問題是否來自最新 release。
2. 優先回滾至上一個已驗證 commit，恢復服務。
3. 在新 branch 修正問題並重新測試。
4. 不在 production 直接進行無版本紀錄的熱修。

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
- Drive release artifact 位置

最後更新：2026-09-08。
