"""Rendered contract for related-case cards and the existing topic-list route."""
import json
from pathlib import Path
import unittest
from urllib.parse import parse_qs, urlsplit

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
CASE_ID = 'wende-school-center'


class RelatedCaseRenderingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.items = json.loads((ROOT / 'data/achievements-public.json').read_text(encoding='utf-8'))
        cls.by_id = {item['id']: item for item in cls.items}
        cls.case = cls.by_id[CASE_ID]
        cls.page = BeautifulSoup((ROOT / f'achievement-{CASE_ID}.html').read_text(encoding='utf-8'), 'html.parser')
        cls.map_page = BeautifulSoup((ROOT / 'achievements.html').read_text(encoding='utf-8'), 'html.parser')
        cls.topics = {option.get('value', option.get_text(strip=True)) for option in cls.map_page.select('#category-filter option')}

    def test_related_heading_is_unique_and_all_four_server_rendered_cards_remain(self):
        section = self.page.select_one('.related-section')
        self.assertIsNotNone(section)
        headings = [node for node in section.select('h2') if node.get_text(strip=True) == '相關專題']
        self.assertEqual(len(headings), 1)
        self.assertEqual(section.get('aria-labelledby'), headings[0]['id'])
        self.assertEqual(len(self.page.select(f'#{headings[0]["id"]}')), 1)
        self.assertNotIn('RELATED STORIES', section.get_text())

        expected = [record_id for record_id in self.case['related'] if record_id in self.by_id]
        cards = section.select('.related-cases > .case-card[data-case]')
        self.assertEqual(len(expected), 4)
        self.assertEqual([card['data-case'] for card in cards], expected)

    def test_all_related_detail_pages_render_chinese_heading_cards_and_valid_more_routes(self):
        for record in self.items:
            if not record.get('related'):
                continue
            expected = [record_id for record_id in record['related'] if record_id in self.by_id]
            if not expected:
                continue
            with self.subTest(record=record['id']):
                page = BeautifulSoup((ROOT / f"achievement-{record['id']}.html").read_text(encoding='utf-8'), 'html.parser')
                section = page.select_one('.related-section')
                self.assertIsNotNone(section)
                headings = [node for node in section.select('h2') if node.get_text(strip=True) == '相關專題']
                self.assertEqual(len(headings), 1)
                self.assertEqual(section.get('aria-labelledby'), headings[0]['id'])
                self.assertNotIn('RELATED STORIES', section.get_text())
                self.assertEqual([card['data-case'] for card in section.select('.related-cases > .case-card[data-case]')], expected)

                link = section.select_one('.related-more a[href]')
                self.assertIsNotNone(link)
                topic = next((value for value in record.get('categories', []) if value in self.topics), None)
                url = urlsplit(link['href'])
                if topic:
                    self.assertEqual(url.path, 'achievements.html')
                    self.assertEqual(parse_qs(url.query), {'category': [topic]})
                    self.assertTrue(link.get_text(strip=True).startswith('更多相關專題：'))
                else:
                    self.assertEqual(url.path, 'achievements.html')
                    self.assertEqual(url.fragment, 'case-results')
                    self.assertFalse(url.query)
                    self.assertEqual(link.get_text(strip=True), '查看更多建設與進度 →')

    def test_more_link_uses_a_real_category_filter_and_results_anchor(self):
        section = self.page.select_one('.related-section')
        links = section.select('.related-more a[href]')
        self.assertEqual(len(links), 1)
        link = links[0]
        self.assertTrue(link.get_text(strip=True).startswith('更多相關專題：'))
        url = urlsplit(link['href'])
        topic = self.case['categories'][0]
        self.assertEqual(url.path, 'achievements.html')
        self.assertEqual(parse_qs(url.query), {'category': [topic]})
        self.assertEqual(url.fragment, 'case-results')

        self.assertIn(topic, self.topics)
        map_script = (ROOT / 'map.js').read_text(encoding='utf-8')
        self.assertIn("'category'", map_script)
        self.assertIn('p.get(key)', map_script)

    def test_mobile_rule_keeps_cards_three_and_four_in_html_and_leaves_more_link_visible(self):
        css = (ROOT / 'styles.css').read_text(encoding='utf-8')
        self.assertIn('@media(max-width:780px){.related-cases>.case-card:nth-child(n+3){display:none}', css)
        self.assertIn('.related-more a{', css)
        self.assertIn('.related-cases>.case-card:nth-child(n+3){display:none}', css)
        self.assertEqual(len(self.page.select('.related-section .related-cases > .case-card')), 4)


if __name__ == '__main__':
    unittest.main()
