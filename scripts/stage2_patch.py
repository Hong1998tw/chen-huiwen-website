#!/usr/bin/env python3
"""Temporary Stage 2 migration patch. Remove before merge."""
from pathlib import Path
import json
import re

R = Path(__file__).resolve().parents[1]
TODAY = "2026-09-09"
DATA = R / "data" / "achievements.json"
items = json.loads(DATA.read_text(encoding="utf-8"))
byid = {item["id"]: item for item in items}


def update_case(case_id, *, summary, paragraphs, history, sources, notes=None,
                status="持續追蹤", budget=None, related=None, verification_content=None,
                attribution=None, editorial_paragraphs=None):
    c = byid[case_id]
    c["summary"] = summary
    c["paragraphs"] = paragraphs
    c["history"] = history
    c["sources"] = sources
    c["status"] = status
    c["updated"] = TODAY
    c["verifiedAt"] = TODAY
    if budget is not None:
        c["budget"] = budget
    if related is not None:
        c["related"] = related
    if notes is not None:
        c["notes"] = notes
    v = c.setdefault("verification", {})
    v["checkedAt"] = TODAY
    v["content"] = verification_content or "已依最新可查官方資料核驗本頁公開敘述"
    if attribution is not None:
        v["attribution"] = attribution
    er = c.setdefault("editorialReview", {})
    er["summary"] = summary
    er["paragraphs"] = editorial_paragraphs or paragraphs
    er["history"] = history


# Step 2-1｜特教復康巴士與校園照護
special_summary = (
    "高雄市政府教育局執行情形報告確認，4所特殊學校重症身障學生自114學年度第2學期起，"
    "經教育局審查後改為覈實補助復康巴士搭乘費；成功特教與高雄特教各增置1名專案護理師，"
    "兩校均已完成甄選正取1名，並可依需求申請專案時薪制特教助理員。"
)
special_paragraphs = [
    "交通補助已由『每月800至1,000元』提高為覈實補助復康巴士搭乘費，適用對象是4所特殊學校中重症、搭乘復康巴士的身心障礙學生，並須經高雄市政府教育局審查；這不是所有復康巴士使用者一律無條件全額補助。實施時間為114學年度第2學期起。",
    "校園醫療人力部分，市府核定增置2名約聘專案護理師，成功特殊教育學校於2025年12月9日、高雄特殊教育學校於2026年1月22日辦理甄選，兩校均正取1名，官方執行情形已明載『已完成專案護理師聘用』。",
    "特教助理員部分，成功特教與高雄特教除既有每班1名教師助理員外，可依學生障礙程度及需求申請專案時薪制特教助理員，經費由教育局補助；助理員可協助生活自理、移動、課堂與偶發事件處理，但依法不得執行侵入性醫療行為。",
    "本案主辦機關為高雄市政府教育局。教育局依特殊教育諮詢會及行政支持網絡機制，視需求協調衛生局、社會局、勞工局、交通局及其他目的事業主管機關支援。依2026年3月3日市府回覆，復康巴士補助、專案護理師與專案時薪教助等措施均已有具體執行情形。"
]
special_history = [
    {"date": "2025-10-31", "title": "函頒特教醫療輔助照護試辦計畫", "text": "教育局函頒特殊教育學校醫療輔助行為照護試辦實施計畫，建立醫學評估、跨專業會議及安置支持機制。"},
    {"date": "2025-12-09", "title": "成功特教專案護理師甄選", "text": "成功特殊教育學校辦理專案護理師甄選；官方執行情形報告後續確認正取1名。"},
    {"date": "2026-01-22", "title": "高雄特教專案護理師甄選", "text": "高雄特殊教育學校辦理專案護理師甄選；官方執行情形報告後續確認正取1名。"},
    {"date": "114學年度第2學期", "title": "復康巴士改採覈實補助", "text": "4所特殊學校重症搭乘復康巴士的身心障礙學生，經教育局審查後，由原每月800至1,000元交通補助提高為覈實補助復康巴士搭乘費。"},
    {"date": "2026-03-03", "title": "市府正式回覆執行情形", "text": "市府以高市府教特字第11531478400號回覆議會，確認專案護理師、專案時薪教助、跨局處支援及復康巴士覈實補助等執行情形。"}
]
special_sources = [
    {
        "title": "高雄市議會第4屆第6次定期大會議員提案執行情形報告表｜教育類第026號",
        "url": "https://cissearch.kcc.gov.tw/Upload/Attachment/BusinessReport/1701/05be06eb-76bd-4c32-8a63-997a2884c635.pdf",
        "sourceType": "高雄市議會／市府第一手資料",
        "sourceDate": "2026-03-03"
    }
]
update_case(
    "special-education-support",
    summary=special_summary,
    paragraphs=special_paragraphs,
    history=special_history,
    sources=special_sources,
    notes=[
        "『覈實補助』限官方報告所載4所特殊學校之重症、搭乘復康巴士身障學生，且須經教育局審查；不應擴張解讀為全市所有復康巴士使用者一律全額補助。",
        "本頁以2026-03-03議會提案執行情形報告作為是否正式執行的主要判斷依據。"
    ],
    verification_content="已核驗：教育類第026號市府執行情形，含交通補助、護理師、教助員與跨局處機制",
    attribution="主辦機關為高雄市政府教育局；議員提案與追蹤事實有官方議會資料支持"
)

# Step 2-2｜八德滯洪池：不同金額、期程、進度使用不同口徑
bade_summary = (
    "截至2026年9月9日，最新可查水利局更新顯示八德滯洪公園總經費8,350萬元、總滯洪量約4.7萬噸，"
    "池內開挖及入流渠道已完成並具階段性防汛功能，但尚未查到正式完工公告。7,289萬元是原工程採購決標金額，"
    "與水利局所稱『工程總經費』不是同一口徑；2026年8月另有第一次變更設計690萬元決標。"
)
bade_paragraphs = [
    "8,350萬元與7,289萬元不是同一個會計／採購口徑。高雄市政府水利局2025年10月20日及2026年7月10日公開說明皆以『總經費8,350萬元』描述整體工程；7,289萬元則是原工程採購的決標金額。網站不再把7,289萬元誤寫成唯一『工程總經費』。",
    "2026年8月11日另有『第一次變更設計』採購決標690萬元。公開採購摘要同時出現契約變更累計金額等欄位，不能只把690萬元直接加到7,289萬元，就推定為變更後契約總價；在取得完整契約價金明細前，本頁只分別呈現原始決標、變更設計決標與水利局總經費三種口徑。",
    "完工期程也曾更新。水利局2025年10月20日新聞稿原預計2026年10月底完工；其後2025年12月及2026年4月工程動態改列預計2026年9月。到2026年7月10日，官方最新進度是『已完成池內開挖及入流渠道設置，具備階段性防汛功能』，並未宣告全案完工。2026年8月的第一次變更設計採購履約期估計延伸至2027年1月，但該日期不等同於整體工程完工日，因此仍以官方正式完工公告作最後認定。",
    "滯洪量方面，水利局公開資料一致以總滯洪量約4.7萬噸說明。工程完工後將在洪峰期間導入建國路雨水下水道系統水量進入滯洪池調節，降低建國路沿線積淹水與下游排水負荷。"
]
bade_history = [
    {"date": "2025-09", "title": "原工程採購決標", "text": "原『高雄市鳳山區八德滯洪公園新建工程』採購決標金額為7,289萬元；此數字是工程採購決標口徑，不等同水利局後續公開所稱整體工程總經費。"},
    {"date": "2025-10-20", "title": "水利局公布工程總經費與原定期程", "text": "水利局說明總經費8,350萬元、2025年10月1日開工、總滯洪量約4.7萬噸，當時預計2026年10月底完工。"},
    {"date": "2026-04-02", "title": "工程進度38.71％", "text": "水利局工程動態記載進度38.71％，土方開挖47,415／52,353立方公尺，並將預計完工時間列為2026年9月。"},
    {"date": "2026-07-10", "title": "已具階段性防汛功能", "text": "水利局說明池內開挖及入流渠道已完成，總滯洪量約4.7萬噸，工程已具階段性防汛功能，但未宣告全案完工。"},
    {"date": "2026-08-11", "title": "第一次變更設計決標", "text": "政府採購公開資料鏡像記載第一次變更設計決標金額690萬元；此金額不直接視為原決標價的單純追加，也不據此推算全案最終契約總價。"}
]
bade_sources = [
    {
        "title": "高雄市政府水利局｜八德滯洪公園開工說明（2025-10-20）",
        "url": "https://wrb.kcg.gov.tw/ActivitiesDetailC001100.aspx?Cond=2afb5f34-d4d0-48c2-8f7a-7633695e3f4f",
        "sourceType": "高雄市政府第一手資料",
        "sourceDate": "2025-10-20"
    },
    {
        "title": "高雄市政府水利局｜工程動態（2026-04-02）",
        "url": "https://wrb.kcg.gov.tw/ActivitiesDetailC001200.aspx?Cond=92a21210-7637-4b43-82d5-06ced2963f12",
        "sourceType": "高雄市政府第一手資料",
        "sourceDate": "2026-04-02"
    },
    {
        "title": "高雄市政府水利局｜颱風前工程與防汛整備（2026-07-10）",
        "url": "https://wrb.kcg.gov.tw/ActivitiesDetailC001100.aspx?Cond=8c321691-3b0a-4870-9a46-cc877d2e9739",
        "sourceType": "高雄市政府第一手資料",
        "sourceDate": "2026-07-10"
    },
    {
        "title": "政府電子採購公開資料鏡像｜B1140806-1 第一次變更設計",
        "url": "https://cf.ezbid.tw/detail/3.97.25/B1140806-1",
        "sourceType": "政府採購公開資料鏡像（用於契約口徑交叉核對）",
        "sourceDate": "2026-08-13"
    }
]
update_case(
    "bade-detention",
    summary=bade_summary,
    paragraphs=bade_paragraphs,
    history=bade_history,
    sources=bade_sources,
    notes=[
        "8,350萬元＝水利局公開所稱工程總經費；7,289萬元＝原工程採購決標金額；690萬元＝第一次變更設計決標金額。三者不可當成同一欄位互相取代。",
        "截至2026-09-09未查到水利局正式完工公告，因此維持『持續追蹤』，不標示完成。",
        "2026-08第一次變更設計的履約期不等於整體工程完工期。"
    ],
    budget="總經費8,350萬元（水利局口徑）；原工程決標7,289萬元；第一次變更設計決標690萬元（2026-08-11）",
    verification_content="已核驗：水利局總經費／滯洪量／最新階段性防汛進度；採購金額分開呈現",
    attribution="水利局工程事實為第一手資料；採購變更金額以公開採購資料鏡像交叉核對"
)

# Step 2-3｜鳳山車站整合專題：新增 generated overview，並補強既有細分頁
station_related = ["rail-greenway", "metro-green-line", "station-parking", "station-design", "station-walkway"]
overview = {
    "id": "fengshan-station-overview",
    "title": "鳳山車站整合專題",
    "summary": "鳳山車站重建不只是站體工程，也牽動捷運銜接、曹公圳水岸、站前步行、停車接送、鐵路綠園道與公民參與。本頁把超過15年的工程監督、公共討論與目前仍在推進的站城整合議題放在同一條時間軸上。",
    "categories": ["交通與基建", "環境與綠地", "經濟與產業", "教育與文化"],
    "villages": [],
    "villageMethod": "跨站區整合專題，不以單一里界代表受益範圍",
    "scope": "跨里建設",
    "district": "鳳山區",
    "status": "持續追蹤",
    "coordinates": [22.63109, 120.35769],
    "locationName": "鳳山車站",
    "locationNote": "鳳山車站僅作專題代表點；本專題涵蓋車站、曹公圳、周邊道路與綠園道，不代表單一工程範圍",
    "published": None,
    "updated": TODAY,
    "budget": "",
    "paragraphs": [
        "鳳山車站的公共議題跨越站體、都市設計、交通轉乘與舊城再生。早期關注集中在鐵路地下化延伸鳳山後的施工品質與車站規劃；2010年代多次公共討論則把鳳山意象、曹公圳、周邊土地、行人空間與大眾運輸納入同一張城市藍圖。",
        "火車站與公民參與：2018年的鳳山車站整體規劃與設計公聽會，已出現『車站與曹公圳不應被道路切割』『車站周邊應建立整體開發模式』等在地意見。這些紀錄可證明地方長期要求車站不只是一座建築，而是鳳山舊城與新交通系統的城市節點。",
        "停車與接送：第4屆第4次定期大會交通類第49號提案要求改善鳳山車站停車場票卡、車牌辨識、空位指示、接送區與行人動線。市府辦理情形也說明車站周邊停車供給、南側道路臨停接送空間與臺鐵設施設備協調狀況，這些屬於可持續追蹤的站區交通治理。",
        "曹公圳、站前步行與綠園道：目前細分頁分別追蹤鳳山車站至捷運O12軸線、曹公圳周邊步行空間，以及鐵路地下化後綠園道的『最後一哩』。2026年議會提案亦持續要求跨局處盤點站前綠色廊道阻斷與產權問題。",
        "捷運青線：『讓捷運青線進入／銜接鳳山車站』目前屬持續倡議與交通整合方向；本次查核未把它改寫成已核定興建或已完成工程。後續如捷運局完成正式可行性研究、路線核定或中央程序，才會更新為相應階段。",
        "空中鳳城與生活機能：車站上方聯合開發與招商涉及臺鐵、市府及市場條件。議會公開提案曾要求市府協助檢討招商模式、分區分期與地方產業／生活機能導入；本頁只呈現公開可驗證的追蹤狀態，不把尚未完成的招商描述成成果。",
        "這個整合頁的功能，是把各細分政績重新串回同一個站城故事：車站改建、公民參與、停車接送、步行與無障礙、曹公圳、綠園道、捷運銜接及站體生活機能。各工程或政策的實際完成狀態仍以其細分頁與最新官方來源為準。"
    ],
    "history": [
        {"date": "2013", "title": "車站工程與公共討論持續展開", "text": "地方持續透過公聽會與議會監督討論鐵路地下化延伸鳳山、施工品質、站區環境與後續發展。"},
        {"date": "2018", "title": "鳳山車站整體規劃與設計公聽會", "text": "中央、地方、設計團隊、專家與在地團體討論鳳山意象、曹公圳、都市開發與交通整合，形成站城整合的長期公共議程。"},
        {"date": "2024", "title": "停車、接送與智慧交通納入議會提案", "text": "交通類第49號提案要求改善智慧停車、空位資訊、接送區與行人動線，市府及臺鐵分工持續協調。"},
        {"date": "2025", "title": "空中鳳城招商與生活機能持續追蹤", "text": "議會提案要求市府協助臺鐵檢討招商策略、分區分期及地方生活機能導入，當時仍屬招商與規劃追蹤。"},
        {"date": "2026-05-13", "title": "車站—曹公圳—捷運O12軸線再次進入總質詢", "text": "議會公開紀錄載有鳳山車站至捷運O12站軸線、步行與周邊整合議題，持續要求跨機關推進。"},
        {"date": "2026", "title": "站前綠色廊道阻斷列入議會提案", "text": "議會公開提案要求跨局處會勘與產權盤點，改善鳳山車站前綠色廊道阻斷及人行空間。"}
    ],
    "notes": [
        "本頁是整合型 hub，不取代細分頁的工程進度與來源；未查得正式核定或完成證據的事項維持『持續爭取／追蹤』語氣。",
        "舊站曾記載曹公圳水岸活化4,500萬元及預計2027年3月完工；本次尚未取得足以獨立重複核定該金額與期程的水利局原始文件，因此不在本頁把該數字寫成已重新核驗事實。"
    ],
    "images": [],
    "sources": [
        {
            "title": "高雄市議會｜第4屆第4次定期大會交通類第49號提案：鳳山車站停車與交通設施",
            "url": "https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?ct=0A42381EC11CB8EE&s=06B668EB0E1BAAB0",
            "sourceType": "高雄市議會第一手資料",
            "sourceDate": "2024"
        },
        {
            "title": "高雄市議會｜鳳山車站整體規劃與設計公聽會紀錄",
            "url": "https://cissearch.kcc.gov.tw/Upload/Attachment/PublicHearing/517/d878c58d-8ea1-4d72-8c99-ff1bd61a6f6e.pdf",
            "sourceType": "高雄市議會第一手資料",
            "sourceDate": "2018"
        },
        {
            "title": "高雄市議會｜陳慧文議員公開提案與問政資料",
            "url": "https://cissearch.kcc.gov.tw/Frame_Councilor.aspx?cname=%E9%99%B3%E6%85%A7%E6%96%87",
            "sourceType": "高雄市議會第一手資料",
            "sourceDate": "2026"
        }
    ],
    "related": station_related,
    "verification": {
        "checkedAt": TODAY,
        "content": "整合頁已核驗公共參與、停車接送及議會追蹤脈絡；未核定事項保留追蹤語氣",
        "location": "鳳山車站為代表點，不是所有子議題工程範圍",
        "attribution": "議會提案、公聽會與質詢紀錄支持長期追蹤事實；工程完成狀態分頁個別判定"
    },
    "verifiedAt": TODAY,
    "imageDimensions": {},
    "editorialReview": {
        "summary": "鳳山車站整合專題串接站體、公民參與、停車接送、步行、曹公圳、綠園道與捷運銜接；未完成或未核定事項不改寫為成果。",
        "paragraphs": [
            "本頁保留舊站完整 hub 的資訊密度，並將可驗證內容拆回正式政績 source architecture。",
            "所有細分工程／政策的狀態以各分頁及最新官方來源為準。"
        ],
        "history": []
    }
}
if "fengshan-station-overview" not in byid:
    idx = next((i for i, x in enumerate(items) if x["id"] == "rail-greenway"), len(items))
    items.insert(idx, overview)
    byid["fengshan-station-overview"] = overview
else:
    byid["fengshan-station-overview"].update(overview)

# 補強細分頁並指回 overview
for cid in station_related:
    rel = list(byid[cid].get("related", []))
    if "fengshan-station-overview" not in rel:
        rel.insert(0, "fengshan-station-overview")
    byid[cid]["related"] = rel
    byid[cid]["updated"] = TODAY

update_case(
    "station-parking",
    summary="議會交通類第49號提案要求改善鳳山車站停車場票卡、車牌辨識、空位資訊、接送區與行人動線；市府回覆已就臺鐵停車設備、站區停車供給與南側臨停接送空間協調辦理，仍需持續追蹤實際落地。",
    paragraphs=[
        "鳳山車站停車與接送問題不是單一停車格數量，而是票證／辨識、空位資訊、汽機車分流、臨停接送與行人安全的整體動線。議會第4屆第4次定期大會交通類第49號提案已把這些問題列入正式市政追蹤。",
        "市府辦理情形指出，交通局曾函請臺鐵研議停車場車牌辨識、重機停車與動線改善；車站周邊另盤點既有路外停車場及申設中的停車場。南側道路則納入第85期市地重劃工程，規劃臨時停車／接送空間。",
        "本頁維持『持續追蹤』，因公開辦理情形能證明問題已進入跨機關處理，但不能單憑回覆推定所有智慧停車、接送與行人設施已全部完成。"
    ],
    history=[
        {"date": "2024", "title": "交通類第49號提案", "text": "要求臺鐵與市府改善車牌辨識、停車空位資訊、接送區、行人動線及停車供給。"},
        {"date": "2025", "title": "市府回覆站區交通辦理情形", "text": "交通局協調臺鐵檢討停車設備與動線，並盤點周邊路外停車與南側道路臨停接送空間。"}
    ],
    sources=[
        {
            "title": "高雄市議會｜第4屆第4次定期大會交通類第49號提案",
            "url": "https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?ct=0A42381EC11CB8EE&s=06B668EB0E1BAAB0",
            "sourceType": "高雄市議會第一手資料",
            "sourceDate": "2024"
        },
        {
            "title": "高雄市議會｜交通類第49號辦理情形答覆附件",
            "url": "https://cissearch.kcc.gov.tw/Upload/Attachment/ProposalReplyManager/1197/09725b37-b0e5-41c3-8d92-4567f080a67b.pdf",
            "sourceType": "高雄市議會／市府第一手資料",
            "sourceDate": "2025"
        }
    ],
    notes=["市府回覆代表已受理與辦理，不等於所有設施已完成；實際完工仍須以臺鐵／市府後續公告或現場驗收為準。"],
    related=byid["station-parking"]["related"],
    verification_content="已核驗議會提案與市府辦理情形；完成狀態仍持續追蹤",
    attribution="陳慧文提案與市府答覆均有議會第一手資料"
)

update_case(
    "station-design",
    summary="鳳山車站整體規劃與設計曾透過議會公聽會納入地方、專家與設計團隊意見，討論鳳山意象、曹公圳、周邊開發與交通整合；站上開發與生活機能後續仍需依臺鐵與市府正式程序追蹤。",
    paragraphs=[
        "鳳山車站改建長期不只討論月台與站體，也包含城市設計。高雄市議會公開公聽會紀錄顯示，在地代表、專業者與設計團隊曾就車站與曹公圳關係、周邊8至9公頃土地、道路切割、公共空間與後續開發模式提出具體意見。",
        "這些公聽會與議會監督形成可驗證的公民參與歷程；但『公民參與已發生』不等於所有建議都已落實。網站把公共討論、已辦理事項與後續招商／開發分開呈現。",
        "空中鳳城等站體生活機能與招商議題，仍以臺鐵及市府後續正式招商、契約與營運結果為準。"
    ],
    history=[
        {"date": "2018", "title": "鳳山車站整體規劃與設計公聽會", "text": "地方、專家、設計團隊與政府機關公開討論車站設計、曹公圳、公共空間與站區開發。"},
        {"date": "2025", "title": "站上開發與招商議題持續列入議會追蹤", "text": "公開提案要求市府協助檢討招商策略、生活機能與地方需求；尚不視為招商完成。"}
    ],
    sources=[
        {
            "title": "高雄市議會｜鳳山車站整體規劃與設計公聽會紀錄",
            "url": "https://cissearch.kcc.gov.tw/Upload/Attachment/PublicHearing/517/d878c58d-8ea1-4d72-8c99-ff1bd61a6f6e.pdf",
            "sourceType": "高雄市議會第一手資料",
            "sourceDate": "2018"
        },
        {
            "title": "高雄市議會｜陳慧文議員公開提案與問政資料",
            "url": "https://cissearch.kcc.gov.tw/Frame_Councilor.aspx?cname=%E9%99%B3%E6%85%A7%E6%96%87",
            "sourceType": "高雄市議會第一手資料",
            "sourceDate": "2026"
        }
    ],
    notes=["公共參與與公聽會已完成，但站體開發、招商與各項設計落地程度需分別依正式資料判定。"],
    related=byid["station-design"]["related"],
    verification_content="已核驗公聽會與議會追蹤；未把招商／開發規劃寫成完成",
    attribution="公聽會及議會資料可支持長期公共參與與監督"
)

update_case(
    "rail-greenway",
    summary="鳳山鐵路地下化後的綠園道仍有站前『最後一哩』銜接與產權阻斷問題。2026年議會提案要求跨局處會勘、盤點產權並改善站前人行空間，目前仍屬持續追蹤。",
    paragraphs=[
        "鐵路地下化後的綠園道改善並非只有植栽或鋪面，真正影響使用的是斷點、圍籬、產權與車站前後的行人銜接。",
        "2026年高雄市議會公開提案已將『鳳山火車站前綠色廊道阻斷問題』列為跨局處會勘與產權盤點事項，目標是打通站前人行空間。",
        "本頁不把會勘、盤點或局部改善直接寫成全線完成；後續仍須依土地協調、工程施作與正式驗收更新。"
    ],
    history=[
        {"date": "2026", "title": "站前綠色廊道阻斷列入議會提案", "text": "要求跨局處會勘與產權盤點，以利打通鳳山火車站前人行空間。"}
    ],
    sources=[
        {
            "title": "高雄市議會｜陳慧文議員公開提案與問政資料",
            "url": "https://cissearch.kcc.gov.tw/Frame_Councilor.aspx?cname=%E9%99%B3%E6%85%A7%E6%96%87",
            "sourceType": "高雄市議會第一手資料",
            "sourceDate": "2026"
        }
    ],
    notes=["目前可確認的是提案、會勘／產權盤點要求與持續追蹤，尚未取得全線打通完成的第一手證明。"],
    related=byid["rail-greenway"]["related"],
    verification_content="已核驗2026議會提案；全線完成狀態未獲證實",
    attribution="議會提案可支持持續推動／追蹤，不代表工程已完成"
)

update_case(
    "metro-green-line",
    summary="捷運青線銜接鳳山車站是站城整合的持續倡議方向；截至2026年9月9日本次查核未取得『已核定興建』或『已完成』的第一手證據，因此維持持續追蹤而不提前宣告成果。",
    paragraphs=[
        "鳳山車站若要成為真正的轉乘節點，捷運與臺鐵的直接銜接是長期交通整合課題。服務處持續倡議捷運青線進入／銜接鳳山車站，使臺鐵、捷運與舊城步行網絡形成完整轉乘。",
        "本次內容遷移特別把『倡議』與『核定』分開：尚未取得捷運主管機關正式核定路線、中央審議或工程動工證明前，不把青線進站寫成已完成政績。",
        "後續將以高雄市政府捷運工程局的正式可行性研究、綜合規劃、核定與工程公告更新階段。"
    ],
    history=[
        {"date": "2026", "title": "站城整合持續倡議", "text": "持續主張捷運青線銜接鳳山車站，並與曹公圳、步行廊道及臺鐵轉乘整體規劃。"}
    ],
    sources=[
        {
            "title": "高雄市議會｜陳慧文議員公開提案與問政資料",
            "url": "https://cissearch.kcc.gov.tw/Frame_Councilor.aspx?cname=%E9%99%B3%E6%85%A7%E6%96%87",
            "sourceType": "高雄市議會第一手資料（追蹤入口）",
            "sourceDate": "2026"
        }
    ],
    notes=["本次未找到足以把捷運青線進站標示為已核定興建的第一手證據，因此保守維持『持續追蹤』。"],
    related=byid["metro-green-line"]["related"],
    verification_content="已核驗目前可公開追蹤入口；核定興建狀態未獲證實",
    attribution="本頁只表述持續倡議，不主張已完成或已核定"
)

# station-walkway 保留既有已核驗內容，只補 overview 關聯與查核日期
byid["station-walkway"]["verifiedAt"] = TODAY
byid["station-walkway"].setdefault("verification", {})["checkedAt"] = TODAY

# Step 2-4｜五福市場：保留既有 URL，恢復舊站完整故事密度
market = R / "activity-market.html"
market_text = market.read_text(encoding="utf-8")
market_article = '''<article class="wrap section"><p class="eyebrow">LOCAL STORY</p><h2>從空攤，到攤商搶著把自己的故事搬到前面</h2><p>五福市場和許多傳統市場一樣，近年面臨空攤增加與經營壓力。2026年夏天，崑山科技大學環境設計相關團隊由張曦勻教授帶領學生走進市場，逐一訪談與記錄攤商，把市場職人的工作、生活與記憶整理成展覽。</p><p>這場展覽一開始並不順利。布展時前排攤位難以使用，團隊只好先從市場後方較空的攤位一格一格架設。展覽推出後，攤商看到自己的故事成為版面內容，態度開始轉變：有人開始在意自己的版面位置，也有人希望把內容移到更前面，讓更多來市場的人看見。</p><p>為了回應攤商的期待，張曦勻教授重新拆卸、搬移與配置展板。舊站活動紀錄留下了一個很具體的畫面：教授花了約五個小時調整版面，雙手沾滿黑墨，笑稱自己當了一天「黑手」。</p><p>更重要的改變發生在市場裡。原本對展覽興趣不高的攤商，後來會主動和訪客討論內容，甚至親自介紹「展覽中的自己」。對傳統市場而言，空間改造只是表面；讓攤商重新看見自己的價值、讓年輕世代進入市場理解職人與地方生活，才是這次活動留下的核心意義。</p><p>「五福市場職人展」展期為2026年6月27日至7月12日，地點位於高雄市鳳山區五福里南進二街一帶，活動現已結束。本頁改以活動回顧方式永久保留，不因展期結束而刪除或縮成短公告。</p><p class="source-note">內容依陳慧文服務處2026年6月27日原公開活動紀錄整理；日期與人物敘述保留原公開資訊，不把活動參與延伸解讀為工程或市場改造已完成。</p><div class="case-photos"><a href="assets/market-1.jpg"><img src="assets/market-1.jpg" alt="五福市場職人展活動照片" loading="lazy" width="960" height="720"></a><a href="assets/market-2.jpg"><img src="assets/market-2.jpg" alt="五福市場職人展活動照片" loading="lazy" width="683" height="960"></a><a href="assets/market-3.jpg"><img src="assets/market-3.jpg" alt="五福市場職人展活動照片" loading="lazy" width="960" height="720"></a></div><p><a class="button button-green" href="activities.html">返回活動列表 →</a></p></article>'''
market_text, count = re.subn(r'<article class="wrap section">.*?</article>', market_article, market_text, count=1, flags=re.S)
if count != 1:
    raise SystemExit("activity-market.html article replacement failed")
market_text = market_text.replace(
    '<meta name="description" content="走進市場，看攤商故事與攤位改造。展期為2026年6月27日至7月12日，展覽已結束。">',
    '<meta name="description" content="五福市場職人展完整活動回顧：學生走進市場記錄攤商故事，從布展困難到攤商主動參與，保留鳳山傳統市場的地方記憶。">'
)
market.write_text(market_text, encoding="utf-8")

# Step 2-4｜美麗島事件：建立獨立 evergreen 歷史長文，不轉政績、不404/410
history_page = R / "history-meilidao.html"
history_page.write_text('''<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#075548">
<title>美麗島事件與高雄民主記憶｜陳慧文・高雄市議員</title>
<meta name="description" content="從1979年美麗島雜誌社高雄服務處、世界人權日集會、事件後逮捕與軍事審判，到臺灣民主化的重要轉捩點，整理高雄的民主歷史記憶。">
<link rel="canonical" href="https://hong1998tw.github.io/chen-huiwen-website/history-meilidao.html">
<meta property="og:type" content="article">
<meta property="og:locale" content="zh_TW">
<meta property="og:title" content="美麗島事件與高雄民主記憶｜陳慧文">
<meta property="og:description" content="整理1979年美麗島事件的高雄場域、事件經過、逮捕審判與民主化歷史意義。">
<meta property="og:url" content="https://hong1998tw.github.io/chen-huiwen-website/history-meilidao.html">
<meta property="og:image" content="https://hong1998tw.github.io/chen-huiwen-website/assets/site-share.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="陳慧文・高雄市議員・鳳山區">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="美麗島事件與高雄民主記憶｜陳慧文・高雄市議員"><meta name="twitter:description" content="整理1979年美麗島事件的高雄場域、事件經過、逮捕審判與民主化歷史意義。"><meta name="twitter:image" content="https://hong1998tw.github.io/chen-huiwen-website/assets/site-share.png">
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="styles.css?v=20260908-mobile2"><link rel="stylesheet" href="mobile.css?v=20260908-nav2"><link rel="stylesheet" href="layout.css?v=20260908-timeline"><script src="site.js?v=20260908-mobile2" defer></script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"美麗島事件與高雄民主記憶","description":"整理1979年美麗島事件的高雄場域、事件經過、逮捕審判與民主化歷史意義。","inLanguage":"zh-Hant-TW","dateModified":"2026-09-09","author":{"@type":"Organization","name":"陳慧文服務處"},"mainEntityOfPage":"https://hong1998tw.github.io/chen-huiwen-website/history-meilidao.html"}</script>
</head>
<body>
<a class="skip-link" href="#main">跳到主要內容</a><div class="topline"><div class="wrap">高雄市議員 · 鳳山區<span>服務專線 <a href="tel:+88678212536">07-821-2536</a></span></div></div>
<header class="site-header"><div class="wrap nav-wrap"><a href="./" class="brand" aria-label="陳慧文官方網站首頁"><span class="brand-mark" aria-hidden="true">文<span>✳</span></span><span class="brand-name">陳慧文</span><span class="brand-role">高雄市議員<br>CHEN HUI-WEN</span></a><button class="menu-toggle" type="button" aria-expanded="false" aria-controls="navigation">選單 <span aria-hidden="true">☰</span></button><nav id="navigation" aria-label="主要導覽"><a href="./">首頁</a><a href="political-donation.html">政治獻金</a><a href="service.html#monthly-heading">律師時間表</a><a href="about.html">關於慧文</a><a href="achievements.html">政績</a><a href="vision.html">政見</a><a href="news.html">新聞</a><a href="activities.html">活動公告</a><a href="service.html">服務資訊</a><a href="petition.html">案件表單</a></nav></div></header>
<main id="main"><div class="wrap breadcrumb"><a href="./">首頁</a><span>/</span><a href="news.html">鳳山大小事</a><span>/</span><span>美麗島事件與高雄民主記憶</span></div>
<section class="page-head"><div class="wrap"><p class="eyebrow">KAOHSIUNG · HUMAN RIGHTS · 1979</p><h1>美麗島事件與高雄民主記憶</h1><p>民主自由不是抽象口號。1979年12月10日發生在高雄的美麗島事件，是理解臺灣從威權走向民主的重要歷史節點。</p></div></section>
<article class="wrap section case-body"><h2>從《美麗島》雜誌與高雄服務處開始</h2><p>國家人權博物館「國家人權記憶庫」記載，1979年美麗島雜誌社成立，《美麗島》雜誌於同年8月16日正式出刊；發行四期後發生美麗島事件，雜誌社隨後遭查封停刊。原美麗島雜誌社高雄市服務處位於高雄市新興區中山一路53號，今日已成為可指認的歷史空間。</p><p>當時臺灣仍處戒嚴與黨禁體制，反對運動主要以「黨外」形式存在。雜誌、演講、選舉與地方組織，是當時公共政治意見少數能夠被傳遞的管道之一。</p>
<h2>1979年12月10日：世界人權日集會</h2><p>依國家人權記憶庫的事件資料，1979年12月10日《美麗島》雜誌社在高雄舉行世界人權日紀念活動。原預定場地受封鎖後，群眾轉往中山路與中正路交會的大圓環，也就是今天高雄捷運美麗島站一帶。</p><p>活動訴求民主、自由與人權。晚間集會期間，鎮暴部隊在周邊部署，現場經過包圍、煙霧與催淚瓦斯後出現多波警民衝突，直到深夜才逐漸結束。這場事件後來被稱為「高雄事件」或「美麗島事件」。</p>
<h2>逮捕、偵訊與審判</h2><p>事件後，政府大規模逮捕黨外運動人士。國家人權博物館出版的美麗島事件史料彙編，將事件後的逮捕、偵訊、軍事審判與後續處置分卷整理，並指出事件對反對運動造成重大打擊。</p><p>1980年的軍事審判成為社會高度關注的公共事件。對今日讀者而言，理解這段歷史不應只停留在人物名單與判決結果，更重要的是看見戒嚴體制下集會、出版、結社、司法程序與人權保障所受到的限制。</p>
<h2>為什麼它是臺灣民主化的重要轉捩點</h2><p>國家人權博物館將美麗島事件定位為臺灣政治民主化的重要關鍵點與轉捩點。事件雖伴隨鎮壓、逮捕與審判，卻也使社會更廣泛關注黨禁、戒嚴、政治參與與人權保障問題，並成為後續黨外運動與民主化歷程的重要歷史背景。</p><p>今天回到中山一路53號與美麗島站周邊，看到的不只是兩個地理座標，而是一段仍值得被保存、查證與討論的公共記憶。民主制度的形成不是單一事件的結果；保存史料、理解不同時代的制度限制，正是讓歷史不被壓縮成口號的方法。</p>
<h2>官方史料與延伸閱讀</h2><ul><li><a class="text-link" href="https://memory.nhrm.gov.tw/TopicExploration/Event/Detail/5" target="_blank" rel="noopener noreferrer">國家人權記憶庫｜高雄事件（美麗島事件） ↗</a></li><li><a class="text-link" href="https://memory.nhrm.gov.tw/TopicExploration/LocationSpace/Detail/137" target="_blank" rel="noopener noreferrer">國家人權記憶庫｜原美麗島雜誌社高雄市服務處 ↗</a></li><li><a class="text-link" href="https://www.nhrm.gov.tw/w/nhrm/Publishing_23020115221356461" target="_blank" rel="noopener noreferrer">國家人權博物館｜美麗島事件史料彙編：逮捕與偵訊 ↗</a></li><li><a class="text-link" href="https://www.nhrm.gov.tw/w/nhrm/Publishing_23020115270896373" target="_blank" rel="noopener noreferrer">國家人權博物館｜美麗島事件史料彙編：事件後的處置 ↗</a></li></ul><p class="source-note">本頁為歷史／人權 evergreen 內容，不列為政績，也不以政黨宣傳取代史料。主要事實依國家人權博物館與國家人權記憶庫公開資料整理，最後查核：2026.09.09。</p></article></main>
<footer class="footer"><div class="wrap footer-grid"><div><a class="footer-brand" href="./">陳慧文</a><p>高雄市議員 · 鳳山區<br>民眾服務與法律諮詢，關心鳳山每一天。</p></div><div><h2>服務處</h2><a class="footer-phone" href="tel:+88678212536">07-821-2536</a><p><a class="text-link" href="https://goo.gl/maps/fj8kzoZdjGeQA6vV9" target="_blank" rel="noopener noreferrer">高雄市鳳山區錦田路231號<span aria-hidden="true"> ↗</span></a><br><a href="mailto:hc8157976@gmail.com">hc8157976@gmail.com</a></p></div><div><h2>服務時間</h2><p>週一至週五　09:00–12:00<br>　　　　　　14:00–18:00<br>週六　　　　09:00–12:00</p><p class="footer-note">國定假日休息</p></div></div><div class="wrap footer-bottom"><span>© 2026 陳慧文服務處</span><div><a class="text-link" href="./">官網首頁</a> <a class="text-link" href="political-donation.html">政治獻金</a> <a class="text-link" href="https://line.me/R/ti/p/@yve2766q" target="_blank" rel="noopener noreferrer">LINE ↗</a> <a class="text-link" href="https://www.facebook.com/hwcfs/" target="_blank" rel="noopener noreferrer">Facebook ↗</a> <a class="text-link" href="https://www.instagram.com/huiwen.ifs/" target="_blank" rel="noopener noreferrer">Instagram<span aria-hidden="true"> ↗</span></a> <a class="text-link" href="https://www.youtube.com/channel/UCJPIvufDGcdD8PgYUi_YyDQ" target="_blank" rel="noopener noreferrer">YouTube<span aria-hidden="true"> ↗</span></a> <a class="text-link" href="https://www.kcc.gov.tw/MemberInfo_New.aspx?msn=2215&amp;n=39&amp;sms=9028" target="_blank" rel="noopener noreferrer">高雄市議會<span aria-hidden="true"> ↗</span></a><a class="text-link" href="https://www.threads.com/@huiwen.ifs?igshid=NTc4MTIwNjQ2YQ==" target="_blank" rel="noopener noreferrer">Threads（脆） ↗</a></div></div></footer></body></html>''', encoding="utf-8")

# 在 news 的延伸閱讀放入 evergreen 入口（不改主要新聞資料結構）
news = R / "news.html"
news_text = news.read_text(encoding="utf-8")
needle = '<div class="work-links"><a class="text-link" href="https://www.instagram.com/huiwen.ifs/"'
if needle in news_text and 'history-meilidao.html' not in news_text:
    news_text = news_text.replace(
        '<div class="work-links">',
        '<div class="work-links"><a class="text-link" href="history-meilidao.html">美麗島事件與高雄民主記憶 →</a>',
        1
    )
news.write_text(news_text, encoding="utf-8")

# Gate 2 決策紀錄：URL mapping 延後 Stage 3，Stage 2 不刪高價值頁
audit = R / "docs" / "MIGRATION-CONTENT-AUDIT-STAGE2.md"
audit.write_text('''# SEO Migration Stage 2｜高價值內容完整性稽核\n\n查核日期：2026-09-09（Asia/Taipei）\n\n## Gate 2 原則\n\n任何舊高價值頁都不能因 migration 變成較舊、較短、較不完整的內容。Stage 2 先完成內容等價／升級；舊 URL 的 redirect、canonical migration 與 404/410 判定留到 Stage 3。\n\n| 舊站高價值內容 | Stage 2 決策 | 新站承接 | 狀態 |\n| --- | --- | --- | --- |\n| 特教復康巴士／校園照護 | 轉政績並更新最新執行情形 | `data/achievements.json` → `achievement-special-education-support.html` | 已補官方2026執行情形 |\n| 八德滯洪池 | 保留政績、釐清金額／期程口徑 | `data/achievements.json` → `achievement-bade-detention.html` | 已補不同口徑與最新進度 |\n| 鳳山車站長篇 hub | 保留整合 hub，並連回細分政績 | `achievement-fengshan-station-overview.html` | 新增 |\n| 五福市場職人展 | 保留獨立活動／地方故事頁 | `activity-market.html` | 已恢復長文密度 |\n| 美麗島事件 | 保留獨立歷史／人權 evergreen 頁，不列政績 | `history-meilidao.html` | 新增 |\n| 問政紀錄 | 整併為站內議題頁的證據來源＋官方議會索引，不複製整套議會資料 | `news.html`、政績詳情頁、KCC official link | 保留入口，不做404/410 |\n| 其他歷史／地方議題 | 個案判定：evergreen 留獨立頁；活動留活動頁；可驗證服務成果進政績 | 後續逐頁 audit | Stage 3 前不得批次刪除 |\n\n## URL 邊界\n\n本階段不對舊 `huiwen.tw` URL 做 404/410。正式切換自有網域前，Stage 3 應建立 old→new URL map、301 規則、canonical、sitemap 與 Search Console 驗證。\n''', encoding="utf-8")

# sitemap：只新增兩個新公開頁，既有 URL 不刪
sitemap = R / "sitemap.xml"
smap = sitemap.read_text(encoding="utf-8")
new_urls = [
    "https://hong1998tw.github.io/chen-huiwen-website/achievement-fengshan-station-overview.html",
    "https://hong1998tw.github.io/chen-huiwen-website/history-meilidao.html",
]
for url in new_urls:
    if url not in smap:
        smap = smap.replace("</urlset>", f'<url><loc>{url}</loc><lastmod>{TODAY}</lastmod></url>\n</urlset>')
sitemap.write_text(smap, encoding="utf-8")

DATA.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("Stage 2 content patch applied:", len(items), "achievement records")
