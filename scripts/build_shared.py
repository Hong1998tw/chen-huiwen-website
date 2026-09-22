#!/usr/bin/env python3
"""Render shared chrome inside explicit regions; preserve every page's main bytes."""
from pathlib import Path
import hashlib
import html
import json
import re

ROOT = Path(__file__).resolve().parents[1]


def region(text, name, body):
    start, end = f'<!-- {name}:start -->', f'<!-- {name}:end -->'
    if text.count(start) != 1 or text.count(end) != 1:
        raise ValueError(f'Exactly one {name} region required')
    before, rest = text.split(start)
    _, after = rest.split(end)
    return before + start + '\n' + body.strip() + '\n' + end + after


def build(root=ROOT):
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
        for name, body in [('shared-header', header.replace('{{NAVIGATION}}', nav)), ('shared-footer', footer)]:
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
