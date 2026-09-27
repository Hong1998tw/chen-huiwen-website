"""Validated per-route SEO overlay for canonical generated and static pages."""
from __future__ import annotations

import html
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

BASE = 'https://www.huiwen.tw/'
FIELDS = {'title', 'description', 'image', 'imageAlt'}
CONTROL = re.compile(r'[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]')


def validate(value, root: Path):
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise ValueError('SEO 欄位格式不正確')
    limits = {'title': 140, 'description': 300, 'image': 500, 'imageAlt': 180}
    for key, limit in limits.items():
        text = value[key]
        if not isinstance(text, str) or not text.strip() or len(text) > limit or CONTROL.search(text) or '<' in text or '>' in text:
            raise ValueError('SEO ' + key + ' 不正確')
    image = value['image']
    parsed = urlsplit(image)
    if parsed.scheme != 'https' or parsed.netloc != 'www.huiwen.tw' or parsed.query or parsed.fragment or not parsed.path.startswith('/assets/'):
        raise ValueError('SEO 分享圖必須是本站 assets 圖片')
    relative = parsed.path.lstrip('/')
    if not re.fullmatch(r'assets/[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp|avif)', relative, re.I) or '..' in Path(relative).parts or not (root / relative).is_file():
        raise ValueError('SEO 分享圖不存在')
    return {key: value[key].strip() for key in FIELDS}


def _meta(source: str, attribute: str, name: str, value: str):
    pattern = re.compile(r'<meta\b(?=[^>]*\b' + attribute + r'\s*=\s*["\']' + re.escape(name) + r'["\'])[^>]*>', re.I)
    matches = list(pattern.finditer(source))
    if len(matches) != 1:
        raise ValueError('SEO meta 欄位缺少或重複：' + name)
    tag = matches[0].group()
    updated, count = re.subn(r'\bcontent\s*=\s*(["\']).*?\1', lambda m: 'content=' + m[1] + html.escape(value, quote=True) + m[1], tag, count=1, flags=re.I | re.S)
    if count != 1:
        raise ValueError('SEO meta content 缺少：' + name)
    return source[:matches[0].start()] + updated + source[matches[0].end():]


def apply(source: str, value: dict, path: str, root: Path):
    seo = validate(value, root)
    title, count = re.subn(r'<title\b[^>]*>.*?</title>', lambda _: '<title>' + html.escape(seo['title']) + '</title>', source, count=1, flags=re.I | re.S)
    if count != 1 or len(re.findall(r'<title\b', source, re.I)) != 1:
        raise ValueError('SEO title 缺少或重複：' + path)
    source = title
    for attribute, name, key in (
        ('name', 'description', 'description'),
        ('property', 'og:title', 'title'), ('property', 'og:description', 'description'),
        ('property', 'og:image', 'image'), ('property', 'og:image:alt', 'imageAlt'),
        ('name', 'twitter:title', 'title'), ('name', 'twitter:description', 'description'),
        ('name', 'twitter:image', 'image'), ('name', 'twitter:image:alt', 'imageAlt'),
    ):
        source = _meta(source, attribute, name, seo[key])
    mime = {'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','webp':'image/webp','avif':'image/avif'}[seo['image'].rsplit('.',1)[-1].lower()]
    if re.search(r'<meta\b(?=[^>]*\bproperty=["\']og:image:type["\'])[^>]*>', source, re.I):
        source = _meta(source, 'property', 'og:image:type', mime)
    # Keep JSON-LD of this route aligned with the visible/search/social description.
    script = re.compile(r'(<script\b[^>]*type=["\']application/ld\+json["\'][^>]*>)(.*?)(</script>)', re.I | re.S)
    for match in reversed(list(script.finditer(source))):
        try:
            data = json.loads(match[2])
        except json.JSONDecodeError as exc:
            raise ValueError('SEO JSON-LD 格式不正確：' + path) from exc
        def update(node):
            if isinstance(node, list):
                for child in node: update(child)
            elif isinstance(node, dict):
                if node.get('@type') in {'WebPage', 'Article', 'ProfilePage', 'CollectionPage', 'ContactPage'} and node.get('url', node.get('@id', '')).split('#')[0] in {BASE + ('' if path == 'index.html' else path), BASE + 'index.html'}:
                    node['name'] = seo['title']
                    node['description'] = seo['description']
                for child in node.values(): update(child)
        update(data)
        output = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
        source = source[:match.start(2)] + output + source[match.end(2):]
    return source
