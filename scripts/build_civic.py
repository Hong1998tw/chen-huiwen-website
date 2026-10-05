"""Generate public discovery views from existing reviewed records; no remote input."""
from python_guard import require_supported_python
require_supported_python()
from pathlib import Path
from decimal import Decimal, ROUND_HALF_UP
import json, html, re, math
from achievement_metadata import is_public

R = Path(__file__).resolve().parents[1]
STATION_ID = 'metro-green-line'


def e(value):
    return html.escape(str(value), quote=True)


def block(text, name, body):
    pattern = rf'<!-- {name}:start -->.*?<!-- {name}:end -->'
    replacement = f'<!-- {name}:start -->\n{body}\n<!-- {name}:end -->'
    if not re.search(pattern, text, re.S):
        raise ValueError('Missing generation marker ' + name)
    return re.sub(pattern, lambda _: replacement, text, flags=re.S)


def amount_wan(value):
    """Format the canonical TWD amount in ten-thousands without inventing totals."""
    amount = (Decimal(str(value)) / Decimal(10000)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
    return f'{amount:,.2f}'.rstrip('0').rstrip('.')


def funding_of(record):
    funding = record.get('funding')
    if not isinstance(funding, dict) or funding.get('currency') != 'TWD':
        return None
    values = [funding.get(key) for key in ('total', 'centralGrant')]
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or
           not math.isfinite(value) or value < 0 for value in values):
        return None
    return funding if values[0] >= values[1] else None


def story_title(record):
    return '海邦橋' if record['id'] == 'haibang-bridge' else record['title']


def summary_for(config, record):
    # Keep the same blank-summary fallback as the authenticated CMS preview.
    value = config.get('summaries', {}).get(record['id'], '')
    return value.strip() or record.get('summary', '')


def render_photo(record, class_name, station=False):
    if not record or not record.get('images'):
        return ''
    image = record['images'][0]
    metadata = record.get('imageMetadata', {}).get(image)
    dimensions = record.get('imageDimensions', {}).get(image)
    if not metadata or not dimensions or len(dimensions) != 2:
        return ''
    width, height = dimensions
    caption = ('鳳山車站 · ' if station else '') + metadata.get('caption', '')
    return (
        f'<figure class="{e(class_name)}"><img src="assets/{e(image)}" '
        f'alt="{e(metadata.get("alt", ""))}" width="{e(width)}" height="{e(height)}" '
        f'loading="lazy" decoding="async"><figcaption>{e(caption)} · '
        f'<a href="{e(metadata.get("sourceUrl", ""))}" target="_blank" '
        f'rel="noopener noreferrer">{e(metadata.get("credit", ""))} ↗</a></figcaption></figure>'
    )


def render_funding(record):
    funding = funding_of(record)
    if not funding:
        return ''
    difference = Decimal(str(funding['total'])) - Decimal(str(funding['centralGrant']))
    approved = funding.get('approvedOn', '')
    reference = funding.get('approvalReference', '')
    source = ''
    if funding.get('sourceUrl'):
        source = (f'<a class="source civic-funding-source" href="{e(funding["sourceUrl"])}" '
                  f'target="_blank" rel="noopener noreferrer">{e(funding.get("sourceTitle") or "核對經費來源")} ↗</a>')
    return (
        f'<aside class="budget civic-feature-funding" aria-label="{e(record["title"])}核定經費">'
        f'<p class="kicker">核定計畫總經費</p><p class="amount">{amount_wan(funding["total"])}<small>萬元</small></p>'
        f'<dl><dt>中央補助</dt><dd>{amount_wan(funding["centralGrant"])}萬元</dd>'
        f'<dt>中央補助以外差額</dt><dd>{amount_wan(difference)}萬元</dd>'
        f'<dt>核定日期</dt><dd><time datetime="{e(approved)}">{e(approved.replace("-", "."))}</time></dd></dl>'
        f'<p class="note">{e(reference)}<br>核定計畫金額，非決算或已撥款。</p>{source}</aside>'
    )


def render_stories(config, data):
    featured = data[config['featured']]
    url = 'achievement-' + featured['id'] + '.html'
    funding = funding_of(featured)
    collaboration = (f'<p class="civic-collaboration">{e(funding["collaboration"])}</p>'
                     if funding and funding.get('collaboration') else '')
    side = render_funding(featured) or render_photo(featured, 'civic-feature-photo')
    feature_class = 'feature civic-feature' + ('' if side else ' civic-feature--text-only')
    copy = (
        f'<div class="civic-feature-copy"><p class="stage civic-kicker">'
        f'{e((featured.get("categories") or ["地方專題"])[0])} · {e(featured.get("status", ""))}</p>'
        f'<h3><a href="{e(url)}">{e(story_title(featured))}</a></h3>'
        f'<p>{e(summary_for(config, featured))}</p>{collaboration}'
        f'<a class="source civic-read" href="{e(url)}#case-sources">閱讀歷程與資料來源 ↗</a>'
        f'<small class="meta">內容整理 <time datetime="{e(featured["updated"])}">{e(featured["updated"])}</time></small></div>'
    )
    rows = []
    for record_id in config['reading']:
        record = data[record_id]
        rows.append(
            f'<article class="civic-reading-row" data-record-id="{e(record_id)}"><div>'
            f'<p class="meta civic-kicker">{e((record.get("categories") or ["地方專題"])[0])} · {e(record.get("status", ""))}</p>'
            f'<h3><a href="achievement-{e(record_id)}.html">{e(story_title(record))}</a></h3>'
            f'<p>{e(summary_for(config, record))}</p>'
            f'<small class="meta">內容整理 <time datetime="{e(record["updated"])}">{e(record["updated"])}</time></small>'
            f'</div></article>'
        )
    # This verified context image always remains explicitly identified as Fengshan
    # Station; CMS selection changes must not relabel it as another project's photo.
    station = render_photo(data.get(STATION_ID), 'station civic-reading-photo', station=True)
    stories_class = 'stories' + ('' if station else ' stories--text-only')
    return (f'<article class="{feature_class}" data-record-id="{e(featured["id"])}">{copy}{side}</article>'
            f'<div class="{stories_class}">{station}<div class="story-list civic-reading">'
            + ''.join(rows) + '</div></div>')


def render_home_map(config, data):
    """Optional map-entry list; uses the same editable selection and stable IDs."""
    ids = [config['featured'], *config['reading']]
    rows = []
    for record_id in ids:
        record = data[record_id]
        categories = record.get('categories') or []
        topic = 'education' if '教育與文化' in categories else 'transport' if '交通與基建' in categories else 'other'
        funding = funding_of(record)
        status = ('核定總經費' + amount_wan(funding['total']) + '萬元') if funding else record.get('status', '')
        detail = '　／　'.join([*record.get('villages', []), status])
        rows.append(
            f'<article class="place" data-topic="{topic}" data-record-id="{e(record_id)}">'
            f'<a href="achievement-{e(record_id)}.html">{e(story_title(record))} ↗</a><p>{e(detail)}</p></article>'
        )
    return ''.join(rows) + f'<p class="meta" id="filter-status" aria-live="polite">本頁精選{len(ids)}筆，不代表全部案件或完工數。</p>'


def build():
    data = {row['id']: row for row in json.loads((R / 'data/achievements.json').read_text()) if is_public(row)}
    config = json.loads((R / 'data/civic-home.json').read_text())
    ids = [config['featured'], *config['reading']]
    if not 1 <= len(config['reading']) <= 12 or len(set(ids)) != len(ids) or any(record_id not in data for record_id in ids):
        raise ValueError('Home selection must reference unique public records and one to twelve reading records')
    if set(config.get('summaries', {})) != set(ids):
        raise ValueError('Home summaries must match selected public records')
    page = R / 'index.html'
    text = block(page.read_text(), 'civic-stories', render_stories(config, data))
    if '<!-- civic-home-map:start -->' in text:
        text = block(text, 'civic-home-map', render_home_map(config, data))
    if '<!-- civic-questions:start -->' in text:
        guides = {item['recordId']: item for item in json.loads((R / 'data/case-context.json').read_text())['cases']}
        question_ids = ('metro-green-line', 'after-school-care', 'bade-detention')
        if any(record_id not in data or record_id not in guides for record_id in question_ids):
            raise ValueError('Home questions must reference reviewed public context')
        questions = ''.join(f'<article class="civic-feature-copy"><h3>{e(guides[record_id]["question"])}</h3><a class="civic-read" href="achievement-{e(record_id)}.html">閱讀議題與來源 <span aria-hidden="true">→</span></a></article>' for record_id in question_ids)
        question_html = '<section class="wrap civic-reading-guide" id="civic-questions" aria-labelledby="civic-questions-heading"><h2 id="civic-questions-heading">從鳳山日常，問一個具體問題</h2><p>從交通、照顧與防汛，了解地方需求、議會提問與市府辦理進度。</p><div>' + questions + '</div></section>'
        text = block(text, 'civic-questions', question_html)
    page.write_text(text)
    print('Built public civic home selections')


if __name__ == '__main__':
    build()
