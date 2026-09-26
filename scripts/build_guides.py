#!/usr/bin/env python3
"""Build practical service guides; derive office facts from the canonical service page.

The shared page skeleton is reused without modifying its template. build_shared.py
owns final navigation, footer and asset hashes. This builder never reads the clock.
"""
from datetime import date
from html import escape
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
PAGE = 'service-guides.html'
BASE = 'https://www.huiwen.tw/' + PAGE


def e(value):
    return escape(str(value), quote=True)


def validate_url(value):
    if not isinstance(value, str):
        raise ValueError('Guide links must be strings')
    parsed = urlsplit(value)
    if parsed.scheme == 'https' and parsed.hostname and not (parsed.username or parsed.password):
        return
    if re.fullmatch(r'tel:\+?\d+', value):
        return
    if re.fullmatch(r'(?:service\.html)?#[a-z][a-z0-9-]*', value):
        return
    raise ValueError('Guide links must use public HTTPS, a telephone or a service anchor')


def validate(data):
    if data.get('schemaVersion') != 1:
        raise ValueError('Unsupported service guide schema')
    for field in ('title', 'description'):
        if not isinstance(data.get(field), str) or not data[field].strip():
            raise ValueError(f'Missing guide page {field}')
    date.fromisoformat(data['checkedAt'])
    if not isinstance(data.get('guides'), list) or not data['guides']:
        raise ValueError('At least one service guide is required')
    seen = set()
    for guide in data['guides']:
        guide_id = guide.get('id', '')
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', guide_id) or guide_id in seen:
            raise ValueError('Guide IDs must be unique lowercase URL slugs')
        seen.add(guide_id)
        for field in ('title', 'summary'):
            if not isinstance(guide.get(field), str) or not guide[field].strip():
                raise ValueError(f'Missing guide {field}')
        for field in ('preparation', 'assistance', 'steps'):
            values = guide.get(field)
            if not isinstance(values, list) or not values or any(not isinstance(v, str) or not v.strip() for v in values):
                raise ValueError(f'{field} must contain readable text')
        responsible = guide.get('responsible', {})
        if responsible.get('reference'):
            if responsible['reference'] != 'service-office':
                raise ValueError('Unknown responsible office reference')
        elif not responsible.get('name'):
            raise ValueError('A responsible agency or service window is required')
        if not responsible.get('note'):
            raise ValueError('A service window scope note is required')
        if not guide.get('actions') or not guide.get('sources'):
            raise ValueError('Every guide needs an action and a source')
        for action in guide['actions']:
            if not action.get('label'):
                raise ValueError('Every action needs a readable label')
            if action.get('reference'):
                if action['reference'] not in ('office-phone', 'office-map') or 'url' in action:
                    raise ValueError('Unknown or ambiguous action reference')
            else:
                validate_url(action['url'])
        for source in guide['sources']:
            if source.get('reference'):
                if source['reference'] != 'legal-schedule' or 'url' in source:
                    raise ValueError('Unknown or ambiguous source reference')
            else:
                if not source.get('title') or not source.get('url', '').startswith('https://'):
                    raise ValueError('Source title and public HTTPS URL are required')
                validate_url(source['url'])
                date.fromisoformat(source['checkedAt'])


def load_office(root):
    """Fail if canonical contact structure changes instead of inventing a fallback."""
    soup = BeautifulSoup((root / 'service.html').read_text(), 'html.parser')
    contact = soup.select_one('#contact')
    if contact is None:
        raise ValueError('Canonical service contact section is missing')
    phone = contact.select_one('.big-phone')
    number = contact.select_one('.phone-number')
    address_label = next((dt for dt in contact.select('dt') if dt.get_text(strip=True) == '地址'), None)
    address = address_label.find_next_sibling('dd').find('a') if address_label else None
    hours = [(row.find('dt').get_text(' ', strip=True), row.find('dd').get_text('、', strip=True))
             for row in contact.select('.hours > div')]
    if phone is None or number is None or address is None or not hours:
        raise ValueError('Canonical service phone, address or hours are missing')
    # Decorative link arrows are not part of the address.
    address_text = ''.join(str(child) for child in address.children if isinstance(child, str)).strip()
    if not address_text:
        raise ValueError('Canonical office address text is missing')
    profile = json.loads((root / 'data/site-profile.json').read_text())
    office = {
        'name': profile['person']['name'] + '服務處',
        'phone': number.get_text(strip=True), 'phoneUrl': phone['href'],
        'address': address_text, 'mapUrl': address['href'], 'hours': hours,
    }
    validate_url(office['phoneUrl'])
    validate_url(office['mapUrl'])
    return office


def resolve_source(source, legal):
    if source.get('reference') == 'legal-schedule':
        resolved = {'title': legal['sourceTitle'], 'url': legal['sourceUrl'], 'checkedAt': legal['observedAt']}
        validate_url(resolved['url'])
        date.fromisoformat(resolved['checkedAt'])
        return resolved
    return source


def link(label, url, class_name=''):
    validate_url(url)
    external = url.startswith('https://') and not url.startswith('https://www.huiwen.tw/')
    attrs = ' target="_blank" rel="noopener noreferrer"' if external else ''
    classes = f' class="{e(class_name)}"' if class_name else ''
    suffix = ' <span aria-hidden="true">↗</span><span class="sr-only">（另開外部網站）</span>' if external else ''
    return f'<a href="{e(url)}"{classes}{attrs}>{e(label)}{suffix}</a>'


def render_guides(data, office, legal):
    validate(data)
    result = ['<section class="page-head"><div class="wrap"><p class="eyebrow">市民服務</p>',
              f'<h1>{e(data["title"])}</h1><p>{e(data["description"])}</p>',
              '<div class="actions"><button type="button" class="button button-outline print-page" hidden>列印服務指南</button></div>',
              f'<p class="source-note">指南查核日期：<time datetime="{e(data["checkedAt"])}">{e(data["checkedAt"])}</time>。下列準備事項為聯絡前的整理建議。</p>',
              '</div></section><div class="wrap guide-layout">',
              '<nav class="guide-index" aria-label="選擇服務指南">']
    for guide in data['guides']:
        result.append(f'<a href="#{e(guide["id"])}">{e(guide["title"])}</a>')
    result.append('</nav><div class="guide-content">')
    for guide in data['guides']:
        result += [f'<article class="service-guide" id="{e(guide["id"])}" aria-labelledby="{e(guide["id"])}-title">',
                   f'<p class="eyebrow">服務指南</p><h2 id="{e(guide["id"])}-title">{e(guide["title"])}</h2>',
                   f'<p class="guide-summary">{e(guide["summary"])}</p><div class="guide-sections">',
                   '<section><h3>聯絡前建議準備</h3><ul>']
        result += [f'<li>{e(item)}</li>' for item in guide['preparation']]
        result.append('</ul></section><section><h3>可協助範圍</h3>')
        result += [f'<p>{e(item)}</p>' for item in guide['assistance']]
        responsible = guide['responsible']
        name = office['name'] if responsible.get('reference') == 'service-office' else responsible['name']
        result += ['</section><section><h3>承辦機關／服務窗口</h3>',
                   f'<p><strong>{e(name)}</strong></p><p>{e(responsible["note"])}</p>',
                   '</section><section><h3>下一步</h3><ol>']
        result += [f'<li>{e(item)}</li>' for item in guide['steps']]
        result.append('</ol><div class="actions guide-actions">')
        for action in guide['actions']:
            url = {'office-phone': office['phoneUrl'], 'office-map': office['mapUrl']}.get(action.get('reference'), action.get('url'))
            result.append(link(action['label'], url, 'button button-outline'))
        result.append('</div></section></div><div class="guide-sources"><h3>來源與查核</h3><ul>')
        for original in guide['sources']:
            source = resolve_source(original, legal)
            result.append(f'<li>{link(source["title"], source["url"])}<span class="source-note">查核日期：<time datetime="{e(source["checkedAt"])}">{e(source["checkedAt"])}</time></span></li>')
        result.append('</ul></div></article>')
    result += ['<section class="guide-office" id="office-details" aria-labelledby="office-details-title">',
               f'<h2 id="office-details-title">{e(office["name"])}聯絡資訊</h2>',
               '<dl class="guide-contact-list"><dt>電話</dt>',
               f'<dd>{link(office["phone"], office["phoneUrl"])}</dd><dt>地址</dt>',
               f'<dd>{link(office["address"], office["mapUrl"])}</dd>']
    for day, times in office['hours']:
        result.append(f'<dt>{e(day)}</dt><dd>{e(times)}</dd>')
    result += ['</dl><p>公益律師諮詢請先預約；當次場次與名額請來電確認。</p>',
               '<p class="source-note">聯絡與來訪資訊取自本站服務資訊頁。</p></section>',
               '<p class="guide-print-note">列印版本僅供查閱；前往或聯絡前，請回官網核對最新公告。<br>',
               link(BASE, BASE), '</p></div></div>']
    return '\n'.join(result)


def build(root=ROOT):
    data = json.loads((root / 'data/service-guides.json').read_text())
    legal = json.loads((root / 'data/legal-schedule.json').read_text())
    body = render_guides(data, load_office(root), legal)
    template = (root / 'templates/events-page.html').read_text()
    head, sep, rest = template.partition('<body>')
    if not sep or template.count('{{EVENTS}}') != 1:
        raise ValueError('Shared page skeleton changed')
    old_description = '陳慧文公開行程與鳳山活動資訊；最新場次、時間與報名方式以本頁公告為準。'
    title = data['title'] + '｜陳慧文服務處'
    head = head.replace('陳慧文公開行程與活動｜鳳山活動與服務處資訊', e(title))
    head = head.replace('陳慧文公開行程與活動', '陳慧文服務處市民服務指南')
    head = head.replace('公開行程與活動', e(data['title']))
    head = head.replace(old_description, e(data['description']))
    head = head.replace('https://www.huiwen.tw/activities.html', BASE)
    # JSON-LD must use JSON escaping, separately from HTML attribute escaping.
    graph = [
        {'@context': 'https://schema.org', '@type': 'CollectionPage', '@id': BASE + '#collection',
         'name': title, 'url': BASE, 'description': data['description'], 'inLanguage': 'zh-Hant-TW'},
        {'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': [
            {'@type': 'ListItem', 'position': 1, 'name': '首頁', 'item': 'https://www.huiwen.tw/'},
            {'@type': 'ListItem', 'position': 2, 'name': data['title'], 'item': BASE}]},
    ]
    structured = json.dumps(graph, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
    head, count = re.subn(r'(<script type="application/ld\+json">).*?(</script>)',
                          lambda m: m[1] + structured + m[2], head, flags=re.S)
    if count != 1:
        raise ValueError('Expected one structured metadata script')
    rest = rest.replace(' aria-current="page"', '')
    rest = rest.replace('class="activities-page"', 'class="service-guides-page"').replace('{{EVENTS}}', body)
    rendered = head + sep + rest
    (root / PAGE).write_text(rendered)
    print(f'Built {PAGE} from {len(data["guides"])} service guides')
    return rendered


if __name__ == '__main__':
    build()
