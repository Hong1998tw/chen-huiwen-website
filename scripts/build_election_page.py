#!/usr/bin/env python3
"""Build an accessible election index from the public projection; JavaScript is enhancement."""
from pathlib import Path
from html import escape
import json,re
from build_events import calendar_url
ROOT=Path(__file__).resolve().parents[1]
TRACKABLE={'持續追蹤','爭取規劃','政策實施'}
def e(v): return escape(str(v),quote=True)
def latest(item): return max(item.get('history',[]),key=lambda h:h.get('date',''),default=None)
def tracking_items(items):
    return sorted((i for i in items if i.get('status') in TRACKABLE and i.get('sources')),key=lambda i:(latest(i) or {}).get('date',''),reverse=True)
def render_tracking(items):
    cards=[]
    for item in tracking_items(items):
        event=latest(item);url=f'achievement-{e(item["id"])}.html'
        source=next((s for s in reversed(item['sources']) if event and s.get('sourceDate')==event['date']),None)
        when='日期尚未確認'
        if event:
            attr=f' datetime="{e(event["date"])}"' if re.fullmatch(r'\d{4}-\d{2}(?:-\d{2})?',event['date']) else ''
            when=f'<time{attr}>{e(event["date"])}</time>'
        search=' '.join(str(v) for v in [*item.get('categories',[]),*item.get('subcategories',[]),*item.get('villages',[]),*(v for h in item.get('history',[]) for v in h.values())])
        href=source['url'] if source else url+'#case-sources';external=' target="_blank" rel="noopener noreferrer"' if source else ''
        cards.append(f'<article class="campaign-data-card campaign-searchable campaign-tracking-card" data-search="{e(search)}"><p class="campaign-kicker">紀錄所載狀態 · {e(item["status"])}</p><h3><a href="{url}">{e(item["title"])}</a></h3><p>{e(item.get("summary",""))}</p><p class="campaign-record"><span>最新收錄事件 · {when}</span>{"<strong>"+e(event["title"])+"</strong>" if event else ""}</p><p class="campaign-note">歷史紀錄；目前狀態請核對最新公告。</p><div class="campaign-actions"><a class="text-link" href="{url}">完整歷程 →</a><a class="text-link" href="{e(href)}"{external}>{"此階段來源 ↗" if source else "全部來源 →"}</a></div></article>')
    return ''.join(cards)
def render_platforms(data):
    item=next(i for i in data['elections'] if i['year']==2026)
    return ''.join(f'<article class="campaign-data-card campaign-searchable" data-search="{e(" ".join([s["heading"],*s["items"]]))}"><h3>{e(s["heading"])}</h3><ul>'+''.join(f'<li>{e(t)}</li>' for t in s['items'])+'</ul></article>' for s in item['sections'])
def render_events(data):
    cards=[]
    for event in sorted(data['events'],key=lambda i:i['start']):
        status=event.get('status','scheduled');label={'scheduled':'已公告行程','cancelled':'已取消','rescheduled':'已改期'}[status]
        previous=f'<p>原時間：{e(event["previousSchedule"]["start"])}；請以新時間為準。</p>' if status=='rescheduled' else ''
        calendar=f'<a class="text-link" href="{e(calendar_url(event))}" target="_blank" rel="noopener noreferrer">加入 Google Calendar ↗</a>' if status!='cancelled' else ''
        note='<p class="campaign-note">儲存的是當下副本，不會自動更新；出發前請回本站確認。</p>' if status!='cancelled' else ''
        cards.append(f'<article class="campaign-data-card campaign-searchable campaign-event" data-search="{e(event["name"]+" "+event["content"])}"><p class="campaign-kicker">{label}</p><h3>{e(event["name"])}</h3><time datetime="{e(event["start"])}">{e(event["start"][:16].replace("T"," "))}（台灣時間）</time>{previous}{"<p>"+e(event["changeNote"])+"</p>" if event.get("changeNote") else ""}<p>{e(event["content"])}</p><p class="campaign-note">資料更新：{e(event.get("updatedAt",event.get("verifiedAt","尚未標示")))}</p><div class="campaign-actions"><a class="text-link" href="{e(event["sourceUrl"])}" target="_blank" rel="noopener noreferrer">官方資訊 ↗</a>{calendar}</div>{note}</article>')
    return ''.join(cards) or '<p class="campaign-empty">目前沒有收錄公開行程。</p>'
def build():
    public=json.loads((ROOT/'data/achievements-public.json').read_text());platforms=json.loads((ROOT/'data/platforms.json').read_text());events=json.loads((ROOT/'data/events.json').read_text());election=json.loads((ROOT/'data/election-2026.json').read_text())
    records=tracking_items(public);platform=next(i for i in platforms['elections'] if i['year']==2026);count=sum(len(s['items']) for s in platform['sections'])
    body=f'''<main id="main">
<section class="campaign-hero"><div class="wrap campaign-hero-copy"><p class="eyebrow">2026 · 鳳山</p><h1>鳳山選舉資訊中心</h1><p class="campaign-lead">了解政見、核對公開紀錄，掌握選務日期。</p><div class="campaign-search" id="search"><label for="campaign-search">搜尋本頁</label><input id="campaign-search" type="search" placeholder="輸入學校、道路、議題或活動名稱" autocomplete="off" aria-describedby="campaign-search-count"><span id="campaign-search-count" class="campaign-note" role="status">搜尋本頁政見、全部追蹤紀錄與未來公開行程</span></div><div id="campaign-no-results" class="campaign-empty" hidden><p>本頁沒有符合項目；其他建設、新聞與服務資訊可使用全站搜尋。</p><button type="button" class="button button-outline" id="campaign-search-all">到全站搜尋此關鍵字 →</button></div><noscript><p class="campaign-note">本頁已列出全部紀錄；可使用瀏覽器的「在頁面中尋找」。</p></noscript></div></section>
<section class="wrap campaign-shell campaign-countdown-wrap" aria-labelledby="countdown-heading"><div class="campaign-countdown"><div><p class="campaign-kicker" id="countdown-heading">投票日期</p><strong id="campaign-countdown">11/28</strong> <span id="campaign-countdown-unit">2026 年</span></div></div><div class="campaign-keydates"><div class="campaign-keydate" id="campaign-number-draw"><strong>{e(election['numberDrawDate'].replace('-','/'))}</strong><span>候選人姓名號次抽籤</span></div><div class="campaign-keydate" id="campaign-vote-date"><strong>{e(election['voteDate'].replace('-','/'))}</strong><span>投票日</span><small>{e(election['pollsOpen'])}–{e(election['pollsClose'])}</small></div><p class="campaign-election-source" id="campaign-election-source"><a href="{e(election['sources'][0]['url'])}" target="_blank" rel="noopener noreferrer">高雄市選舉委員會選務時程 ↗</a></p></div><p id="campaign-date-error" class="campaign-note" role="status" hidden></p></section>
<nav class="wrap campaign-page-links" aria-label="選舉資訊分區"><a class="campaign-nav-card" href="achievements.html">全部建設紀錄 →</a><a class="campaign-nav-card" href="#platforms">2026 政見 ↓</a><a class="campaign-nav-card" href="#tracking">公開追蹤紀錄 ↓</a><a class="campaign-nav-card" href="#schedule">公開行程 ↓</a><a class="campaign-nav-card" href="news.html">新聞與媒體 →</a></nav>
<section class="campaign-section wrap" id="platforms" aria-labelledby="platforms-heading"><div class="campaign-section-head"><div><p class="eyebrow">2026 PLATFORM</p><h2 id="platforms-heading">2026 政見</h2><p><span id="campaign-platform-count">{count}</span> 項政策主張；進一步核對承諾與相關紀錄。</p></div><a class="text-link" href="vision.html#platform-2026">政見與追蹤 →</a></div><p class="campaign-source-note" id="campaign-platform-status">政見是政策主張，實際辦理情形請分別核對相關公開紀錄。</p><p id="campaign-platform-error" class="campaign-note" role="status" hidden></p><div class="campaign-data-grid" id="campaign-platforms">{render_platforms(platforms)}</div></section>
<section class="campaign-section wrap" id="tracking" aria-labelledby="tracking-heading"><div class="campaign-section-head"><div><p class="eyebrow">PUBLIC RECORDS</p><h2 id="tracking-heading">公開追蹤紀錄</h2><p>收錄 <span id="campaign-tracking-count">{len(records)}</span> 筆有來源、原紀錄標示「持續追蹤」「爭取規劃」或「政策實施」的議題。</p></div><a class="text-link" href="achievements.html">全部建設與進度 →</a></div><p class="campaign-record-note">按最新收錄事件日期排列。狀態描述該筆紀錄當時的階段，不代表今日仍在施工或已獲承諾；網站整理日期不作為事件日期。</p><p id="campaign-tracking-summary" class="campaign-note" role="status">以下列出全部 {len(records)} 筆。</p><p id="campaign-tracking-error" class="campaign-note" role="status" hidden></p><div class="campaign-data-grid" id="campaign-tracking" data-total="{len(records)}">{render_tracking(public)}</div><button id="campaign-tracking-more" class="button button-outline" type="button" hidden>顯示全部 {len(records)} 筆追蹤紀錄</button></section>
<section class="campaign-section wrap" id="schedule" aria-labelledby="schedule-heading"><div class="campaign-section-head"><div><p class="eyebrow">PUBLIC SCHEDULE</p><h2 id="schedule-heading">公開行程與活動</h2><p>查看公告時間與異動；出發前請再次確認官方資訊。</p></div><a class="text-link" href="activities.html">全部公開行程與活動 →</a></div><p class="campaign-note">頁面會依目前日期顯示未來行程；未啟用 JavaScript 時，以下保留發布時收錄的紀錄。</p><span id="campaign-event-count" hidden>{len(events['events'])}</span><p id="campaign-events-error" class="campaign-note" role="status" hidden></p><div id="campaign-events">{render_events(events)}</div></section>
</main>'''
    path=ROOT/'election.html';text=path.read_text();text=re.sub(r'<main\b.*?</main>',lambda _:body,text,count=1,flags=re.S)
    if not re.search(r'src="campaign\.js',text):text=text.replace('<script src="election.js','<script src="campaign.js?v=20260922-maturity-v12" defer></script><script src="election.js')
    text=text.replace('勝選倒數、選務日期、2026 政見、政績、持續推動議題、公開行程與新聞。','選務日期、2026 政見、公开追蹤紀錄、公開行程與新聞。').replace('公开','公開')
    text=text.replace('持續推動議題','公開追蹤紀錄')
    path.write_text(text)
    print(f'Built election page: {count} platform items / {len(records)} public tracking records')
if __name__=='__main__':build()
