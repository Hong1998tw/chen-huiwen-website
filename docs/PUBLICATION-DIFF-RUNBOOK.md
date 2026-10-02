# 官網待同步差異清單

`scripts/report_publication_diff.py` 比對完整、具時間戳的 Notion、CMS、GitHub main 與正式站快照。程式只讀輸入、寫指定的本地報表；沒有 app 呼叫、publisher、PR／merge／部署、D1 寫入、Notion 修改或通知功能。

它回答「哪些還沒對齊」以及「哪些需要工程判斷」，不授予發布權限。沒有完整讀回或候選內容證據時回傳 BLOCKED，不能把空清單當成全部同步。

## 執行

```sh
python3 scripts/report_publication_diff.py \
  --snapshot /path/to/four-source-snapshot.json \
  --previous-report /path/to/previous-valid-report.json \
  --output /path/to/current-report.json
```

初次執行省略 `--previous-report`。Exit 0 = OK，1 = DIFFERENCES，2 = BLOCKED；n8n 應解析 JSON 與 exit code，不能把 1 當作執行器崩潰。`--at` 只供帶時區的歷史重播，不能把重播寫成新的正式讀回。

## 四來源快照契約

最外層為 `schemaVersion: 1` 與 `notion`、`cms`、`github`、`live`。每個來源必須有帶時區的 `observedAt` 和 `complete: true`。預設只接受最近4小時的讀取；這是採集時間，與資料最後同步時間不同。

- `notion.rows`：原生查詢結果，範圍為使用者明確勾選「要求發布」的列。原生 SQL checkbox 值為 `__YES__`，不得以 `=1` 查詢後把空結果當成無請求。可以傳完整列集合；程式只處理 `__YES__`／true。每列需唯一「網站 ID」，及「政績標題」「摘要」「公開敘事」「敘事狀態」「證據狀態」「發佈疑慮判讀」。公開敘事以空白行分段；只正規化 NFC、CRLF 與 Notion 的 br 分隔。`expected` 可代替三個公開欄位，並明列實際比較的其他公開欄位。只有「可發布」而未要求發布者不進清單。
- `cms.pages`：完整 `published_pages` 的 path、title、source_path、source_kind、editor_scope；commit_sha／observed_at 可保留作證據。逐頁取完、核總數與唯一 path 才設 complete。工具截斷標記、重複或缺漏不可忽略。
- `cms.sources`：完整 `published_sources` 的 domain、record_key、source_hash；比對原有內容 hash，不把不同 commit label 或時間戳當成新內容。
- `cms.publications`／`cms.pagePublications`：完整請求歷史的 domain＋record_key 或 path、version、status。各 stable key 只判斷最新版本；更早失敗不重送、不加入待同步。deployed／verified／no_change 是歷史終態，message 的 PENDING 不代表一筆新發布請求。
- 最新 queued／processing／pr_created／merged／failed 須另有經唯讀候選比較取得的 `desiredHash`；頁面還需 `canonicalHash`。沒有這項證據則列為 comparison blocker，不假定內容一定不同，也不直接重跑。可沿現役 publisher 的 prepare 比對契約取得證據，不能加第二套 publisher。
- `github`：repository 固定 `Hong1998tw/chen-huiwen-website`，ref 固定 `refs/heads/main`，commitSha 為 fresh-read 的遠端 main。records 為該 immutable revision 的 data/achievements.json，publicRecords 為同版公開投影；pages 來自 page_authority.catalog，sources 來自既有 publish_from_cms.sources；release 為同版公開 artifact 的 deployment.json。候選 branch 不能冒充 canonical。採集器須證明 checkout／資料與 fresh 遠端 main 相符。
- `live`：baseUrl 固定 `https://www.huiwen.tw/`，httpStatus 為真實讀取狀態，release 為直接 GET deployment.json，records 為直接 GET data/achievements-public.json。收據與集合筆數須相符；不可從 GitHub 複製 records 當作 live，也不使用搜尋快取。

程式輸出欄位差異與內容 hash，不複製候選正文、內部備註或 CMS message。對齊結果只覆蓋提供的 expected 欄位及公開投影；不聲稱完成未包含的人工查核。

## 分流與低頻調度

`needsCodex=true` 用於審定後需要受控 PR 的新內容／來源差異，或正式站版本／內容 drift。`false` 用於先做原生審定、完成 Notion 收據、讓現役 publisher 對齊 CMS 目錄／快取，及由現役流程處理已核候選。無法判讀的讀取／比較障礙以 blocker 單列；不自動公開未審定條目。

n8n 後續可用既有可靠的唯讀連接採集四份快照，再呼叫此比較核心；低頻 cadence 另由 owner 設定。本變更未建立／啟用排程，也未新增憑證或權限。每次成功完整比對都保存最新有效報表；BLOCKED 時保留前次有效報表。

`newDifferences` 用內容 fingerprint 與上次有效清單去重，不含時間戳造成的噪音。通知限使用者本人，僅在已核可靠收件通道與 recipient 後才另接；沒有通道就回報需要設定，不能改接任何群組。這個核心不發送訊息。

## 驗證

```sh
python3 -m unittest discover -s tests -p test_publication_diff.py
```

回歸涵蓋原生 checkbox、未審定請求、canonical／live 真差異、純收據回填、四筆失敗被高版 deployed 取代、最新失敗／未知候選、資料截斷／重複／過期、錯誤 provider／HTTP 及通知去重。實際四方 sample 應另保存在內部工作區，不把 Notion 候選或 CMS 請求資料提交到公開 repo。
