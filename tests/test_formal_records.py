"""Formal-site reachability and preservation of the existing short public copy."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from public_record_catalog import read_short_records, short_cards, short_url, validate_catalog


class FormalRecordTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.short = read_short_records(ROOT)
        cls.full = json.loads((ROOT / 'data/achievements.json').read_text())
        cls.index = BeautifulSoup((ROOT / 'achievements.html').read_text(), 'html.parser')
        cls.collection = BeautifulSoup((ROOT / 'public-records.html').read_text(), 'html.parser')

    def test_every_public_record_has_one_formal_card_and_working_detail_target(self):
        cards = self.index.select('#case-list article[data-case]')
        by_id = {card['data-case']: card for card in cards}
        expected = {row['id'] for row in self.full} | {row['id'] for row in self.short}
        self.assertEqual(len(cards), len(expected))
        self.assertEqual(set(by_id), expected)
        for row in self.short:
            with self.subTest(record=row['id']):
                card = by_id[row['id']]
                self.assertEqual(card.select_one('h3 a')['href'], short_url(row['id']))
                self.assertEqual(card['data-record-format'], 'short')
                self.assertIsNotNone(self.collection.find(id='record-' + row['id']))
        for row in self.full:
            self.assertEqual(by_id[row['id']].select_one('h3 a')['href'], 'achievement-' + row['id'] + '.html')

    def test_all_short_copy_and_history_preserved_without_javascript(self):
        articles = self.collection.select('article[data-record-id]')
        self.assertEqual(len(articles), len(self.short))
        self.assertFalse(self.collection.select('article[hidden]'))
        by_id = {article['data-record-id']: article for article in articles}
        for row in self.short:
            with self.subTest(record=row['id']):
                article = by_id[row['id']]
                self.assertEqual(article.h2.get_text(), row['t'])
                summary = article.select_one('.public-record-summary')
                self.assertEqual(summary.get_text() if summary else '', row['s'])
                events = article.select('.public-record-history li')
                actual = [[event.select_one('.public-record-date').get_text(),
                           event.p.get_text() if event.p else ''] for event in events]
                self.assertEqual(actual, row['h'])
                source = article.select_one('a[rel]')
                self.assertEqual(source['href'] if source else '', row.get('sourceUrl', ''))

    def test_short_display_flags_never_become_administrative_facts(self):
        cards = short_cards(ROOT)
        for card in cards:
            self.assertEqual(card['status'], '未列進度')
            self.assertIsNone(card['coordinates'])
            self.assertEqual(card['updated'], '')
            self.assertEqual(card['lastRecordDate'], '')
            self.assertEqual(card['scope'], '範圍未列明')
        self.assertEqual(len(json.loads((ROOT / 'data/achievement-map.json').read_text())), len(self.full))

    def test_catalog_is_exact_derived_data_and_cannot_gain_private_fields(self):
        rows = validate_catalog(ROOT)
        self.assertEqual(len(rows), len(self.full) + len(self.short))
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for name in ['data/achievements.json', 'data/achievement-map.json', 'data/villages.json',
                         'data/public-record-catalog.json', 'island/island-data.json']:
                path = target / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((ROOT / name).read_bytes())
            altered = copy.deepcopy(rows)
            altered[-1]['internalNote'] = 'must never be public'
            (target / 'data/public-record-catalog.json').write_text(json.dumps(altered))
            with self.assertRaisesRegex(ValueError, 'outside its public projection'):
                validate_catalog(target)

    def test_new_formal_narrative_does_not_require_an_island_layout_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for name in ['data/achievements.json', 'data/villages.json', 'island/island-data.json']:
                path = target / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((ROOT / name).read_bytes())
            full = copy.deepcopy(self.full)
            new_case = copy.deepcopy(full[0])
            new_case['id'] = 'new-reviewed-formal-case-without-island-layout'
            full.append(new_case)
            (target / 'data/achievements.json').write_text(json.dumps(full))
            self.assertEqual([row['id'] for row in short_cards(target)], [row['id'] for row in self.short])

    def test_search_keeps_every_formal_record_fragment(self):
        search = json.loads((ROOT / 'data/search-index.json').read_text())['items']
        urls = [row['url'] for row in search]
        for row in self.short:
            self.assertEqual(urls.count(short_url(row['id'])), 1)
        self.assertIn('public-records.html', urls)

    def test_formal_routes_and_original_candidate_number_are_published(self):
        from build_public import public_paths
        paths = public_paths(ROOT)
        self.assertTrue({'public-records.html', 'public-records.js', 'public-records.css',
                         'data/public-record-catalog.json'}.issubset(paths))
        platforms = json.loads((ROOT / 'data/platforms.json').read_text())['elections']
        self.assertEqual(next(row for row in platforms if row['year'] == 2026)['candidateNumber'], 5)
        from page_authority import catalog
        authority = next(row for row in catalog(ROOT) if row['path'] == 'public-records.html')
        self.assertEqual(authority['editorScope'], 'none')
        import publish_from_notion as publisher
        self.assertNotIn('public-records.html', publisher.ALLOWED_PATHS['page-copy'])
        self.assertIn('data/public-record-catalog.json', publisher.ALLOWED_PATHS['achievement-content'])
        import publish_from_cms
        with self.assertRaises(publisher.PublishError):
            publish_from_cms.page_candidate({'id': 'readonly-fixture', 'path': 'public-records.html',
                                             'operation': 'delete', 'payload': '{}'}, ROOT)

    def test_homepage_candidate_number_comes_from_the_same_election_source(self):
        from build_home import render_candidate_number
        platforms = json.loads((ROOT / 'data/platforms.json').read_text())
        self.assertEqual(render_candidate_number(platforms), '2026 鳳山區市議員候選人・陳慧文5號')
        changed = copy.deepcopy(platforms)
        next(row for row in changed['elections'] if row['year'] == 2026)['candidateNumber'] = 7
        self.assertTrue(render_candidate_number(changed).endswith('陳慧文7號'))
        next(row for row in changed['elections'] if row['year'] == 2026)['candidateNumber'] = True
        with self.assertRaises(ValueError):
            render_candidate_number(changed)


if __name__ == '__main__':
    unittest.main()
