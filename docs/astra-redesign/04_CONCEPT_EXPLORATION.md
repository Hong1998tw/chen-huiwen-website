# Concept exploration and reality filter

20 distinct theses before implementation: 5 mature, 5 reframed, 5 experimental, 5 additional wild.

Common mobile/accessibility contract for every candidate: 390px single-column text fallback; semantic headings, keyboard equivalents, named controls, reduced motion; map/3D never sole access. For immersive concepts this fallback loses their distinctive value, which is a rejection cost.

## 01 市民服務台（成熟）
Core Idea / Differentiation: 先完成聯絡／預約／反映，以需求目錄作網站主體。

Primary User: 辦事市民。Primary Job: 先完成聯絡／預約／反映。Homepage: 三種服務入口。Navigation: 需求目錄。Signature: 準備事項→既有入口。

Existing Data: 服務頁與電話。Required New Data: 無。Geography: 輔助。Map: 非必要。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；準備事項→既有入口須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 低。Maintenance: 低。Risk: 不可承諾回覆期限。Do NOT build: 不做案件後台。

## 02 鳳山公共索引（成熟）
Core Idea / Differentiation: 找道路或學校，以搜尋與主題作網站主體。

Primary User: 一般讀者。Primary Job: 找道路或學校。Homepage: 大搜尋＋公開專題。Navigation: 搜尋與主題。Signature: 搜尋直達來源。

Existing Data: search-index。Required New Data: 無。Geography: 篩選。Map: 可選。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；搜尋直達來源須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 低。Maintenance: 低。Risk: 搜尋涵蓋範圍須清楚。Do NOT build: 不造AI答案。

## 03 地方工作日誌（成熟）
Core Idea / Differentiation: 查最新進度，以時間作網站主體。

Primary User: 固定讀者。Primary Job: 查最新進度。Homepage: 依內容更新列專題。Navigation: 時間。Signature: 日期對照。

Existing Data: updated/history。Required New Data: 無。Geography: 標籤。Map: 輔助。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；日期對照須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 低。Maintenance: 低。Risk: 更新不等於事件發生。Do NOT build: 不混日期語意。

## 04 公開資料書架（成熟）
Core Idea / Differentiation: 找原文，以來源類型作網站主體。

Primary User: 研究者。Primary Job: 找原文。Homepage: 議會／新聞／來源索引。Navigation: 來源類型。Signature: 一頁跳到來源。

Existing Data: sources/council-records。Required New Data: 無。Geography: 低。Map: 無。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；一頁跳到來源須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 低。Maintenance: 低。Risk: 來源可能失效。Do NOT build: 不鏡像私人文件。

## 05 口袋服務站（成熟）
Core Idea / Differentiation: 快速聯絡，以單欄任務作網站主體。

Primary User: 手機市民。Primary Job: 快速聯絡。Homepage: 電話＋律師時間表。Navigation: 單欄任務。Signature: 大觸控連結。

Existing Data: 既有服務資訊。Required New Data: 無。Geography: 地址。Map: 外部導航。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；大觸控連結須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 低。Maintenance: 低。Risk: 單一服務忽略公共資料。Do NOT build: 不做只剩CTA的首頁。

## 06 鳳山公共資訊誌（重定義）
Core Idea / Differentiation: 從生活議題找到完整紀錄，以任務與編輯索引作網站主體。

Primary User: 市民與查資料者。Primary Job: 從生活議題找到完整紀錄。Homepage: 搜尋＋地方專題＋服務欄。Navigation: 任務與編輯索引。Signature: 地方→進度→原文。

Existing Data: 公開專題與搜尋索引。Required New Data: 無。Geography: 重要但非必要。Map: 文字與地圖平等。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；地方→進度→原文須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 中。Maintenance: 低。Risk: 需避免把專題選取當排名。Do NOT build: 不設政績總分。

## 07 一里的資訊入口（重定義）
Core Idea / Differentiation: 看自己生活圈，以地點作網站主體。

Primary User: 知道里名的市民。Primary Job: 看自己生活圈。Homepage: 里名選擇。Navigation: 地點。Signature: 跨內容里別探索。

Existing Data: villages/explore。Required New Data: 無。Geography: 核心。Map: 可選。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；跨內容里別探索須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 中。Maintenance: 中。Risk: 無里別政策易被忽略。Do NOT build: 不要求定位。

## 08 證據閱讀器（重定義）
Core Idea / Differentiation: 追溯一句主張，以主張與來源作網站主體。

Primary User: 查核者。Primary Job: 追溯一句主張。Homepage: 來源目錄。Navigation: 主張與來源。Signature: 原文與歷程並讀。

Existing Data: sources/history。Required New Data: 逐句關聯需新審核。Geography: 低。Map: 可選。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；原文與歷程並讀須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 高。Maintenance: 高。Risk: 既有來源非逐句mapping。Do NOT build: 不自動宣稱查核通過。

## 09 城市議題路徑（重定義）
Core Idea / Differentiation: 追同題不同內容，以主題網路作網站主體。

Primary User: 關心政策者。Primary Job: 追同題不同內容。Homepage: 五大議題。Navigation: 主題網路。Signature: 政績×新聞×歷史政見。

Existing Data: explore/search。Required New Data: 無。Geography: 輔助。Map: 可選。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；政績×新聞×歷史政見須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 中。Maintenance: 低。Risk: 不把政見當成果。Do NOT build: 不合併內容來源類型。

## 10 公共進度檔案（重定義）
Core Idea / Differentiation: 理解前後變化，以年度與專題作網站主體。

Primary User: 長期關注者。Primary Job: 理解前後變化。Homepage: 歷程入口。Navigation: 年度與專題。Signature: 穩定錨點的時間軸。

Existing Data: history/related。Required New Data: 無。Geography: 背景。Map: 輔助。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；穩定錨點的時間軸須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 中。Maintenance: 中。Risk: 史料精度不同。Do NOT build: 不補造日/月。

## 11 雙窗地方閱讀（實驗）
Core Idea / Differentiation: 地圖和原文對照，以空間作網站主體。

Primary User: 桌面研究者。Primary Job: 地圖和原文對照。Homepage: 地圖＋文章雙窗。Navigation: 空間。Signature: 同地點同步閱讀。

Existing Data: coordinates/detail。Required New Data: 無。Geography: 核心。Map: 核心。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；同地點同步閱讀須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 高。Maintenance: 中。Risk: 390px需回到單欄。Do NOT build: 不硬塞雙窗到手機。

## 12 問題關係圖（實驗）
Core Idea / Differentiation: 找相鄰議題，以關係作網站主體。

Primary User: 研究者。Primary Job: 找相鄰議題。Homepage: 互動節點。Navigation: 關係。Signature: 點節點看相關案。

Existing Data: related。Required New Data: 邊語意需補。Geography: 可選。Map: 無。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；點節點看相關案須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 高。Maintenance: 高。Risk: 關聯不代表因果。Do NOT build: 不自造因果關係。

## 13 年度城市切片（實驗）
Core Idea / Differentiation: 看某年曾發生什麼，以時間作網站主體。

Primary User: 地方歷史讀者。Primary Job: 看某年曾發生什麼。Homepage: 年度滑桿。Navigation: 時間。Signature: 年份切片地圖。

Existing Data: history/coordinates。Required New Data: 逐年geometry缺。Geography: 核心。Map: 核心。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；年份切片地圖須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 高。Maintenance: 高。Risk: 容易誤把代表點當當年位置。Do NOT build: 不補推斷地理。

## 14 離線公共手冊（實驗）
Core Idea / Differentiation: 離線讀來源摘要，以文件作網站主體。

Primary User: 網路不穩市民。Primary Job: 離線讀來源摘要。Homepage: 可列印索引。Navigation: 文件。Signature: 列印友善專題。

Existing Data: static pages。Required New Data: 無。Geography: 文字。Map: 外部。3D: 無。AI: 無。

Mobile: 單欄、先入口後詳情；列印友善專題須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 中。Maintenance: 中。Risk: 離線易過時。Do NOT build: 不快取私人表單。

## 15 自然語言資料導航（實驗）
Core Idea / Differentiation: 以問題找資料，以自然語言作網站主體。

Primary User: 不熟關鍵字者。Primary Job: 以問題找資料。Homepage: 問句輸入。Navigation: 自然語言。Signature: 帶原文回答。

Existing Data: search-index。Required New Data: 可信推理服務缺。Geography: 輔助。Map: 無。3D: 無。AI: 有。

Mobile: 單欄、先入口後詳情；帶原文回答須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 高。Maintenance: 高。Risk: 幻覺與維護。Do NOT build: 不建政治說服AI。

## 16 3D鳳山數位分身（Wild）
Core Idea / Differentiation: 理解體量與高度，以三維作網站主體。

Primary User: 空間規劃讀者。Primary Job: 理解體量與高度。Homepage: 可旋轉城市。Navigation: 三維。Signature: 街廓模型。

Existing Data: 僅點位。Required New Data: 測量geometry大量缺。Geography: 核心。Map: 核心。3D: 核心。AI: 無。

Mobile: 單欄、先入口後詳情；街廓模型須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 極高。Maintenance: 極高。Risk: 假精度、裝置負擔。Do NOT build: 無真實模型不做。

## 17 時空捲動長卷（Wild）
Core Idea / Differentiation: 理解多年變化，以時間作網站主體。

Primary User: 深度讀者。Primary Job: 理解多年變化。Homepage: 全螢幕滾動故事。Navigation: 時間。Signature: scroll連动地圖。

Existing Data: history/photos。Required New Data: 各期素材缺。Geography: 核心。Map: 核心。3D: 可選。AI: 無。

Mobile: 單欄、先入口後詳情；scroll連动地圖須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 高。Maintenance: 高。Risk: 暈動／無障礙。Do NOT build: 不scroll劫持。

## 18 來源星圖（Wild）
Core Idea / Differentiation: 追來源與機關網路，以graph作網站主體。

Primary User: 資料研究者。Primary Job: 追來源與機關網路。Homepage: 力導向圖。Navigation: graph。Signature: 關係群集。

Existing Data: sources/related。Required New Data: 權威實體表缺。Geography: 低。Map: 無。3D: 無。AI: 可選。

Mobile: 單欄、先入口後詳情；關係群集須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 高。Maintenance: 高。Risk: 密集圖難懂。Do NOT build: 不製造機關關係。

## 19 街頭AR資料窗（Wild）
Core Idea / Differentiation: 現地看建設紀錄，以定位作網站主體。

Primary User: 路過市民。Primary Job: 現地看建設紀錄。Homepage: 相機疊圖。Navigation: 定位。Signature: 現地標記。

Existing Data: 代表點。Required New Data: 精準定位與模型缺。Geography: 核心。Map: 核心。3D: 核心。AI: 無。

Mobile: 單欄、先入口後詳情；現地標記須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 極高。Maintenance: 極高。Risk: 隱私與定位誤差。Do NOT build: 不啟動相機定位。

## 20 公開承諾模擬器（Wild）
Core Idea / Differentiation: 比較政策結果，以假設作網站主體。

Primary User: 政策讀者。Primary Job: 比較政策結果。Homepage: 情境滑桿。Navigation: 假設。Signature: 模擬結果。

Existing Data: 只有文字史料。Required New Data: 因果模型缺。Geography: 可選。Map: 可選。3D: 可選。AI: 有。

Mobile: 單欄、先入口後詳情；模擬結果須有連結或文字替代。Accessibility: 依上述共同契約，沉浸式操作不得成為唯一入口。Technical complexity: 極高。Maintenance: 極高。Risk: 假因果與說服。Do NOT build: 不生成政策效果數字。

## Reality filter

Criteria: user value, clarity, service utility, data availability, factual integrity, privacy, mobile, accessibility, performance, maintainability, SEO, feasibility, sustainability, visual distinction, editorial cost. 0=unacceptable, 1=high cost, 2=viable, 3=strong. Scores are product judgments, not user-research findings.

| Family | Value/clarity/service | Data/truth/privacy | Mobile/a11y/perf | Maintain/SEO/feasible | Sustainable/distinct/editorial | Decision |
|---|---|---|---|---|---|---|
| 01–05 | 3/3/3 | 3/3/3 | 3/3/3 | 3/3/3 | 3/1/3 | Useful components, incomplete overall identity |
| 06 | 3/3/3 | 3/3/3 | 3/3/3 | 3/3/3 | 3/3/3 | SELECT: coherent service + public reading product |
| 07 / 09 / 10 | 3/2/2 | 3/3/3 | 3/3/3 | 3/3/3 | 3/2/3 | Integrate place/topic/history routes, not separate products |
| 08 / 12 / 13 | 2/2/1 | 1/1/3 | 2/2/2 | 1/2/2 | 1/3/1 | Hold for curated data/claim mapping |
| 11 / 14 | 2/2/2 | 3/3/3 | 2/2/2 | 2/3/3 | 2/2/2 | Adopt list/map choice and print styling only |
| 15 | 2/2/2 | 1/1/2 | 2/2/1 | 1/2/1 | 1/2/1 | Reject, ordinary local search meets job |
| 16–20 | 1/1/1 | 0/0/1 | 1/1/0 | 0/1/0 | 0/3/0 | Reject: unavailable data, high cost, low service return |

3D gate: existing coordinates cannot explain volume/height; 2D + lists clearer; no factual geometry, mobile/a11y/performance cost unjustified. AI gate: deterministic local index sufficient; no provider, account, prompt or generated political answers needed.
