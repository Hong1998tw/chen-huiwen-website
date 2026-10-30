#!/usr/bin/env python3
"""Render shared chrome inside explicit regions; preserve every page's main bytes."""
from python_guard import require_supported_python
require_supported_python()
from pathlib import Path
import hashlib
import html
import json
import re
from urllib.parse import urljoin, urlsplit
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
SITE_BASE = 'https://www.huiwen.tw/'
THEME_COLOR = '#6356a3'  # brand deep purple


def link_arrow(href):
    """Use a right arrow for this site and contact actions, an up-right arrow elsewhere."""
    value = str(href or '')
    if urlsplit(value).scheme.lower() in {'mailto', 'tel'}:
        return '→'
    destination = urlsplit(urljoin(SITE_BASE, value))
    origin = urlsplit(SITE_BASE)

    def origin_key(url):
        scheme = url.scheme.lower()
        try:
            port = url.port
        except ValueError:
            return (scheme, (url.hostname or '').lower(), -1)
        default_port = 443 if scheme == 'https' else 80 if scheme == 'http' else None
        return (scheme, (url.hostname or '').lower(), port or default_port)

    return '→' if origin_key(destination) == origin_key(origin) else '↗'


def region(text, name, body):
    start, end = f'<!-- {name}:start -->', f'<!-- {name}:end -->'
    if text.count(start) != 1 or text.count(end) != 1:
        raise ValueError(f'Exactly one {name} region required')
    before, rest = text.split(start)
    _, after = rest.split(end)
    return before + start + '\n' + body.strip() + '\n' + end + after


def sync_digital_assets(root):
    """Version dynamic dependencies before the enclosing site.js gets its own hash."""
    path = root / 'site.js'
    text = path.read_text()
    for constant, asset in [('DIGITAL_SCRIPT_VERSION', 'digital.js'), ('DIGITAL_STYLE_VERSION', 'digital.css')]:
        version = hashlib.sha256((root / asset).read_bytes()).hexdigest()[:12]
        text, count = re.subn(r"(const " + constant + r" = ')[^']+(')",
                             lambda match: match[1] + version + match[2], text)
        if count != 1:
            raise ValueError(f'Exactly one generated {constant} required in site.js')
    if path.read_text() != text:
        path.write_text(text)


def canonical_service_phone(root):
    """Read the header phone from the canonical public service contact block."""
    document = BeautifulSoup((root / 'service.html').read_text(), 'html.parser')
    phone = document.select_one('#contact .contact-card a.big-phone')
    number = phone.select_one('.phone-number') if phone else None
    href = phone.get('href', '') if phone else ''
    display = number.get_text(' ', strip=True) if number else ''
    if not re.fullmatch(r'tel:\+?\d+', href) or not display or not re.fullmatch(r'[\d\s()+.-]+', display):
        raise ValueError('Canonical service contact phone is missing or invalid')
    return href, display


def build(root=ROOT):
    sync_digital_assets(root)
    phone_url, phone_number = canonical_service_phone(root)
    navigation = json.loads((root / 'data/navigation.json').read_text())
    if not isinstance(navigation, dict) or set(navigation) != {'primary', 'groups'}:
        raise ValueError('navigation.json must define primary links and secondary groups')
    primary, groups = navigation['primary'], navigation['groups']
    header = (root / 'templates/site-header.html').read_text()
    footer = (root / 'templates/site-footer.html').read_text()
    versions = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()[:12]
                for pattern in ('*.css', '*.js') for p in root.glob(pattern)}
    for path in sorted(root.glob('*.html')):
        text = path.read_text()
        if '<!-- shared-header:start -->' not in text:
            continue  # Standalone offline and redirect documents have no site chrome.
        prefix = '/' if path.name == '404.html' else ''
        nav = '<nav id="navigation" aria-label="主要導覽">'
        # Three direct tasks first; every existing destination stays in the secondary groups.
        for url, title in primary:
            current = ' aria-current="page"' if path.name == url else ''
            href = (prefix + url[2:]) if prefix and url.startswith('./') else prefix + url
            nav += f'<a class="nav-primary" href="{html.escape(href, quote=True)}"{current}>{html.escape(title)}</a>'
        # Secondary destinations share one native disclosure; each original group keeps its heading.
        nav += '<details class="nav-group nav-more"><summary>更多</summary><div class="nav-group-links nav-more-links">'
        for label, links in groups:
            nav += f'<div class="nav-more-section"><p class="nav-more-heading">{html.escape(label)}</p>'
            for url, title in links:
                current = ' aria-current="page"' if path.name == url else ''
                nav += f'<a href="{prefix}{html.escape(url, quote=True)}"{current}>{html.escape(title)}</a>'
            nav += '</div>'
        nav += '</div></details>'
        nav += '</nav>'
        rendered_header = (header.replace('{{NAVIGATION}}', nav)
                           .replace('{{PHONE_URL}}', html.escape(phone_url, quote=True))
                           .replace('{{PHONE_NUMBER}}', html.escape(phone_number)))
        for name, body in [('shared-header', rendered_header), ('shared-footer', footer)]:
            if prefix:
                body = re.sub(r'href="(?![a-z]+:|/|#)([^"]+)"',
                              lambda m: 'href="/' + ('' if m[1] == './' else m[1]) + '"', body)
            text = region(text, name, body)
        # One brand colour for the browser chrome on every page with site chrome.
        text = re.sub(r'<meta name="theme-color" content="#[0-9a-fA-F]{6}">', f'<meta name="theme-color" content="{THEME_COLOR}">', text)
        # Asset versioning is centralized and runs after all source builders.
        for asset in ('civic.css', 'civic.js'):
            if not re.search(r'(?:href|src)="/?' + re.escape(asset), text):
                tag = (f'<link rel="stylesheet" href="{prefix}{asset}">' if asset.endswith('.css')
                       else f'<script src="{prefix}{asset}" defer></script>')
                text = text.replace('</head>', tag + '\n</head>')
        text = re.sub(r'((?:href|src)="/?)([\w.-]+\.(?:css|js))(?:\?v=[^"\s]+)?',
                      lambda m: m[1] + m[2] + '?v=' + versions[m[2]] if m[2] in versions else m[0], text)
        path.write_text(text)
    print('Built shared header, footer and content-addressed assets')


if __name__ == '__main__':
    build()
