"""Shared public metadata contract. Importing this module never runs a build."""
import html

STATUSES = frozenset({'待核驗', '持續追蹤', '爭取規劃', '已完成', '政策實施'})


def is_public(case):
    return case.get('status') in STATUSES - {'待核驗'}


def village_lookup(rows):
    lookup = {}
    for row in rows:
        key = (row.get('district'), row.get('name'))
        if not all(key) or key in lookup:
            raise ValueError('missing or duplicate district/village key')
        for field in ('boundaryName', 'sourceUrl', 'verifiedAt'):
            if not isinstance(row.get(field), str) or not row[field].strip():
                raise ValueError('village metadata missing: ' + field)
        lookup[key] = row
    return lookup


def joined_villages(case, lookup):
    return [lookup[(case['district'], name)] for name in case.get('villages', [])]


def partner_text(case):
    parts = []
    for partner in case.get('villageHeadPartners', []):
        label = ' '.join(x for x in (partner.get('village', ''), partner.get('name', '')) if x)
        if partner.get('role'):
            label += '（' + partner['role'] + '）'
        if label:
            parts.append(label)
    return '；'.join(parts)


def head_text(case, lookup=None):
    """Backward-compatible alias; now means explicit historical partners only."""
    return partner_text(case)


def search_text(case, lookup):
    values = [case.get(k, '') for k in ('title', 'summary', 'scope', 'status', 'locationName', 'locationNote')]
    for field in ('categories', 'subcategories', 'villages', 'paragraphs'):
        values.extend(case.get(field, []))
    for partner in case.get('villageHeadPartners', []):
        values.extend(partner.get(k, '') for k in ('village', 'name', 'role', 'from', 'to'))
    for event in case.get('history', []):
        values.extend(event.get(k, '') for k in ('date', 'title', 'text'))
    return ' '.join(str(v) for v in values if v)


def facts_html(case, lookup):
    rows = joined_villages(case, lookup)
    policy = case.get('scope') == '全市政策'
    facts = [('服務範圍', '高雄市' if policy else case.get('scope', ''))]
    if rows:
        facts.append(('里別', '、'.join(row['name'] for row in rows)))
    partners = partner_text(case)
    if partners:
        facts.append(('合作里長（案件當時）', partners))
    if case.get('locationName') and not policy:
        facts.append(('位置／地址', case['locationName']))
    if case.get('locationNote') and not policy:
        facts.append(('工程範圍／位置說明', case['locationNote']))
    facts.append(('進度', case['status']))
    if case.get('budget'):
        facts.append(('來源所載經費', case['budget']))
    escape = lambda value: html.escape(str(value), quote=True)
    body = ''.join('<div><dt>' + escape(k) + '</dt><dd>' + escape(v) + '</dd></div>' for k, v in facts)
    return '<dl class="case-facts">' + body + '</dl>'
