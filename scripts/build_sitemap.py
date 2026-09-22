#!/usr/bin/env python3
"""Use editorial content dates, never build time, as sitemap lastmod."""
from pathlib import Path
import json
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
NS = 'http://www.sitemaps.org/schemas/sitemap/0.9'
BASE = 'https://www.huiwen.tw/'


def build(root=ROOT):
    metadata = json.loads((root / 'data/page-metadata.json').read_text())
    ET.register_namespace('', NS)
    tree = ET.parse(root / 'sitemap.xml')
    for entry in tree.getroot():
        loc = entry.find('{' + NS + '}loc').text
        name = loc.removeprefix(BASE) or 'index.html'
        if name in metadata:
            entry.find('{' + NS + '}lastmod').text = metadata[name]['contentUpdated']
    ET.indent(tree, space='  ')
    (root / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(tree.getroot(), encoding='unicode') + '\n')
    print('Built sitemap from recorded content dates')


if __name__ == '__main__':
    build()
