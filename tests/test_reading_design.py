"""Regression contract for the approved public-reading hierarchy."""
import json
import unittest
from pathlib import Path
from bs4 import BeautifulSoup
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from case_overview import render_overview

class ReadingDesignTests(unittest.TestCase):
    def test_navigation_preserves_every_existing_destination(self):
        groups = json.loads((ROOT / 'data/navigation.json').read_text())
        self.assertEqual([g[0] for g in groups], ['地方與議題','慧文的工作','關於慧文','服務處','2026 選舉'])
        urls = [url for _, links in groups for url, _ in links]
        self.assertEqual(len(urls), len(set(urls)))
        for url in ['achievements.html','explore.html','council-records.html','news.html','press.html','activities.html','updates.html','about.html','political-donation.html','service.html','service.html#monthly-heading','service-guides.html','petition.html','vision.html','election.html']:
            self.assertIn(url, urls)
            self.assertTrue((ROOT / url.split('#')[0]).is_file())
    def test_home_story_precedes_secondary_discovery(self):
        soup = BeautifulSoup((ROOT / 'index.html').read_text(), 'html.parser')
        main = soup.select_one('main')
        self.assertLess(str(main).index('id="projects"'), str(main).index('id="map"'))
        self.assertFalse(soup.select('.civic-tasknav'))
        self.assertEqual(len(soup.select('#civic-query')), 1)
        self.assertEqual(len(soup.select('.hero-portrait')), 1)
        config = json.loads((ROOT / 'data/civic-home.json').read_text())
        records = {r['id']: r for r in json.loads((ROOT / 'data/achievements-public.json').read_text())}
        feature = soup.select_one('.civic-feature')
        self.assertEqual(feature['data-record-id'], config['featured'])
        self.assertIn('civic-feature-copy', feature.find(recursive=False).get('class', []))
        record = records[config['featured']]
        if record.get('funding'):
            self.assertIsNotNone(feature.select_one('.civic-feature-funding'))
        elif record.get('images'):
            self.assertEqual(feature.select_one('.civic-feature-photo img')['loading'], 'lazy')
        for image in soup.select('.civic-story-grid img'):
            self.assertEqual(image['loading'], 'lazy')
    def test_overview_does_not_invent_uncollected_attribution(self):
        records = json.loads((ROOT / 'data/achievements-public.json').read_text())
        byid = {r['id']: r for r in records}
        html = render_overview(byid['bade-detention'], ROOT)
        self.assertNotIn('慧文的行動', html)
        self.assertIn(byid['bade-detention']['status'], html)
        html = render_overview(byid['metro-green-line'], ROOT)
        self.assertIn('慧文的行動', html)
        context = json.loads((ROOT / 'data/case-context.json').read_text())
        self.assertIn(context['cases'][0]['councillorAction']['text'], html)
        self.assertIn('可行性評估', html)
    def test_every_overview_keeps_status_and_sources(self):
        for record in json.loads((ROOT / 'data/achievements-public.json').read_text()):
            soup = BeautifulSoup((ROOT / ('achievement-' + record['id'] + '.html')).read_text(), 'html.parser')
            self.assertIsNotNone(soup.select_one('#case-overview-summary'))
            self.assertIn(record['status'], soup.select_one('#case-overview-summary').get_text())
            self.assertIsNotNone(soup.select_one('#case-sources'))
            for source in record['sources']:
                self.assertTrue(any(a.get('href') == source['url'] for a in soup.select('#case-sources a')))
    def test_policy_topics_precede_comparison_and_preserve_original(self):
        soup = BeautifulSoup((ROOT / 'vision.html').read_text(), 'html.parser')
        data = json.loads((ROOT / 'data/platforms.json').read_text())
        current = next(x for x in data['elections'] if x['year'] == 2026)
        self.assertEqual(len(soup.select('.platform-topic-nav a')), len(current['sections']))
        for section in current['sections']:
            for item in section['items']:
                self.assertIn(item, soup.get_text())
        content = soup.select_one('#platform-2026 .platform-content')
        self.assertLess(str(content).index('platform-theme'), str(content).index('platform-accountability'))
    def test_explore_keeps_no_script_paths(self):
        soup = BeautifulSoup((ROOT / 'explore.html').read_text(), 'html.parser')
        self.assertIsNotNone(soup.select_one('#explore-status'))
        self.assertIsNotNone(soup.select_one('noscript a[href="achievements.html"]'))

if __name__ == '__main__':
    unittest.main()
