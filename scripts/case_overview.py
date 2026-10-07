"""A reading overview copied from reviewed public text, without new attribution."""
from html import escape
from case_context import _load
from achievement_metadata import latest_history_event

def render_overview(record, root):
    contexts, _ = _load(root)
    context = contexts.get(record['id'])
    e = lambda value: escape(str(value), quote=True)
    issue = context['impact']['text'] if context else record.get('summary', '')
    if not issue:
        return ''
    latest = latest_history_event(record.get('history', []))
    region = '、'.join(record.get('villages', [])) or record.get('scope') or '未載明'
    category = (record.get('categories') or ['公開紀錄'])[0]
    latest_date = latest.get('date') if latest and latest.get('date') else '未載明'
    action = ''
    if context:
        if context['councillorAction']['evidenceStatus'] == 'documented':
            action = context['councillorAction']['text']
    else:
        # Copy a whole existing paragraph. Never infer a councillor's role from
        # a project status, a government announcement, or an unattributed event.
        action = next((p for p in record.get('paragraphs', []) if '陳慧文' in p), '')
    points = [('議題重點', issue)]
    if action:
        points.append(('慧文的行動', action))
    status = record.get('status', '')
    if context:
        status += '。' + context['governmentRole']['text'].rstrip('。')
    points.append(('紀錄所載階段', status + '。請一併查看事件日期、機關回應與適用限制。'))
    heading = 'case-overview-summary-heading'
    body = (f'<section class="case-overview-summary" id="case-overview-summary" aria-labelledby="{heading}">'
            f'<p class="case-overview-meta"><span>{e(category)}</span><span>地區：{e(region)}</span>'
            f'<span>紀錄階段：{e(record.get("status") or "未載明")}</span>'
            f'<span>最新紀錄：{e(latest_date)}</span></p>'
            f'<h2 id="{heading}">先看懂這件事</h2><div class="case-overview-grid">')
    for title, text in points:
        body += f'<div><h3>{e(title)}</h3><p>{e(text)}</p></div>'
    body += '</div><a class="text-link" href="#case-sources">查看資料來源 ↓</a></section>'
    return body
