"""Render service-office schedules with dated, separate historical records."""
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
    if not isinstance(data.get('sessions'),list) or not data['sessions']:
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
        dates.append(slot['date'])
    if len(dates)!=len(set(dates)) or dates!=sorted(dates):
        raise ValueError('Legal schedule dates must be unique and sorted')
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
        attr=f' data-session-date="{day.isoformat()}"' if current else ''
        rows.append(f'<tr{attr}><th scope="row"><time datetime="{day.isoformat()}">{day.month}/{day.day}（{"一二三四五六日"[day.weekday()]}）</time></th><td>{e(slot["start"])}–{e(slot["end"])}</td></tr>')
    return ''.join(rows)

def history_markup(data):
    if not data.get('history'):
        return ''
    parts=[]
    for previous in reversed(data['history']):
        year,month=map(int,previous['month'].split('-'))
        label=f'{year} 年 {month} 月'
        parts.append(f'<section class="schedule-archive-month" data-archive-month="{e(previous["month"])}"><h3>{label}（歷史紀錄）</h3><p>以下日期已過，不提供本月預約；新月份請以上方時間表為準。</p><table><caption>{label}已公布諮詢時段</caption><thead><tr><th scope="col">日期／星期</th><th scope="col">時段</th></tr></thead><tbody>{rows_markup(previous)}</tbody></table><p class="source-note">{source_markup(previous)}；核對日期 <time datetime="{e(previous["observedAt"])}">{e(previous["observedAt"])}</time>。</p></section>')
    return '<details class="schedule-archive"><summary>查看過去月份的時間表</summary>'+''.join(parts)+'</details>'

def render_schedule(data):
    validate_schedule(data)
    year,month=map(int,data['month'].split('-'))
    month_label=f'{year} 年 {month} 月'
    return f'''<div class="schedule-text" data-schedule-month="{e(data['month'])}"><p class="civic-kicker">公益法律諮詢 · 採預約制</p><h2>{month_label}律師時間表</h2><p class="schedule-guidance">先來電確認日期、時間與名額，再前往服務處。下表只列所示月份已公布的時段，不能當成其他月份的預約安排。</p><p class="schedule-period-note" role="status">本表僅適用於{month_label}；預約其他月份請先來電確認，勿依過期月表直接前往。</p><div class="schedule-call"><a class="button button-green schedule-phone-cta" href="tel:+88678212536">來電預約 <span class="phone-number">07-821-2536</span></a><a class="text-link" href="#legal">預約前須知 ↓</a></div><table><caption>{month_label}公開諮詢時段（非即時名額）</caption><thead><tr><th scope="col">日期／星期</th><th scope="col">時段</th></tr></thead><tbody>{rows_markup(data, current=True)}</tbody></table><p class="source-note">{source_markup(data)}；核對日期 <time datetime="{e(data['observedAt'])}">{e(data['observedAt'])}</time>。律師、異動與名額請以服務處確認為準。</p></div>{history_markup(data)}'''

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
