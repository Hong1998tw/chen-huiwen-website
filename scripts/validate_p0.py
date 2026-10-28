#!/usr/bin/env python3
"""Check that the shipped index, structured records and PNG metadata stay in sync."""
import hashlib
import json
import struct
from pathlib import Path
from urllib.parse import urlsplit, unquote

from bs4 import BeautifulSoup
from page_seo import validate as validate_page_seo

R = Path(__file__).resolve().parents[1]
INACTIVE = {'unpublished', 'deleted'}


def page_is_searchable(root, route, page_states, doc=None):
    state = page_states.get(route, {})
    if isinstance(state, dict) and state.get('status', 'published') in INACTIVE:
        return False
    path = root / route
    if not path.is_file():
        # Keep a missing active route in the expected set so the index check fails.
        return True
    if doc is None:
        doc = BeautifulSoup(path.read_text(encoding='utf-8'), 'html.parser')
    robots = doc.find('meta', attrs={'name': 'robots'})
    return bool(doc.find('main')) and not (robots and 'noindex' in robots.get('content', ''))


def expected_public_achievement_urls(public, root, page_states):
    return {
        'achievement-' + record['id'] + '.html'
        for record in public
        if page_is_searchable(root, 'achievement-' + record['id'] + '.html', page_states)
    }


def expected_social_metadata(root, key, page_states):
    page_state = page_states.get(key + '.html', {})
    if not isinstance(page_state, dict):
        raise ValueError('page state must be an object: ' + key)
    seo = page_state.get('seo')
    if seo is not None:
        validated = validate_page_seo(seo, root)
        return validated['image'], validated['imageAlt']
    return 'https://www.huiwen.tw/assets/og/' + key + '.png', None


def validate(root=R):
    source = json.loads((root / 'data/achievements.json').read_text(encoding='utf-8'))
    public = [record for record in source if record['status'] != '待核驗']
    page_content = json.loads((root / 'data/page-content.json').read_text(encoding='utf-8'))
    page_states = page_content.get('pages', {})
    index = json.loads((root / 'data/search-index.json').read_text(encoding='utf-8'))
    assert index['count'] == len(index['items'])
    assert len({record['url'] for record in index['items']}) == len(index['items'])
    # Thousands of distinct fragment results may share one HTML document. Check
    # every URL and anchor, while parsing each unchanged document only once.
    documents = {}
    anchor_ids = {}
    def document(path):
        if path not in documents:
            documents[path] = BeautifulSoup(path.read_text(encoding='utf-8'), 'html.parser')
        return documents[path]
    for record in index['items']:
        url = urlsplit(record['url'])
        assert not url.scheme and not url.netloc, record['url']
        path = root / unquote(url.path)
        path = path / 'index.html' if path.is_dir() else path
        assert path.exists() and root in path.resolve().parents, record['url']
        route = path.relative_to(root).as_posix()
        doc = document(path)
        assert page_is_searchable(root, route, page_states, doc), record['url']
        if url.fragment:
            if path not in anchor_ids:
                anchor_ids[path] = {node['id'] for node in doc.find_all(id=True)}
            assert unquote(url.fragment) in anchor_ids[path], record['url']

    indexed_achievements = {record['url'] for record in index['items'] if record['type'] == '政績'}
    expected_achievements = expected_public_achievement_urls(public, root, page_states)
    has_short_collection = (root / 'public-records.html').is_file()
    if has_short_collection and page_is_searchable(root, 'public-records.html', page_states, document(root / 'public-records.html')):
        from public_record_catalog import short_cards
        expected_achievements |= {record['url'] for record in short_cards(root)}
    assert indexed_achievements == expected_achievements

    manifest = json.loads((root / 'assets/og/manifest.json').read_text(encoding='utf-8'))
    for record in public:
        key = 'achievement-' + record['id']
        assert manifest[key]['title'] == record['title']
        assert manifest[key]['status'] == record['status']
    for key, meta in manifest.items():
        path = root / 'assets/og' / f'{key}.png'
        payload = path.read_bytes()
        assert payload[:8] == b'\x89PNG\r\n\x1a\n'
        assert struct.unpack('>II', payload[16:24]) == (1200, 630)
        assert hashlib.sha256(payload).hexdigest() == meta['sha256']
        doc = BeautifulSoup((root / (key + '.html')).read_text(encoding='utf-8'), 'html.parser')
        og = doc.select_one('meta[property="og:image"]')['content']
        twitter = doc.select_one('meta[name="twitter:image"]')['content']
        expected_image, expected_alt = expected_social_metadata(root, key, page_states)
        assert og == twitter == expected_image
        image_extension = expected_image.rsplit('.', 1)[-1].lower()
        expected_mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp', 'avif': 'image/avif'}[image_extension]
        assert doc.select_one('meta[property="og:image:type"]')['content'] == expected_mime
        alt = doc.select_one('meta[property="og:image:alt"]')['content']
        if expected_alt is not None:
            assert alt == expected_alt
        else:
            assert meta['title'] in alt

    map_config = json.loads(BeautifulSoup((root / 'achievements.html').read_text(encoding='utf-8'), 'html.parser').select_one('#map-data').string)
    map_data = json.loads((root / urlsplit(map_config['url']).path).read_text(encoding='utf-8'))
    if has_short_collection:
        from public_record_catalog import validate_catalog, CATALOG_PATH
        from build_public import validate_map, public_records
        validate_map(root, public_records(root))  # Preserve the original full-record contract.
        assert urlsplit(map_config['url']).path == CATALOG_PATH
        assert map_data == validate_catalog(root)
        cards = document(root / 'achievements.html').select('#case-list [data-case]')
        assert len(cards) == len(map_data)
        assert {card['data-case'] for card in cards} == {record['id'] for record in map_data}
    else:
        assert {record['id'] for record in map_data} == {record['id'] for record in public}
    print(f'P0 validated: {len(index["items"])} indexed public entries; {len(public)} full records; {len(manifest)} PNG share cards')


if __name__ == '__main__':
    validate()
