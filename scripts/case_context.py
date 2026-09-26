"""Render short, source-linked context without inventing current delivery or attribution."""
from html import escape
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit
import json
import re

ROOT = Path(__file__).resolve().parents[1]
FACT_FIELDS = (('impact', '牽涉什麼'), ('councillorAction', '紀錄中的議員動作'), ('governmentRole', '政府端的工作'))


def _load(root):
    path = root / 'data/case-context.json'
    if not path.exists():
        return {}, {}
    data = json.loads(path.read_text())
    if data.get('schemaVersion') != 1 or not isinstance(data.get('cases'), list):
        raise ValueError('Invalid case context schema')
    if not data['cases']:
        return {}, {}
    prepared_on = data.get('preparedOn', '')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', prepared_on):
        raise ValueError('Case context needs an ISO editorial preparation date')
    date.fromisoformat(prepared_on)
    records = {item['id']: item for item in json.loads((root / 'data/achievements-public.json').read_text())}
    contexts = {}
    for context in data['cases']:
        record_id = context.get('recordId')
        if record_id not in records or record_id in contexts or not re.fullmatch(r'[a-z0-9-]+', record_id):
            raise ValueError('Case context requires one unique public record')
        if not isinstance(context.get('question'), str) or not context['question'].strip():
            raise ValueError('Case context question is required')
        sources = {source['url'] for source in records[record_id].get('sources', [])}
        for field, _ in FACT_FIELDS:
            block = context.get(field, {})
            if not isinstance(block.get('text'), str) or not block['text'].strip() or not isinstance(block.get('sources'), list):
                raise ValueError('Case context fact block requires text and source references')
            if field == 'councillorAction':
                if block.get('evidenceStatus') not in ('documented', 'not_collected'):
                    raise ValueError('Councillor attribution must declare its evidence status')
                if block['evidenceStatus'] == 'not_collected' and block['sources']:
                    raise ValueError('Uncollected attribution must not imply supporting evidence')
            if not block['sources'] and not (field == 'councillorAction' and block.get('evidenceStatus') == 'not_collected'):
                raise ValueError('Documented facts require an existing public source')
            for url in block['sources']:
                parsed = urlsplit(url)
                if url not in sources or parsed.scheme != 'https' or parsed.username or parsed.password:
                    raise ValueError('Case context source must be an existing public HTTPS source')
        for field in ('notEstablished', 'nextEvidence'):
            if not isinstance(context.get(field), list) or not context[field] or not all(isinstance(s, str) and s.strip() for s in context[field]):
                raise ValueError('Context needs explicit open points and next evidence')
        contexts[record_id] = dict(context, preparedOn=prepared_on)
    return contexts, records


def render_case_context(record_id, root=ROOT):
    """Return a standalone section, or an empty string for records without a guide."""
    contexts, records = _load(Path(root))
    context = contexts.get(record_id)
    if context is None:
        return ''
    sources = {source['url']: source for source in records[record_id]['sources']}
    e = lambda value: escape(str(value), quote=True)
    heading_id = f'case-context-{record_id}'
    body = f'<section id="case-context" class="case-context" aria-labelledby="{heading_id}"><p class="civic-kicker">閱讀這個議題</p><h2 id="{heading_id}">議題導讀</h2><p class="case-context-updated">導讀整理 <time datetime="{e(context["preparedOn"])}">{e(context["preparedOn"])}</time></p><p class="case-context-question">{e(context["question"])}</p><div class="case-context-grid">'
    for field, title in FACT_FIELDS:
        block = context[field]
        body += f'<div class="case-context-point"><h3>{title}</h3><p>{e(block["text"])}</p>'
        if block['sources']:
            links = []
            for url in block['sources']:
                source = sources[url]
                date = source.get('sourceDate', '')
                links.append(f'<a href="{e(url)}" target="_blank" rel="noopener noreferrer" aria-label="{e(source["title"])}">{e(date)} 閱讀來源 ↗</a>')
            body += '<p class="case-context-sources">' + ' · '.join(links) + '</p>'
        body += '</div>'
    body += '</div><details class="case-context-next"><summary>下一步查什麼</summary><div><h3>目前資料未能確認</h3>'
    body += ''.join(f'<p>{e(text)}</p>' for text in context['notEstablished'])
    body += '<h3>後續可核對的資料</h3><ul>' + ''.join(f'<li>{e(text)}</li>' for text in context['nextEvidence']) + '</ul></div></details></section>'
    return body
