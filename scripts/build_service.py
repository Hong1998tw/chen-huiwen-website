"""Render the current service schedule while retaining validated source history."""
import json, re
from pathlib import Path
from datetime import date, time
from html import escape as e
from urllib.parse import urlsplit
R=Path(__file__).resolve().parents[1]
OWN_SCHEDULE_URL='https://www.huiwen.tw/service.html#monthly-heading'

def validate_schedule(data):
    """Keep dates, public source links and archive boundaries fail-closed."""
    if not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])',str(data.get('month',''))):
        raise ValueError('Legal schedule month must be YYYY-MM')
    u=urlsplit(str(data.get('sourceUrl','')))
    if u.scheme!='https' or not u.hostname or u.username or u.password:
        raise ValueError('Legal schedule sourceUrl must be public HTTPS')
    date.fromisoformat(data['observedAt'])
    dates=[]
    if not isinstance(data.get('sessions'),list) or (not data['sessions'] and 'closedDates' not in data):
        raise ValueError('Legal schedule requires confirmed sessions')
    for slot in data['sessions']:
        day=date.fromisoformat(slot['date'])
        if day.strftime('%Y-%m')!=data['month']:
            raise ValueError('Legal schedule session outside its month')
        for field in ('start','end'):
            if not re.fullmatch(r'\d{2}:\d{2}',str(slot.get(field,''))):
                raise ValueError('Legal schedule time must be HH:MM')
            time.fromisoformat(slot[field])
        if slot['start']>=slot['end']:
            raise ValueError('Legal schedule end must follow start')
        if 'lawyer' in slot and (not isinstance(slot['lawyer'],str) or not slot['lawyer'].strip() or len(slot['lawyer'])>40 or re.search(r'[<>\x00-\x1f]',slot['lawyer'])):
            raise ValueError('Lawyer name must be plain public text')
        dates.append(slot['date'])
    if len(dates)!=len(set(dates)) or dates!=sorted(dates):
        raise ValueError('Legal schedule dates must be unique and sorted')
    weekly=data.get('weekdayTimes')
    if weekly is not None:
        if not isinstance(weekly,dict) or set(weekly)!={'2','3','4','5','6'}:
            raise ValueError('Weekday time keys must cover Tuesday through Saturday')
        for slot in weekly.values():
            if not isinstance(slot,dict) or set(slot)!={'start','end'}:
                raise ValueError('Weekday time needs start and end')
            for key in ('start','end'):
                if not re.fullmatch(r'\d{2}:\d{2}',str(slot[key])):
                    raise ValueError('Weekday time must be HH:MM')
                time.fromisoformat(slot[key])
            if slot['start']>=slot['end']:
                raise ValueError('Weekday end must follow start')
        for slot in data['sessions']:
            weekday=str((date.fromisoformat(slot['date']).weekday()+1)%7)
            if weekday not in weekly or any(slot[k]!=weekly[weekday][k] for k in ('start','end')):
                raise ValueError('Session differs from its confirmed weekday time')
    if data.get('unconfirmedDates'):
        raise ValueError('Unconfirmed draft dates cannot be published')
    if 'closedDates' in data:
        closed=data['closedDates']
        if not isinstance(closed,list) or len(closed)!=len(set(closed)) or set(closed)&set(dates):
            raise ValueError('Closed dates must be unique and separate from sessions')
        for value in closed:
            if date.fromisoformat(value).strftime('%Y-%m')!=data['month']:
                raise ValueError('Closed date outside selected month')
        year,month=map(int,data['month'].split('-'))
        import calendar
        expected={date(year,month,d).isoformat() for d in range(1,calendar.monthrange(year,month)[1]+1) if date(year,month,d).weekday() in range(1,6)}
        if not expected<=set(dates)|set(closed) or any(not s.get('lawyer') for s in data['sessions']):
            raise ValueError('Published monthly plan must be complete')
    months=[]
    for previous in data.get('history',[]):
        if 'history' in previous:
            raise ValueError('Nested schedule history is not supported')
        validate_schedule(previous)
        if previous['month']>=data['month']:
            raise ValueError('Historical schedule must precede the current month')
        months.append(previous['month'])
    if len(months)!=len(set(months)) or months!=sorted(months):
        raise ValueError('Historical schedule months must be unique and sorted')
    return data

def source_markup(data):
    title=e(data.get('sourceTitle') or '服務處公開排程')
    # A first-party text announcement does not require a separate image/card.
    # Its publication URL remains usable by the existing CMS source contract.
    if data['sourceUrl']==OWN_SCHEDULE_URL:
        return title
    return f'<a href="{e(data["sourceUrl"])}" target="_blank" rel="noopener noreferrer">{title} ↗</a>'

def rows_markup(data, current=False):
    rows=[]
    for slot in data['sessions']:
        day=date.fromisoformat(slot['date'])
        attr=f' data-session-date="{day.isoformat()}" data-session-end="{e(slot["end"])}"' if current else ''
        rows.append(f'<tr{attr}><th scope="row"><time datetime="{day.isoformat()}">{day.month}/{day.day}（{"一二三四五六日"[day.weekday()]}）</time></th><td>{e(slot["start"])}–{e(slot["end"])}</td><td>{e(slot.get("lawyer") or "請洽服務處")}</td></tr>')
    return ''.join(rows)

def history_markup(data):
    if not data.get('history'):
        return ''
    parts=[]
    for previous in reversed(data['history']):
        year,month=map(int,previous['month'].split('-'))
        label=f'{year} 年 {month} 月'
        parts.append(f'<section class="schedule-archive-month" data-archive-month="{e(previous["month"])}"><h3>{label}（歷史紀錄）</h3><p>以下日期已過，不提供本月預約；新月份請以上方時間表為準。</p><table><caption>{label}已公布諮詢時段</caption><thead><tr><th scope="col">日期／星期</th><th scope="col">時段</th><th scope="col">律師</th></tr></thead><tbody>{rows_markup(previous)}</tbody></table><p class="source-note">{source_markup(previous)}；核對日期 <time datetime="{e(previous["observedAt"])}">{e(previous["observedAt"])}</time>。</p></section>')
    return '<details class="schedule-archive"><summary>查看過去月份的時間表</summary>'+''.join(parts)+'</details>'

def interactive_markup(data):
    payload={k:data[k] for k in ('month','sessions','closedDates','weekdayTimes') if k in data}
    safe_json=json.dumps(payload,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c')
    return ('<div data-legal-calendar hidden><div class="legal-month-toolbar"><p data-legal-month-state></p>'
        +'<div class="legal-view-buttons" data-legal-modes role="group" aria-label="律師時間表顯示方式" hidden>'
        +'<button type="button" data-legal-view="calendar" aria-pressed="false">月曆</button><button type="button" data-legal-view="list" aria-pressed="true">列表</button><button type="button" data-legal-view="card" aria-pressed="false">圖卡</button></div></div>'
        +'<div class="legal-calendar-layout"><div class="legal-month-grid" aria-label="當月諮詢日期"></div>'
        +'<section class="legal-selected" aria-live="polite"><p data-legal-selection-state></p><p data-legal-date></p><p data-legal-time></p><p data-legal-lawyer></p>'
        +'<a href="tel:+88678212536">電話預約 · 07-821-2536</a></section></div>'
        +'<div class="legal-card-tools"><button class="button button-green" type="button" data-card-download>下載本月圖卡 PNG</button><small>1920 × 1080 · 日期、律師與文字表一致</small></div>'
        +'<div class="legal-card-preview" hidden></div><p data-card-status role="status"></p></div>'
        +'<script type="application/json" id="legal-schedule-data">'+safe_json+'</script>')

def render_schedule(data):
    validate_schedule(data)
    year,month=map(int,data['month'].split('-'))
    month_label=f'{year} 年 {month} 月'
    return f'''<div class="schedule-text" data-schedule-month="{e(data['month'])}"><p class="civic-kicker">公益法律諮詢 · 採預約制</p><h2>{month_label}律師時間表</h2><p class="schedule-guidance">先來電確認日期、時間與名額，再前往服務處。下表只列所示月份已公布的時段，不能當成其他月份的預約安排。</p><p class="schedule-period-note" role="status">本表僅適用於{month_label}；預約其他月份請先來電確認，勿依過期月表直接前往。</p><div class="schedule-call"><a class="button button-green schedule-phone-cta" href="tel:+88678212536">來電預約 <span class="phone-number">07-821-2536</span></a><a class="text-link" href="#legal">預約前須知 ↓</a></div>{interactive_markup(data)}<table><caption>{month_label}公開諮詢時段（非即時名額）</caption><thead><tr><th scope="col">日期／星期</th><th scope="col">時段</th><th scope="col">律師</th></tr></thead><tbody>{rows_markup(data, current=True)}</tbody></table><p class="source-note">{source_markup(data)}；核對日期 <time datetime="{e(data['observedAt'])}">{e(data['observedAt'])}</time>。律師、異動與名額請以服務處確認為準。</p></div>'''

def build():
    data=json.loads((R/'data/legal-schedule.json').read_text())
    body=render_schedule(data)
    path=R/'service.html'
    text=path.read_text()
    if text.count('<!-- legal-schedule:start -->')!=1 or text.count('<!-- legal-schedule:end -->')!=1:
        raise ValueError('Exactly one legal schedule region is required')
    text=re.sub(r'<!-- legal-schedule:start -->.*?<!-- legal-schedule:end -->',lambda _: '<!-- legal-schedule:start -->\n'+body+'\n<!-- legal-schedule:end -->',text,flags=re.S)
    path.write_text(text)
if __name__=='__main__':build()
