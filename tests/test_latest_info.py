"""The latest-information feed is one reproducible projection of existing canonical sources."""
import copy
import re
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import latest_info  # noqa: E402
from build_home import render_latest, selected_latest, LATEST_PER_FILTER  # noqa: E402
from editorial_pages import validate_page, SECTIONS  # noqa: E402

FIXTURE_FILES = ('news.html', 'press.html', 'data/events.json', 'data/editorial-pages.json',
                 'data/page-content.json', 'data/civic-home.json')


def daily_page(updated='2026-10-29', photo='https://images.example.org/daily/market.jpg'):
    blocks = [
        {'type': 'paragraph', 'title': '', 'text': '早上到市場和攤商聊天。', 'date': '', 'url': '', 'alt': '',
         'credit': '', 'address': '', 'publicAccessConfirmed': False},
        {'type': 'source', 'title': '陳慧文 Facebook', 'text': '', 'date': updated,
         'url': 'https://www.facebook.com/hwcfs/posts/123', 'alt': '', 'credit': '', 'address': '',
         'publicAccessConfirmed': False},
    ]
    if photo:
        blocks.append({'type': 'photo', 'title': '', 'text': '市場現場', 'date': '', 'url': photo,
                       'alt': '市場攤位前的合照', 'credit': '陳慧文服務處', 'address': '', 'publicAccessConfirmed': True})
    return {'section': 'daily', 'title': '早市走一走', 'summary': '和攤商聊聊生意與環境。', 'updated': updated,
            'eventStart': '', 'eventEnd': '',
            'seo': {'title': '早市走一走｜陳慧文', 'description': '和攤商聊聊生意與環境。',
                    'image': 'https://www.huiwen.tw/assets/site-share-20260909.png', 'imageAlt': '陳慧文・高雄市議員・鳳山區'},
            'blocks': blocks}


class LatestInfoFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for name in FIXTURE_FILES:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        for page in ROOT.glob('news-*.html'):
            shutil.copy2(page, self.root / page.name)
        (self.root / 'assets').symlink_to(ROOT / 'assets', target_is_directory=True)

    def tearDown(self):
        self.temp.cleanup()

    def write_json(self, name, value):
        (self.root / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


class LatestInfoTests(LatestInfoFixture):
    def test_current_sources_produce_all_items_without_daily_fabrication(self):
        items = latest_info.collect(ROOT)
        counts = {kind: sum(item['type'] == kind for item in items) for kind in latest_info.TYPES}
        self.assertEqual(counts, {'news': 45, 'daily': 0, 'activity': 2})
        self.assertEqual(len({item['id'] for item in items}), len(items))
        self.assertEqual([item['naturalIndex'] for item in items], list(range(len(items))))

    def test_committed_projection_matches_sources(self):
        committed = json.loads((ROOT / latest_info.OUTPUT).read_text(encoding='utf-8'))
        self.assertEqual(committed, latest_info.project(ROOT))
        self.assertEqual(committed['pinned'], [])
        self.assertNotIn('generatedAt', json.dumps(committed))

    def test_event_sorting_uses_publication_time_not_event_start(self):
        items = {item['id']: item for item in latest_info.collect(ROOT)}
        opening = items['event-campaign-headquarters-opening-2026-10-31']
        self.assertEqual(opening['publishedAt'], '2026-10-02T04:00+08:00')
        self.assertEqual(opening['eventStart'], '2026-10-31T15:50:00+08:00')
        council = items['event-council-general-interpellation-2026-10-08']
        self.assertEqual(council['publishedAt'], '2026-09-11T16:21+08:00')
        ordered = [item['id'] for item in latest_info.collect(ROOT)]
        # Event start (10/31) would place it first; its publication time (10/02) does not.
        self.assertLess(ordered.index('news-20261007-public-oversight-awards'), ordered.index(opening['id']))

    def test_missing_event_publication_time_fails_closed(self):
        data = json.loads((self.root / 'data/events.json').read_text(encoding='utf-8'))
        del data['events'][0]['publishedAt']
        self.write_json('data/events.json', data)
        with self.assertRaisesRegex(latest_info.LatestInfoError, 'publication time'):
            latest_info.collect(self.root)

    def test_same_day_ties_are_stable(self):
        rows = [
            {'id': 'b', 'publishedAt': '2026-09-15', 'source': 'media', 'sourceIndex': 0},
            {'id': 'a', 'publishedAt': '2026-09-15', 'source': 'press', 'sourceIndex': 3},
            {'id': 'c', 'publishedAt': '2026-09-15T10:00+08:00', 'source': 'event', 'sourceIndex': 0},
            {'id': 'd', 'publishedAt': '2026-09-16', 'source': 'media', 'sourceIndex': 9},
        ]
        for _ in range(3):
            self.assertEqual([row['id'] for row in sorted(rows, key=latest_info.natural_key)], ['d', 'c', 'a', 'b'])
            rows.reverse()

    def test_pins_move_items_first_and_filters_keep_the_same_order(self):
        items = latest_info.collect(ROOT)
        oldest = items[-1]['id']
        ordered = latest_info.order(items, [oldest])
        self.assertEqual(ordered[0]['id'], oldest)
        self.assertEqual([item['id'] for item in ordered[1:]], [item['id'] for item in items if item['id'] != oldest])
        news = [item['id'] for item in ordered if item['type'] == 'news']
        self.assertEqual(news[0], oldest)

    def test_pin_validation_rejects_unknown_duplicate_and_excess(self):
        ids = {item['id'] for item in latest_info.collect(ROOT)}
        valid = sorted(ids)[:3]
        self.assertEqual(latest_info.validate_pins(valid, ids), valid)
        for pins in (valid + [sorted(ids)[3]], [valid[0], valid[0]], ['not-a-real-item'], ['Bad Id']):
            with self.assertRaises(latest_info.LatestInfoError):
                latest_info.validate_pins(pins, ids)

    def test_unknown_pin_in_source_fails_the_build(self):
        config = json.loads((self.root / 'data/civic-home.json').read_text(encoding='utf-8'))
        config['latestPinned'] = ['removed-item']
        self.write_json('data/civic-home.json', config)
        with self.assertRaises(latest_info.LatestInfoError):
            latest_info.project(self.root)

    def test_thumbnail_rules_keep_the_image_allowlist_purpose(self):
        ok = latest_info.external_thumbnail_ok
        self.assertTrue(ok('https://img.ltn.com.tw/Upload/news/600/2026/10/07/5598112_1_1.jpg'))
        self.assertTrue(ok('https://images.newtalk.tw/resize_action2/800/album/news/1059/6a9e44606734b.jpg'))
        for url in (
            'https://www.facebook.com/hwcfs/posts/123',
            'https://drive.google.com/file/d/abcdefghijklmnopqrstuvwxyz/view',
            'https://scontent.xx.fbcdn.net/v/t39/photo.jpg',
            'https://lh3.googleusercontent.com/d/photo.jpg',
            'https://drive.google.com/thumbnail?id=abc',
            'https://images.example.org/photo.jpg?expires=1&sig=x',
            'http://images.example.org/photo.jpg',
            'https://news.ltn.com.tw/amp/news/politics/breakingnews/5598112',
        ):
            self.assertFalse(ok(url), url)

    def test_external_thumbnail_keeps_reviewed_local_fallback_and_credit(self):
        items = {item['id']: item for item in latest_info.collect(ROOT)}
        mazu = next(item for item in items.values() if item['title'].startswith('媽祖港橋跨區合體'))
        self.assertFalse(mazu['thumbnail']['local'])
        self.assertIn('黃敬雅競辦提供', mazu['thumbnail']['credit'])
        self.assertEqual(mazu['thumbnail']['fallback']['src'], 'assets/news-20260907-mazu-port-bridge.jpg')
        self.assertTrue(mazu['thumbnail']['fallback']['local'])
        award = items['news-20261007-public-oversight-awards']
        self.assertEqual((award['thumbnail']['width'], award['thumbnail']['height']), (800, 600))
        self.assertEqual(award['sourceUrl'], 'https://news.ltn.com.tw/amp/news/politics/breakingnews/5598112')

    def test_invalid_card_thumbnail_fails_closed(self):
        text = (self.root / 'news.html').read_text(encoding='utf-8')
        text = text.replace('https://img.ltn.com.tw/Upload/news/600/2026/10/07/5598112_1_1.jpg',
                            'https://www.facebook.com/hwcfs/photos/1', 1)
        (self.root / 'news.html').write_text(text, encoding='utf-8')
        with self.assertRaisesRegex(latest_info.LatestInfoError, 'direct public image'):
            latest_info.collect(self.root)

    def test_daily_editorial_page_joins_the_same_feed_and_filter(self):
        page = daily_page()
        self.assertEqual(validate_page('page-daily-morning-market.html', page, ROOT)['section'], 'daily')
        self.assertEqual(SECTIONS['daily'][0], 'index.html#latest')
        self.write_json('data/editorial-pages.json', {'schemaVersion': 1, 'pages': {'page-daily-morning-market.html': page}})
        feed = latest_info.project(self.root)
        self.assertEqual(feed['counts']['daily'], 1)
        daily = next(item for item in feed['items'] if item['type'] == 'daily')
        self.assertEqual(daily['id'], 'page-daily-morning-market')
        self.assertEqual(daily['dateLabel'], '整理日期')
        self.assertEqual(daily['sourceUrl'], 'https://www.facebook.com/hwcfs/posts/123')
        self.assertEqual(daily['thumbnail']['src'], 'https://images.example.org/daily/market.jpg')
        self.assertEqual(feed['items'][0]['id'], 'page-daily-morning-market')
        html = render_latest(feed, self.root)
        soup = BeautifulSoup(html, 'html.parser')
        self.assertEqual(len(soup.select('[data-latest-type="daily"]')), 1)
        self.assertIsNotNone(soup.select_one('[data-latest-filter="daily"]'))

    def test_daily_section_is_offered_by_the_same_cms_and_validators(self):
        html = (ROOT / 'admin/public/index.html').read_text(encoding='utf-8')
        self.assertIn('<option value="daily">', html)
        source = (ROOT / 'admin/src/editorial-page.ts').read_text(encoding='utf-8')
        self.assertIn('"daily"', source.split('EDITORIAL_SECTIONS', 1)[1].split(';', 1)[0])
        self.assertIn('daily', source.split('editorialPath', 1)[1].split(';', 1)[0])
        guard = (ROOT / 'scripts/publication_path_guard.py').read_text(encoding='utf-8')
        self.assertIn('achievement|daily', guard)

    def test_daily_without_direct_image_stays_text_with_source(self):
        page = daily_page(photo='https://www.facebook.com/hwcfs/photos/1')
        self.write_json('data/editorial-pages.json', {'schemaVersion': 1, 'pages': {'page-daily-no-photo.html': page}})
        daily = next(item for item in latest_info.collect(self.root) if item['type'] == 'daily')
        self.assertIsNone(daily['thumbnail'])
        self.assertTrue(daily['sourceUrl'].startswith('https://www.facebook.com/'))

    def test_unpublished_editorial_page_is_excluded(self):
        self.write_json('data/editorial-pages.json', {'schemaVersion': 1, 'pages': {'page-daily-morning-market.html': daily_page()}})
        state = json.loads((self.root / 'data/page-content.json').read_text(encoding='utf-8'))
        state['pages']['page-daily-morning-market.html'] = {'edits': {}, 'status': 'unpublished', 'lastmod': '2026-10-29'}
        self.write_json('data/page-content.json', state)
        self.assertEqual(sum(item['type'] == 'daily' for item in latest_info.collect(self.root)), 0)

    def test_pinning_an_unrendered_old_item_leads_the_built_homepage_and_unpin_restores(self):
        items = latest_info.collect(ROOT)
        natural = render_latest(latest_info.project(ROOT), ROOT)
        soup = BeautifulSoup(natural, 'html.parser')
        rendered = [node['data-latest-id'] for node in soup.select('[data-latest-items] > .latest-item')]
        reserve = soup.select_one('template[data-latest-reserve]')
        oldest = items[-1]['id']
        self.assertNotIn(oldest, rendered)
        self.assertIn(f'data-latest-id="{oldest}"', str(reserve))
        # Every candidate exists exactly once: rendered list or inert reserve copy.
        reserved = re.findall(r'data-latest-id="([^"]+)"', str(reserve))
        self.assertEqual(sorted(rendered + reserved), sorted(item['id'] for item in items))
        config = json.loads((self.root / 'data/civic-home.json').read_text(encoding='utf-8'))
        self.write_json('data/civic-home.json', {**config, 'latestPinned': [oldest]})
        pinned = BeautifulSoup(render_latest(latest_info.project(self.root), self.root), 'html.parser')
        first = pinned.select_one('[data-latest-items] > .latest-item')
        self.assertEqual(first['data-latest-id'], oldest)
        self.assertIn('is-lead', first['class'])
        self.assertTrue(first.has_attr('data-latest-pinned'))
        self.assertNotIn(f'data-latest-id="{oldest}"', str(pinned.select_one('template[data-latest-reserve]')))
        self.write_json('data/civic-home.json', config)
        restored = BeautifulSoup(render_latest(latest_info.project(self.root), self.root), 'html.parser')
        self.assertEqual([node['data-latest-id'] for node in restored.select('[data-latest-items] > .latest-item')], rendered)

    def test_public_latest_copy_stays_simple(self):
        soup = BeautifulSoup((ROOT / 'index.html').read_text(encoding='utf-8'), 'html.parser')
        latest = soup.select_one('#latest')
        text = latest.get_text(' ', strip=True)
        for internal in ('共收錄', '由新到舊', '網站刊登', '置頂', '整理或網站刊登'):
            self.assertNotIn(internal, text.replace(latest.select_one('template').get_text(' ', strip=True), '') if latest.select_one('template') else text)
        empty = latest.select_one('[data-latest-empty]')
        self.assertEqual(len(empty.select('a')), 1)
        self.assertEqual(empty.get_text(' ', strip=True).count('Facebook'), 2)  # one message, one link
        for title in latest.select('.latest-title a'):
            self.assertIsNone(re.search(r'[→↗›»]\s*$', title.get_text(strip=True)), title.get_text())
        long_titles = [a for a in latest.select('[data-latest-items] .latest-title a') if len(a.get_text()) > 10]
        self.assertTrue(long_titles and all(a.select('.latest-keep')[-1].get_text() == a.get_text()[-len(a.select('.latest-keep')[-1].get_text()):] for a in long_titles))
        for a in latest.select('.latest-title a'):
            text = a.get_text()
            for phrase in ('陳慧文', '賴瑞隆', '高雄市議員', '聯合', '競選總部', '問政'):
                if phrase in text:
                    self.assertTrue(any(phrase in keep.get_text() for keep in a.select('.latest-keep')), (phrase, text))

    def test_earlier_homepage_anchors_still_resolve(self):
        soup = BeautifulSoup((ROOT / 'index.html').read_text(encoding='utf-8'), 'html.parser')
        main = soup.select_one('main')
        baseline = ('main', 'hero-title', 'recent', 'home-recent-heading', 'opening', 'home-local-progress', 'home-local-heading',
                    'home-village', 'home-village-help', 'council', 'home-council-heading', 'contact', 'contact-heading')
        for anchor in baseline:
            self.assertIsNotNone(soup.select_one('#' + anchor), anchor)
        for anchor, section in (('recent', 'latest'), ('opening', 'latest'), ('hero-title', 'latest'), ('home-recent-heading', 'latest'),
                                ('home-local-progress', 'progress'), ('home-local-heading', 'progress'),
                                ('council', 'council'), ('home-council-heading', 'council'), ('contact', 'contact')):
            node = main.select_one('#' + anchor)
            self.assertIsNotNone(node, anchor)
            owner = node if node.get('id') == section else node.find_parent(id=section)
            self.assertIsNotNone(owner, anchor)

    def test_changed_sources_have_no_invisible_bidi_controls(self):
        for name in ('admin/src/home-draft.ts', 'admin/src/home-sources.ts', 'admin/src/bounded-fetch.ts', 'admin/src/index.ts',
                     'admin/src/editorial-page.ts', 'admin/public/app.js', 'cms-page-editor.js', 'home.js',
                     'scripts/latest_info.py', 'scripts/build_home.py', 'scripts/publish_from_cms.py'):
            text = (ROOT / name).read_text(encoding='utf-8')
            hidden = [hex(ord(c)) for c in text if 0x200b <= ord(c) <= 0x200f or 0x202a <= ord(c) <= 0x202e or 0x2066 <= ord(c) <= 0x2069]
            self.assertEqual(hidden, [], name)

    def test_decorative_arrows_are_not_part_of_titles(self):
        node = BeautifulSoup('<h2><a href="x">標題文字<span aria-hidden="true"> ↗</span></a> →</h2>', 'html.parser')
        self.assertEqual(latest_info._title(node), '標題文字')

    def test_homepage_renders_bounded_union_in_published_order(self):
        feed = latest_info.project(ROOT)
        chosen = selected_latest(feed['items'])
        self.assertLessEqual(len(chosen), LATEST_PER_FILTER * 4)
        self.assertEqual([item['naturalIndex'] for item in chosen], sorted(item['naturalIndex'] for item in chosen))
        soup = BeautifulSoup((ROOT / 'index.html').read_text(encoding='utf-8'), 'html.parser')
        rendered = [node['data-latest-id'] for node in soup.select('[data-latest-items] > .latest-item')]
        self.assertEqual(rendered, [item['id'] for item in chosen])
        self.assertEqual(len(soup.select('.latest-item:not([hidden])')), 3)
        self.assertEqual(len(soup.select('.latest-item.is-lead')), 1)
        for image in soup.select('.latest-item img'):
            self.assertTrue(image.get('alt'))
            self.assertTrue(image.get('width') and image.get('height'))
            if image['src'].startswith('https://'):
                self.assertEqual(image.get('referrerpolicy'), 'no-referrer')
        self.assertFalse(soup.select('main iframe, main video'))


if __name__ == '__main__':
    unittest.main()
