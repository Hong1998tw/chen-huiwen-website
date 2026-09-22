"""Render an accessible transcription of the public schedule, never availability."""
import json, re
from pathlib import Path
from datetime import date, time
from html import escape as e
R=Path(__file__).resolve().parents[1]
def build():
    data=json.loads((R/'data/legal-schedule.json').read_text())
    year,month=map(int,data['month'].split('-'))
    month_label=f'{year} 年 {month} 月'
    rows=[]
    dates=[]
    for slot in data['sessions']:
        day=date.fromisoformat(slot['date'])
        assert slot['date'].startswith(data['month'])
        for field in ('start','end'):
            assert re.fullmatch(r'\d{2}:\d{2}',slot[field])
            time.fromisoformat(slot[field])
        assert slot['start'] < slot['end']
        dates.append(slot['date'])
        rows.append(f'<tr data-session-date="{day.isoformat()}"><th scope="row"><time datetime="{day.isoformat()}">{day.month}/{day.day}（{"一二三四五六日"[day.weekday()]}）</time></th><td>{e(slot["start"])}–{e(slot["end"])}</td></tr>')
    assert len(dates)==len(set(dates)) and dates==sorted(dates)
    body=f'''<div class="schedule-text" data-schedule-month="{e(data['month'])}"><p class="civic-kicker">公益法律諮詢 · 採預約制</p><h2>{month_label}律師時間表</h2><p>先選日期，再來電確認名額。未列出的日期，原圖未安排諮詢。</p><p class="schedule-period-note" role="status">本表僅適用於{month_label}；其他月份請查看服務處原圖或來電確認。</p><div class="schedule-call"><a class="button button-green schedule-phone-cta" href="tel:+88678212536">來電預約 <span class="phone-number">07-821-2536</span></a><a class="text-link" href="#legal">預約前須知 ↓</a></div><table><caption>{month_label}公開諮詢時段（非即時名額）</caption><thead><tr><th scope="col">日期／星期</th><th scope="col">時段</th></tr></thead><tbody>{''.join(rows)}</tbody></table><p class="source-note">依<a href="{e(data['sourceUrl'])}" target="_blank" rel="noopener noreferrer">服務處公開圖卡 ↗</a>整理；核對日期 <time datetime="{e(data['observedAt'])}">{e(data['observedAt'])}</time>。律師名單、異動與名額請以服務處確認為準。</p></div>'''
    path=R/'service.html'
    text=path.read_text()
    assert '<!-- legal-schedule:start -->' in text, 'Missing legal schedule marker'
    text=re.sub(r'<!-- legal-schedule:start -->.*?<!-- legal-schedule:end -->',lambda _: '<!-- legal-schedule:start -->\n'+body+'\n<!-- legal-schedule:end -->',text,flags=re.S)
    path.write_text(text)
if __name__=='__main__':build()
