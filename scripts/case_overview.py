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
    points = [('這件事與生活', issue)]
    if action:
        points.append(('慧文的行動', action))
    status = record.get('status', '')
    if context:
        status += '。' + context['governmentRole']['text'].rstrip('。')
    points.append(('目前階段', status + '。事情發生的時間、機關回應與適用限制，請一併閱讀最新紀錄及完整來源。'))
    heading = 'case-overview-summary-heading'
    body = f'<section class="case-overview-summary" id="case-overview-summary" aria-labelledby="{heading}"><h2 id="{heading}">先看懂這件事</h2><div class="case-overview-grid">'
    for title, text in points:
        body += f'<div><h3>{e(title)}</h3><p>{e(text)}</p></div>'
    body += '</div><a class="text-link" href="#case-sources">核對完整資料來源 ↓</a></section>'
    return body
