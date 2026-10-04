"""A reading overview copied from reviewed public text, without new attribution."""
from html import escape
from case_context import _load

def render_overview(record, root):
    contexts, _ = _load(root)
    context = contexts.get(record['id'])
    e = lambda value: escape(str(value), quote=True)
    issue = context['impact']['text'] if context else record.get('summary', '')
    if not issue:
        return ''
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
    body = f'<section class="case-overview-summary" id="case-overview-summary" aria-labelledby="{heading}"><h2 id="{heading}">先看懂這件事</h2><div class="case-overview-grid">'
    for title, text in points:
        body += f'<div><h3>{e(title)}</h3><p>{e(text)}</p></div>'
    body += '</div><a class="text-link" href="#case-sources">查看資料來源 ↓</a></section>'
    return body
