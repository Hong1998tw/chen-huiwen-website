#!/usr/bin/env python3
"""One-time Step 5 migration: merge re-audited public achievements into canonical JSON.

This file is temporary. It contains public, reviewed metadata only and never reads
private Candidate Registry inputs. Delete it after the migration commit lands.
"""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "data" / "achievements.json"
TODAY = "2026-09-13"


def source(title, url, source_date=None, source_type="政府第一手資料"):
    item = {"title": title, "url": url, "sourceType": source_type}
    if source_date:
        item["sourceDate"] = source_date
    return item


def base_record(*, aid, title, summary, categories, subcategories, status,
                scope="鳳山區", district="鳳山區", location_name="",
                location_note="", coordinates=None, paragraphs=None,
                history=None, sources=None, budget="", attribution="oversight"):
    return {
        "id": aid,
        "title": title,
        "summary": summary,
        "categories": categories,
        "subcategories": subcategories,
        "villages": [],
        "villageMethod": "",
        "scope": scope,
        "district": district,
        "status": status,
        "coordinates": coordinates,
        "locationName": location_name,
        "locationNote": location_note,
        "published": TODAY,
        "updated": TODAY,
        "budget": budget,
        "paragraphs": paragraphs or [],
        "history": history or [],
        "notes": [],
        "images": [],
        "sources": sources or [],
        "related": [],
        "verification": {
            "checkedAt": TODAY,
            "content": "已核對本頁列示之公開第一手資料；狀態依來源可證範圍保守呈現",
            "location": "公共工程位置依官方文件或官方設施資料；未完成里界查核者不填入里別篩選",
            "attribution": attribution,
        },
        "verifiedAt": TODAY,
        "imageDimensions": {},
    }


new_records = [
    base_record(
        aid="dade-park-road-opening",
        title="大德公園旁都市計畫道路開闢",
        summary="陳慧文持續追蹤大德公園旁尚未開闢的都市計畫道路。市府公開辦理情形指出，該路段長約127公尺，因用地與工程經費龐大，仍須視交通需求與財源研議。",
        categories=["交通與基建"], subcategories=["都市計畫道路", "道路開闢"], status="爭取規劃",
        location_name="高雄市鳳山區大德公園旁都市計畫道路",
        location_note="位於林森路南側、自強一路東側；公開資料記載道路長約127公尺。",
        paragraphs=[
            "大德公園旁部分都市計畫道路長期未開闢，居民通行需要繞行。陳慧文透過議會提案持續要求市府評估開闢。",
            "市府辦理情形指出，案件涉及用地取得與工程經費，現階段仍屬研議與爭取階段，因此網站不標示為已完成。",
        ],
        history=[{"date":"2021-10-19","title":"市府回覆道路開闢提案辦理情形","text":"市府說明道路長約127公尺，涉及用地與工程經費，仍須視交通需求及財源研議。"}],
        sources=[
            source("高雄市議會｜公兒77用地旁都市計畫道路開闢提案", "https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?ct=0A42381EC11CB8EE&s=F88DC44CA70B01DB"),
            source("高雄市政府｜公兒77用地旁道路開闢提案辦理情形", "https://cissearch.kcc.gov.tw/Upload/Attachment/ProposalReplyManager/1200/48f61e5f-c6c4-4e3a-b17f-d77f7ac5c63e.pdf", "2021-10-19"),
        ],
    ),
    base_record(
        aid="nanhe-park-youbike",
        title="南和公園 YouBike 設站",
        summary="陳慧文透過議會提案推動南和公園周邊增設公共自行車站，現行 YouBike 官方資料可確認「南和公園」站已設置。",
        categories=["交通與基建"], subcategories=["公共自行車"], status="已完成",
        location_name="高雄市鳳山區南和公園",
        location_note="現行站名為「南和公園」；站點位置以 YouBike 官方站務資料為準。",
        paragraphs=[
            "南和里距離捷運站較遠，陳慧文曾在議會提案，要求於南和環保公園等地評估增設公共自行車站，補足社區轉乘需求。",
            "後續公共自行車系統升級為 YouBike 2.0；目前官方站務資料可確認「南和公園」站存在。",
        ],
        history=[{"date":"2020-05-15","title":"公共自行車站點會勘","text":"相關單位就南和公園周邊 YouBike 2.0 站點辦理現場會勘與設站評估。"}],
        sources=[
            source("高雄市議會／市府｜南和里公共自行車設站提案辦理情形", "https://cissearch.kcc.gov.tw/Upload/Attachment/ProposalReplyManager/88/8fb135dd-4388-4cd2-8bc4-7e44cf7ad594.pdf"),
            source("YouBike 高雄｜南和公園站務資訊", "https://www.youbike.com.tw/region/kcg/news/status/6a05222fcaacd6244e0236a2/", source_type="官方營運資訊"),
        ],
        attribution="supported",
    ),
    base_record(
        aid="wujia-public-parking",
        title="五甲公有停車場增設",
        summary="陳慧文曾透過議會提案要求加速五甲地區停車場規劃；現行交通局資料可確認「五甲」公有停車場已設置並持續營運。",
        categories=["交通與基建"], subcategories=["停車"], status="已完成",
        location_name="高雄市鳳山區國光路65巷與國光路一帶",
        location_note="交通局路外停車場資料列有「五甲」公有停車場，現有45個小型車位。",
        coordinates=[22.619419, 120.35075],
        paragraphs=[
            "五甲地區停車需求長期偏高，陳慧文曾透過議會提案，要求市府就閒置或可利用土地研議增設停車空間。",
            "交通局現行路外停車場資料顯示，「五甲」公有停車場位於國光路65巷與國光路一帶，現有45個小型車位。",
        ],
        sources=[
            source("高雄市議會｜五甲地區停車空間提案與辦理資料", "https://cissearch.kcc.gov.tw/Upload/Attachment/%E8%AD%B0%E4%BA%8B%E8%B3%87%E8%A8%8A%E5%BD%99%E7%B7%A8/%E9%AB%98%E9%9B%84%E5%B8%82%E8%AD%B0%E6%9C%83/106%E5%B9%B4/10%E6%9C%9F/106%E5%B9%B410%E6%9C%9F00012%E8%B5%B7%E9%A0%8100391%E8%BF%84%E9%A0%81.pdf"),
            source("高雄市政府交通局｜路外停車場一覽表", "https://www.tbkc.gov.tw/FileOutput/Page/%E9%AB%98%E9%9B%84%E5%B8%82%E6%94%BF%E5%BA%9C%E4%BA%A4%E9%80%9A%E5%B1%80%E8%B7%AF%E5%A4%96%E5%81%9C%E8%BB%8A%E5%A0%B4%E4%B8%80%E8%A6%BD%E8%A1%A8.pdf?id=b6f7c432-13cd-4d56-bd7f-6d9de02f54d3"),
        ],
        attribution="supported",
    ),
    base_record(
        aid="wufu-2nd-lane81-drainage",
        title="五福二路81巷排水改善",
        summary="陳慧文正式提案改善五福二路81巷排水；市府回覆顯示，2019年12月完成跨局處會勘，後續由鳳山區公所提報籌措改善經費。",
        categories=["交通與基建"], subcategories=["排水", "防洪治水"], status="持續追蹤",
        location_name="高雄市鳳山區五福二路81巷",
        location_note="公開辦理情形可確認會勘與籌措經費程序；尚未取得工程完工證明。",
        paragraphs=[
            "五福二路81巷地勢低窪，豪雨期間容易出現排水不及。陳慧文透過議會提案要求市府研議改善，並請相關單位現場會勘。",
            "市府辦理情形記載，2019年12月25日水利局邀集服務處、里長與相關機關會勘；因巷寬小於6公尺，後續由鳳山區公所提報民政局籌措經費。現有來源尚未證明工程完成。",
        ],
        history=[{"date":"2019-12-25","title":"跨局處辦理排水改善會勘","text":"水利局邀集相關單位會勘，後續由鳳山區公所提報籌措改善經費。"}],
        sources=[source("高雄市議會／市府｜五福二路81巷排水改善提案辦理情形", "https://cissearch.kcc.gov.tw/Upload/Attachment/ProposalReplyManager/86/ada1a178-e988-4b96-b28f-3b8a5ed1d84d.pdf")],
    ),
    base_record(
        aid="fengbei-lane127-road-opening",
        title="鳳北路127巷都市計畫道路開闢",
        summary="陳慧文在議會持續追蹤鳳北路127巷都市計畫道路開闢，指出路段若打通，可改善居民前往鎮北國小及周邊通行動線。",
        categories=["交通與基建"], subcategories=["都市計畫道路", "道路開闢"], status="持續追蹤",
        location_name="高雄市鳳山區鳳北路127巷",
        location_note="公開質詢資料支持道路開闢追蹤；尚未取得全段正式完工證明。",
        paragraphs=[
            "鳳北路127巷部分都市計畫道路長期未打通。陳慧文在工務部門質詢中指出，相關土地已完成徵收，後續重點在道路實際開闢。",
            "現有公開來源能證明質詢與持續追蹤，但尚不足以確認整段道路已正式完工，因此不提前標示完成。",
        ],
        sources=[source("高雄市議會｜鳳北路127巷都市計畫道路開闢質詢紀錄", "https://cissearch.kcc.gov.tw/System/Bulletin/Pdfview.aspx?file=~%2FUpload%2FAttachment%2F%E5%85%AC%E5%A0%B1%E8%B3%87%E6%96%99%2F%E9%AB%98%E9%9B%84%E5%B8%82%E8%AD%B0%E6%9C%83%2F34%E5%8D%B7%2F4%E6%9C%9F%2F34%E5%8D%B74%E6%9C%9F08067%E8%B5%B7%E9%A0%8108207%E8%BF%84%E9%A0%81.pdf&page=30")],
    ),
    base_record(
        aid="fengxin-softball-lighting",
        title="鳳新壘球場夜間照明改善",
        summary="陳慧文持續追蹤鳳新壘球場夜間照明設備更新，要求運動發展局釐清設備責任並改善夜間使用條件。",
        categories=["教育與文化"], subcategories=["運動設施"], status="持續追蹤",
        location_name="高雄市鳳山區鳳新壘球場",
        location_note="夜間照明設備改善與管理責任追蹤。",
        paragraphs=[
            "鳳新壘球場夜間照明設備老舊，影響球員與民眾使用。陳慧文在議會質詢要求運動發展局釐清委外管理與設備汰換責任，並推動照明改善。",
            "後續質詢仍持續追問更新進度。現階段公開來源可證明議會監督與局處回應，但不足以證明整體照明改善已完成。",
        ],
        sources=[source("高雄市議會｜鳳新壘球場夜間照明質詢紀錄", "https://cissearch.kcc.gov.tw/Upload/Attachment/%E5%85%AC%E5%A0%B1%E8%B3%87%E6%96%99/%E9%AB%98%E9%9B%84%E5%B8%82%E8%AD%B0%E6%9C%83/34%E5%8D%B7/3%E6%9C%9F/34%E5%8D%B73%E6%9C%9F05631%E8%B5%B7%E9%A0%8105747%E8%BF%84%E9%A0%81.pdf")],
    ),
    base_record(
        aid="fengshan-columbarium-capacity",
        title="鳳山拷潭納骨塔塔位供給監督",
        summary="陳慧文透過議會提案追蹤鳳山拷潭納骨塔塔位供給。市府當時已規劃增設946個納骨櫃位，因此本案定位為需求監督與進度追蹤，不把既有工程改寫成個人促成。",
        categories=["社福與衛環"], subcategories=["殯葬服務", "民政"], status="持續追蹤",
        location_name="高雄市鳳山區拷潭納骨塔",
        location_note="提案追蹤塔位供給與既有增設工程進度。",
        paragraphs=[
            "鳳山拷潭納骨塔服務範圍涵蓋鳳山及周邊地區，塔位供給攸關民眾治喪與祭祀需求。陳慧文於第三屆第三次定期大會提出增設塔位提案。",
            "市府109年8月回覆時表示，當年度已規劃增設946個納骨櫃位，且工程已開工。因市府計畫早已存在，官網將本案呈現為議會監督與進度追蹤，不主張由單一提案創設工程。",
        ],
        sources=[
            source("高雄市議會｜鳳山拷潭納骨塔塔位供給提案", "https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?ct=0A42381EC11CB8EE&s=50F5C593EE0B6AE5"),
            source("高雄市政府｜鳳山拷潭納骨塔提案辦理情形", "https://cissearch.kcc.gov.tw/Upload/Attachment/ProposalReplyManager/92/568124f2-e87e-4197-a346-f905b9f95850.pdf"),
        ],
    ),
    base_record(
        aid="changle-hexing-youbike",
        title="長樂街、和興街口 YouBike 設站",
        summary="陳慧文持續追蹤和興里公共自行車需求，市府辦理情形可確認長樂街與和興街口已有 YouBike 站點。",
        categories=["交通與基建"], subcategories=["公共自行車"], status="已完成",
        location_name="高雄市鳳山區長樂街與和興街口",
        location_note="市府公開辦理情形可確認該路口已有公共自行車站。",
        paragraphs=[
            "和興里居民有公共自行車轉乘需求，相關案件透過提案、會勘與設站評估持續推進。",
            "市府公開辦理情形可確認長樂街與和興街口已有公共自行車站。官網僅陳述可核對的設站成果，不延伸為其他未證實的功勞。",
        ],
        sources=[source("高雄市議會／市府｜和興里公共自行車站辦理情形", "https://cissearch.kcc.gov.tw/Upload/Attachment/ProposalReplyManager/1166/b4f61fbb-0985-454b-b3ae-64d898a77fec.pdf")],
        attribution="supported",
    ),
    base_record(
        aid="personal-mobility-device-rules",
        title="個人行動器具路線與管理規範",
        summary="陳慧文於第三屆第八次定期大會正式提案，要求市府針對電動滑板車、平衡車等個人行動器具研議可行駛路線、評估標準與跨局處管理方式。",
        categories=["交通與基建"], subcategories=["個人行動器具", "交通管理"], status="爭取規劃",
        scope="全市政策", district="高雄市",
        paragraphs=[
            "道路交通管理規範將個人行動器具納入管理後，地方政府需要面對可行駛路線、速限與安全標準等問題。陳慧文提出正式提案，要求市府建立可操作的路線評估與管理流程。",
            "提案經議會決議送請市政府研究辦理。後續是否形成具體自治規範或開放路線，仍以主管機關正式公告為準。",
        ],
        sources=[source("高雄市議會｜第三屆第八次定期大會交通類第24號提案", "https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?ct=0A42381EC11CB8EE&s=9AB443711F5668A6")],
    ),
    base_record(
        aid="dalinpu-relocation-planning",
        title="大林蒲遷村安置與鳳山承載量監督",
        summary="陳慧文在大林蒲遷村規劃中，要求市府評估鳳山安置地對交通、停車與地方生活的影響，並透過跨局處協調回應居民疑慮。",
        categories=["交通與基建"], subcategories=["都市規劃", "遷村"], status="持續追蹤",
        scope="跨區服務", district="高雄市",
        paragraphs=[
            "大林蒲遷村涉及安置地選擇，也會影響新安置區周邊交通、停車與公共服務量能。陳慧文在議會質詢要求市府聽取地方意見，避免解決一地問題後，又在鳳山衍生新的生活負擔。",
            "公開議會資料可確認其提出跨局處協調與替代安置地評估等訴求。原始候選中涉及更細節的項目，尚無同等公開證據，因此本頁不先寫入。",
        ],
        sources=[source("高雄市議會｜大林蒲遷村安置與鳳山地方影響質詢", "https://www.kcc.gov.tw/News_Content.aspx?n=47&s=14114")],
    ),
    base_record(
        aid="east-wujia-future-industry-zone",
        title="五甲路以東未來經濟區與智慧產業規劃倡議",
        summary="陳慧文持續主張五甲路以東農業區應朝產業與智慧城市方向整體規劃，並在2022年書面質詢提出5G AIoT、智慧交通、綠能與智慧照護等應用構想。",
        categories=["經濟與產業"], subcategories=["都市計畫", "產業園區", "智慧城市"], status="爭取規劃",
        location_name="高雄市鳳山區五甲路以東農業區",
        location_note="屬整體規劃倡議範圍，不以單一工程點位代表。",
        paragraphs=[
            "五甲路以東是鳳山重要的大面積開發區。陳慧文長期關注都市計畫與開發方向，主張不應只處理住宅需求，也應思考產業、就業與城市機能。",
            "2022年8月24日書面質詢中，陳慧文提出產業園區、5G AIoT、智慧交通、智慧消防、綠能與智慧照護等方向，作為未來經濟區的規劃倡議。是否納入法定計畫，仍以市府與中央審議結果為準。",
        ],
        history=[{"date":"2022-08-24","title":"書面質詢提出未來經濟區與智慧產業構想","text":"提出產業園區、5G AIoT、智慧交通、綠能與智慧照護等規劃方向。"}],
        sources=[source("高雄市議會｜2022年8月24日陳慧文書面質詢", "https://cissearch.kcc.gov.tw/Upload/Attachment/BulletinDraft/5980/4700fabe-585b-4b00-8028-47612dd44edb.pdf", "2022-08-24")],
    ),
    base_record(
        aid="dadong-park-governance",
        title="大東公園志工支持與維護機制",
        summary="陳慧文正式提案建立公園志工支持機制，並以大東公園維護經驗為例，要求市府強化跨局處協調與志工支持。",
        categories=["環境與綠地"], subcategories=["公園維護", "志工"], status="持續追蹤",
        location_name="高雄市鳳山區大東公園",
        location_note="提案以大東公園維護與地方志工協作為案例，要求建立支持機制。",
        paragraphs=[
            "公園日常維護除了市府人力，也仰賴地方志工長期投入。陳慧文在地方反映後，將大東公園維護與志工協作問題帶入議會。",
            "第四屆第五次定期大會正式提案要求工務局建立「公園志工支持機制」，並推動跨局處協調。議會決議送請市政府研究辦理，後續制度是否落地仍持續追蹤。",
        ],
        sources=[source("高雄市議會｜第四屆第五次定期大會公園志工支持機制提案", "https://cissearch.kcc.gov.tw/Upload/Attachment/%E5%85%AC%E5%A0%B1%E8%B3%87%E6%96%99/%E9%AB%98%E9%9B%84%E5%B8%82%E8%AD%B0%E6%9C%83/45%E5%8D%B7/5%E6%9C%9F/45%E5%8D%B75%E6%9C%9F09387%E8%B5%B7%E9%A0%8109557%E8%BF%84%E9%A0%81.pdf")],
    ),
]


def update_guangfu(item):
    item.update({
        "title": "光復路排水與道路改善｜經武路至中華街",
        "summary": "陳慧文長期追蹤光復路排水問題，2019年議會質詢持續要求水利局說明進度；市府公開資料顯示，經武路至中華街約650公尺的道路與排水改善工程已於2020年12月完成。",
        "status": "已完成",
        "budget": "1,624萬元（市府公開資料）",
        "updated": TODAY,
        "verifiedAt": TODAY,
        "paragraphs": [
            "光復路遇雨積水問題長期受到地方關注。陳慧文在議會持續追蹤經武路至中華街排水改善工程，要求市府說明設計、經費與發包進度。",
            "市府後續公開資料記載，相關改善計畫範圍約650公尺，工程於2020年12月完成。網站將議員長期追蹤與市府工程完成事實分開呈現。",
        ],
    })
    if not any(h.get("date") == "2020-12" for h in item["history"]):
        item["history"].append({"date":"2020-12","title":"市府公開資料記載工程完成","text":"經武路至中華街約650公尺的道路與排水改善工程完成。"})
    url = "https://orgws.kcg.gov.tw/001/KcgOrgUploadFiles/412/relfile/74414/224634/8a67341d-14e0-4c2b-b6f6-f522e7d9ce59.pdf"
    if not any(s.get("url") == url for s in item["sources"]):
        item["sources"].append(source("高雄市政府｜光復路道路與排水改善工程成果資料", url, "2020-12-31"))
    item["verification"] = {
        "checkedAt": TODAY,
        "content": "已核對2019年議會質詢與市府後續工程成果資料；完工敘述限於來源所載工程範圍",
        "location": "工程範圍為光復路經武路至中華街，約650公尺",
        "attribution": "oversight",
    }


def update_mingfeng(item):
    item["updated"] = TODAY
    item["verifiedAt"] = TODAY
    item["villageHeadPartners"] = [{
        "village": "大德里",
        "name": "侯俊傑",
        "role": "反映道路改善需求；後續辦理會勘與提案追蹤",
        "source": {
            "title": "高雄市議會｜第4屆第5次定期大會工務類第170號提案",
            "url": "https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=F742068CD21A9E29&ct=0A42381EC11CB8EE",
            "sourceDate": "2025-05-29",
        },
    }]
    item["verification"]["checkedAt"] = TODAY
    item["verification"]["attribution"] = "supported"


def update_gaofeng(item):
    item.update({
        "title": "高鳳一路、過埤路51巷口溝渠加蓋",
        "summary": "陳慧文透過議會提案追蹤高鳳一路與過埤路51巷口未加蓋溝渠的通行安全，要求市府研議並辦理溝渠加蓋工程。",
        "categories": ["交通與基建"],
        "subcategories": ["排水", "道路安全"],
        "status": "爭取規劃",
        "locationName": "高雄市鳳山區高鳳一路與過埤路51巷口",
        "locationNote": "議會提案要求針對路口未加蓋溝渠辦理加蓋；尚未取得完工證明。",
        "published": TODAY,
        "updated": TODAY,
        "budget": "",
        "paragraphs": [
            "高鳳一路與過埤路51巷口的未加蓋溝渠影響民眾通行與行車安全。陳慧文將地方需求提出正式議案，要求工務局研議並辦理溝渠加蓋。",
            "現有公開資料可確認議會提案已進入市府研究辦理程序；在取得施工完成或驗收證據前，網站維持「爭取規劃」。",
        ],
        "history": [{"date":"2026","title":"議會提案要求辦理溝渠加蓋","text":"要求工務局針對高鳳一路與過埤路51巷口未加蓋溝渠研議並辦理改善。"}],
        "notes": [],
        "sources": [source("高雄市議會｜陳慧文第4屆第7次定期大會工務類第286號提案", "https://cissearch.kcc.gov.tw/Frame_Councilor.aspx?cname=%E9%99%B3%E6%85%A7%E6%96%87")],
        "related": [],
        "verification": {
            "checkedAt": TODAY,
            "content": "已核對高雄市議會公開提案索引；本來源證明正式提案，不代表工程已完成",
            "location": "提案位置為高鳳一路與過埤路51巷口；既有座標僅作代表點",
            "attribution": "direct",
        },
        "verifiedAt": TODAY,
        "imageDimensions": {},
    })
    item.pop("editorialReview", None)


def main():
    items = json.loads(PATH.read_text())
    byid = {item["id"]: item for item in items}
    if len(byid) != len(items):
        raise SystemExit("duplicate ID in canonical source")

    expected_updates = {"guangfu-drainage", "mingfeng-12-gongyuan-road", "gaofeng-drain"}
    missing_updates = expected_updates - byid.keys()
    if missing_updates:
        raise SystemExit("expected stable IDs missing: " + ",".join(sorted(missing_updates)))

    new_ids = {item["id"] for item in new_records}
    if new_ids & byid.keys():
        raise SystemExit("new IDs already exist; re-audit before applying: " + ",".join(sorted(new_ids & byid.keys())))

    update_guangfu(byid["guangfu-drainage"])
    update_mingfeng(byid["mingfeng-12-gongyuan-road"])
    update_gaofeng(byid["gaofeng-drain"])
    items.extend(new_records)

    PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n")
    print(f"Step 5 applied: {len(new_records)} new, {len(expected_updates)} updated, total {len(items)} records")


if __name__ == "__main__":
    main()
