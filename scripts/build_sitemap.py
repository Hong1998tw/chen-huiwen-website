#!/usr/bin/env python3
"""Use editorial content dates, never build time, as sitemap lastmod."""
from python_guard import require_supported_python
require_supported_python()
from pathlib import Path
import json
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
NS = 'http://www.sitemaps.org/schemas/sitemap/0.9'
BASE = 'https://www.huiwen.tw/'


def build(root=ROOT):
    metadata = json.loads((root / 'data/page-metadata.json').read_text())
    from editorial_pages import read as read_editorial
    editorial = read_editorial(root)['pages']
    managed = json.loads((root / 'data/page-content.json').read_text()).get('pages', {})
    ET.register_namespace('', NS)
    tree = ET.parse(root / 'sitemap.xml')
    entries = {}
    for entry in tree.getroot():
        loc = entry.find('{' + NS + '}loc').text
        relative = loc.removeprefix(BASE)
        name = 'index.html' if not relative else relative.rstrip('/') + '/index.html' if relative.endswith('/') else relative
        entries[name] = entry
        if name in metadata:
            entry.find('{' + NS + '}lastmod').text = metadata[name]['contentUpdated']
    for name, state in managed.items():
        if not name.endswith('.html'):
            continue
        status = state.get('status', 'published')
        if status not in {'published', 'unpublished', 'deleted'}:
            raise ValueError('PAGE_CONTENT_STATUS: ' + name)
        if status != 'published':
            entry = entries.pop(name, None)
            if entry is not None:
                tree.getroot().remove(entry)
            continue
        if name not in entries:
            entry = ET.SubElement(tree.getroot(), '{'+NS+'}url')
            location = '' if name == 'index.html' else name[:-10] if name.endswith('/index.html') else name
            ET.SubElement(entry, '{'+NS+'}loc').text = BASE + location
            lastmod = state.get('lastmod') or metadata.get(name, {}).get('contentUpdated')
            if not lastmod:
                raise ValueError('PAGE_CONTENT_LASTMOD_REQUIRED: ' + name)
            ET.SubElement(entry, '{'+NS+'}lastmod').text = lastmod
            entries[name] = entry
        elif state.get('lastmod'):
            entries[name].find('{' + NS + '}lastmod').text = state['lastmod']
    for name, page in editorial.items():
        if managed.get(name, {}).get('status', 'published') != 'published':
            continue
        if name not in entries:
            entry = ET.SubElement(tree.getroot(), '{'+NS+'}url')
            ET.SubElement(entry, '{'+NS+'}loc').text = BASE + name
            ET.SubElement(entry, '{'+NS+'}lastmod').text = page['updated']
            entries[name] = entry
        else:
            entries[name].find('{' + NS + '}lastmod').text = managed.get(name, {}).get('lastmod') or page['updated']
    # build_cases regenerates all achievement entries on every run. Keep CMS
    # pages before them so a first build and a repeat build have the same order.
    editorial_entries = [(name, entries[name]) for name in sorted(editorial) if name in entries]
    for _, entry in editorial_entries:
        tree.getroot().remove(entry)
    case_index = next((index for index, entry in enumerate(tree.getroot())
                       if (entry.find('{' + NS + '}loc').text or '').startswith(BASE + 'achievement-')),
                      len(tree.getroot()))
    for offset, (_, entry) in enumerate(editorial_entries):
        tree.getroot().insert(case_index + offset, entry)
    existing = {entry.find('{'+NS+'}loc').text for entry in tree.getroot()}
    for name in ('service-guides.html', 'service-print.html', 'updates.html'):
        if BASE + name not in existing and managed.get(name, {}).get('status', 'published') == 'published':
            entry = ET.SubElement(tree.getroot(), '{'+NS+'}url')
            ET.SubElement(entry, '{'+NS+'}loc').text = BASE + name
            ET.SubElement(entry, '{'+NS+'}lastmod').text = metadata[name]['contentUpdated']
    # Stable event pages share the same editorial dates and immutable ids as the timeline.
    from build_events import event_path, public_events
    events = public_events(json.loads((root / 'data/events.json').read_text()))
    event_entries = []
    for event in sorted(events, key=lambda item: item['id']):
        name = event_path(event)
        if managed.get(name, {}).get('status', 'published') != 'published':
            continue
        lastmod = event.get('updatedAt') or event.get('verifiedAt') or metadata['activities.html']['contentUpdated']
        entry = entries.get(name)
        if entry is None:
            entry = ET.Element('{'+NS+'}url')
            ET.SubElement(entry, '{'+NS+'}loc').text = BASE + name
            ET.SubElement(entry, '{'+NS+'}lastmod')
        else:
            tree.getroot().remove(entry)
        entry.find('{'+NS+'}lastmod').text = lastmod
        event_entries.append(entry)
    # Always reinsert before case pages: repeat builds keep identical ordering.
    insertion = next((index for index, entry in enumerate(tree.getroot())
                      if (entry.find('{'+NS+'}loc').text or '').startswith(BASE + 'achievement-')),
                     len(tree.getroot()))
    for offset, entry in enumerate(event_entries):
        tree.getroot().insert(insertion + offset, entry)
    ET.indent(tree, space='  ')
    (root / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(tree.getroot(), encoding='unicode') + '\n')
    print('Built sitemap from recorded content dates')


if __name__ == '__main__':
    build()
