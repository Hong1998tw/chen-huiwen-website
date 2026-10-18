#!/usr/bin/env python3
"""Render shared chrome inside explicit regions; preserve every page's main bytes."""
from python_guard import require_supported_python
require_supported_python()
from pathlib import Path
import hashlib
import html
import json
import re
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]


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
    groups = json.loads((root / 'data/navigation.json').read_text())
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
        for label, links in groups:
            nav += f'<details class="nav-group"><summary>{html.escape(label)}</summary><div class="nav-group-links">'
            for url, title in links:
                current = ' aria-current="page"' if path.name == url else ''
                nav += f'<a href="{prefix}{html.escape(url, quote=True)}"{current}>{html.escape(title)}</a>'
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
