"""Shared public metadata contract. Importing this module never runs a build."""
import html
import re

STATUSES = frozenset({'待核驗', '持續追蹤', '爭取規劃', '已完成', '政策實施'})


def is_public(case):
    return case.get('status') in STATUSES - {'待核驗'}


def village_lookup(rows):
    lookup = {}
    for row in rows:
        key = (row.get('district'), row.get('name'))
        if not all(key) or key in lookup:
            raise ValueError('missing or duplicate district/village key')
        for field in ('currentHead', 'sourceUrl', 'verifiedAt'):
            if not isinstance(row.get(field), str) or not row[field].strip():
                raise ValueError('village metadata missing: ' + field)
        lookup[key] = row
    return lookup


def joined_villages(case, lookup):
    return [lookup[(case['district'], name)] for name in case.get('villages', [])]


def head_text(case, lookup):
    rows = joined_villages(case, lookup)
    if len(rows) == 1:
        return rows[0]['currentHead']
    return '；'.join(row['name'] + ' ' + row['currentHead'] for row in rows)


def search_text(case, lookup):
    values = [case.get(k, '') for k in ('title', 'summary', 'scope', 'status', 'locationName', 'locationNote')]
    for field in ('categories', 'subcategories', 'villages', 'paragraphs'):
        values.extend(case.get(field, []))
    values.extend(row['currentHead'] for row in joined_villages(case, lookup))
    for event in case.get('history', []):
        values.extend(event.get(k, '') for k in ('date', 'title', 'text'))
    return ' '.join(str(v) for v in values if v)


def facts_html(case, lookup):
    rows = joined_villages(case, lookup)
    policy = case.get('scope') == '全市政策'
    facts = [('服務範圍', '高雄市' if policy else case.get('scope', ''))]
    if rows:
        facts += [('里別', '、'.join(row['name'] for row in rows)), ('現任里長', head_text(case, lookup))]
    elif policy:
        facts.append(('現任里長', '不適用'))
    if case.get('locationName') and not policy:
        facts.append(('位置／地址', case['locationName']))
    if case.get('locationNote') and not policy:
        facts.append(('工程範圍／位置說明', case['locationNote']))
    facts.append(('進度', case['status']))
    if case.get('budget'):
        facts.append(('來源所載經費', case['budget']))
    escape = lambda value: html.escape(str(value), quote=True)
    body = ''.join('<div><dt>' + escape(k) + '</dt><dd>' + escape(v) + '</dd></div>' for k, v in facts)
    # Verification belongs to the joined current directory, never to historical attribution.
    if rows:
        dates = '、'.join(sorted({r['verifiedAt'] for r in rows}))
        body += '<div><dt>里長名錄更新</dt><dd>' + escape(dates) + '</dd></div>'
    return '<dl class="case-facts">' + body + '</dl>'
