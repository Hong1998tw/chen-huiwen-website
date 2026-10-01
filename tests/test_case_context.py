import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from case_context import render_case_context


class CaseContextTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / 'data/case-context.json').read_text())
        self.records = json.loads((ROOT / 'data/achievements-public.json').read_text())

    def fixture(self, config):
        temp = tempfile.TemporaryDirectory()
        root = Path(temp.name)
        (root / 'data').mkdir()
        (root / 'data/case-context.json').write_text(json.dumps(config, ensure_ascii=False))
        (root / 'data/achievements-public.json').write_text(json.dumps(self.records, ensure_ascii=False))
        self.addCleanup(temp.cleanup)
        return root

    def test_all_three_guides_reference_only_their_public_record_sources(self):
        for record_id in ('metro-green-line', 'after-school-care', 'bade-detention'):
            source_urls = {s['url'] for r in self.records if r['id'] == record_id for s in r['sources']}
            soup = BeautifulSoup(render_case_context(record_id, ROOT), 'html.parser')
            self.assertEqual(len(soup.select('.case-context-point')), 2 if record_id == 'bade-detention' else 3)
            self.assertEqual(len(soup.select('h2')), 1)
            self.assertEqual(len(soup.select('#case-context')), 1)
            self.assertEqual(soup.select_one('.case-context-updated time')['datetime'], '2026-09-22')
            self.assertIn('導讀整理', soup.select_one('.case-context-updated').get_text())
            self.assertTrue(soup.select_one('details summary'))
            self.assertIsNone(soup.select_one('details[open]'))
            self.assertTrue(all(a['href'] in source_urls for a in soup.select('a[href]')))

    def test_unconfigured_and_missing_data_have_no_output(self):
        self.assertEqual(render_case_context('not-a-configured-case', ROOT), '')
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(render_case_context('metro-green-line', directory), '')

    def test_empty_context_does_not_require_a_projection_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            (root / 'data/case-context.json').write_text('{"schemaVersion":1,"cases":[]}')
            self.assertEqual(render_case_context('metro-green-line', root), '')

    def test_citation_does_not_infer_official_provenance(self):
        soup = BeautifulSoup(render_case_context('metro-green-line', ROOT), 'html.parser')
        media = soup.select_one('a[href*=youngnews]')
        self.assertIn('閱讀來源', media.get_text())
        self.assertNotIn('官方', media.get_text())
        self.assertIn('2026-05-05', media.get_text())

    def test_bade_does_not_invent_a_councillor_action(self):
        case = next(c for c in self.config['cases'] if c['recordId'] == 'bade-detention')
        self.assertEqual(case['councillorAction']['evidenceStatus'], 'not_collected')
        self.assertEqual(case['councillorAction']['sources'], [])
        self.assertIn('尚未收錄', case['councillorAction']['text'])
        self.assertIn('整體完工時間仍須以水利局公告為準', ''.join(case['notEstablished']))
        self.assertIn('履約期限不能視為全案完工日期', ''.join(case['notEstablished']))
        rendered = render_case_context('bade-detention', ROOT)
        self.assertNotIn('慧文的提案與質詢', rendered)
        self.assertNotIn(case['councillorAction']['text'], rendered)
        self.assertIn('水利局與施工團隊', rendered)
        self.assertEqual(len(BeautifulSoup(rendered, 'html.parser').select('.case-context-point')), 2)

    def test_external_unapproved_source_fails_closed(self):
        config = copy.deepcopy(self.config)
        config['cases'][0]['impact']['sources'] = ['https://example.com/unverified']
        with self.assertRaises(ValueError):
            render_case_context('metro-green-line', self.fixture(config))

    def test_unpublished_id_and_unsourced_attribution_fail_closed(self):
        config = copy.deepcopy(self.config)
        config['cases'][0]['recordId'] = 'not-a-public-record'
        with self.assertRaises(ValueError):
            render_case_context('metro-green-line', self.fixture(config))
        config = copy.deepcopy(self.config)
        config['cases'][0]['councillorAction']['sources'] = []
        with self.assertRaises(ValueError):
            render_case_context('metro-green-line', self.fixture(config))


    def test_latest_record_precedes_navigation_and_generic_sources_are_labelled(self):
        for path in ROOT.glob('achievement-*.html'):
            source = path.read_text()
            self.assertLess(source.index('class="wrap case-latest-wrap"'), source.index('class="wrap civic-article-nav"'))
            soup = BeautifulSoup(source, 'html.parser')
            self.assertFalse(soup.select('.case-latest a[href*="Frame_Councilor.aspx"]'))
            for link in soup.select('.case-sources a[href*="Frame_Councilor.aspx"]'):
                self.assertIn('議員查詢入口', link.get_text())
                self.assertIn('開啟議會查詢首頁', link.parent.select_one('.source-lookup-note').get_text())
                self.assertIn('依上列日期與標題查找原件', link.parent.select_one('.source-lookup-note').get_text())

    def test_home_selection_does_not_delete_unselected_case_context(self):
        soup = BeautifulSoup((ROOT / 'index.html').read_text(), 'html.parser')
        selected = json.loads((ROOT / 'data/civic-home.json').read_text())
        expected = [selected['featured'], *selected['reading']]
        self.assertEqual([node['data-record-id'] for node in soup.select('.civic-story-grid [data-record-id]')], expected)
        # The removed homepage question does not remove the public case or its evidence.
        self.assertTrue((ROOT / 'achievement-bade-detention.html').is_file())
        self.assertIn('bade-detention', {item['recordId'] for item in self.config['cases']})
    def test_search_index_omits_print_utility_text(self):
        items = json.loads((ROOT / 'data/search-index.json').read_text())['items']
        self.assertTrue(all('列印單頁摘要 含資料日期與完整紀錄網址' not in row['keywords'] for row in items))

    def test_editorial_content_is_escaped(self):
        config = copy.deepcopy(self.config)
        config['cases'][0]['question'] = '<script>alert(1)</script>'
        soup = BeautifulSoup(render_case_context('metro-green-line', self.fixture(config)), 'html.parser')
        self.assertFalse(soup.select('script'))
        self.assertEqual(soup.select_one('.case-context-question').get_text(), '<script>alert(1)</script>')


if __name__ == '__main__':
    unittest.main()
