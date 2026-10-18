# 官網維護索引

GitHub `main` 是程式碼、內容 source、build 與 generated output 的正本；現役 Production 為 Cloudflare Static Assets。本頁只提供維護入口。`DEPLOYMENT.md` 保留較早的 Pages 操作與回滾記錄；一般發布以 [Cloudflare public migration](CLOUDFLARE-PUBLIC-MIGRATION.md) 為準，Pages workflow 僅供手動回復。

## 改內容

1. 先依[內容來源與公開邊界](CONTENT-SOURCES.md)核對第一手來源、事實狀態及可公開範圍。
2. 依[Canonical Source](CANONICAL-SOURCE.md)與[維護操作](MAINTENANCE.md)找到可編輯 source；不要直接改 generated output。
3. 使用 Python 3.12+；需要重建產物時，從 repository root 執行 `python3 scripts/build_all.py`，再執行 `python3 scripts/quality.py --baseline-ref origin/main`。
4. 審查 source 與 generated diff，依[發布前測試清單](TEST-CHECKLIST.md)完成本次變更適用的項目。
5. 內容 owner／CMS 的送審及正式發布，接續下方[發布](#發布)流程。

## 改版面

1. 依[Canonical Source](CANONICAL-SOURCE.md)確認應改的 template、CSS、JavaScript 或元件 source。
2. 遵循[維護操作的視覺與互動規格](MAINTENANCE.md)，保留現有設計 tokens、鍵盤操作及 reduced-motion 行為。
3. 從 repository root 執行 `python3 scripts/quality.py --baseline-ref origin/main --browser`。
4. 依[發布前測試清單](TEST-CHECKLIST.md)檢查受影響的桌面、行動版、互動及無障礙項目，並審查完整 diff。
5. 通過必要檢查後，接續下方[發布](#發布)流程。

## 發布

1. 以最新 `main` 為基底開 branch；完成適用的 build、quality、測試與 diff 審查。
2. PR 必須通過既有 required checks 與 publication path guard；不得繞過 [publication-path-guard workflow](../.github/workflows/publication-path-guard.yml) 或品質 Gate。
3. 內容 owner 使用既有 CMS／PR 流程；合併後依現行 Cloudflare 契約發布，詳見 [Cloudflare public migration](CLOUDFLARE-PUBLIC-MIGRATION.md)。
4. Cloudflare Builds 依契約執行 quality、`scripts/build_cloudflare_public.py` 與 `wrangler.public.jsonc` 指定的 pinned Wrangler；[cloudflare-public workflow](../.github/workflows/cloudflare-public.yml) 核對 Production 上的同一 source SHA 與 artifact digest，產生 delivery receipt。
5. delivery receipt 成功後，[production verification workflow](../.github/workflows/production-verification.yml) 對同一 SHA 執行 live 驗證。
6. 只有同 SHA 的 delivery receipt 與 Production Verification 均成功並完成讀回，才記為「已部署並驗證」；`DEPLOYMENT.md` 內較早的 Pages 發布描述不代表現行路徑。

## 出事回復

1. 先比對目前 `main` SHA、live `deployment.json`、delivery receipt 與 Production Verification，定位異常所在階段。
2. 依[現行部署契約](DEPLOYMENT.md)及[Cloudflare 回復流程](CLOUDFLARE-PUBLIC-MIGRATION.md)分類 build、delivery、live 或 hosting 路由問題。
3. 內容或版面回退以 reviewed PR 修正 canonical source，保留公開白名單與既有安全 Gate，再重跑適用檢查。
4. 緊急 hosting rollback 僅依既有授權採用已驗證的前一 hostname route；後續以 reviewed PR 對齊 `data/deployment-target.json` 與 delivery／verification workflow。
5. Pages workflow 是手動回復工具；Pages 成功不等於 Cloudflare receipt。不可用舊 HTML 覆蓋 source，也不可停用 Access／WAF 取得假通過。
6. 若症狀在 edge，參照[Cloudflare edge runbook](CLOUDFLARE-EDGE-RUNBOOK.md)，並以當前 native runtime 狀態確認，不把歷史快照當現況。
