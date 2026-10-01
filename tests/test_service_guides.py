"""Source fidelity and safety checks for the public service guide builder."""
import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from build_guides import BASE, build, load_office, render_guides, validate


class ServiceGuideTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / 'data/service-guides.json').read_text())
        self.legal = json.loads((ROOT / 'data/legal-schedule.json').read_text())
        self.office = load_office(ROOT)

    def soup(self, data=None, legal=None):
        return BeautifulSoup(render_guides(data or self.data, self.office, legal or self.legal), 'html.parser')

    def test_each_guide_is_readable_without_script_or_form(self):
        soup = self.soup()
        self.assertEqual(len(soup.select('article.service-guide')), 3)
        self.assertFalse(soup.select('form, input, textarea, iframe, script, details'))
        for guide in soup.select('article.service-guide'):
            self.assertFalse(guide.select('[hidden]'))
            self.assertEqual([h.get_text() for h in guide.select('h3')],
                             ['聯絡前建議準備', '可協助範圍', '承辦機關／服務窗口', '下一步', '來源與查核'])
            self.assertTrue(guide.select('.guide-sources time[datetime]'))

    def test_local_anchors_exist_and_no_petition_workflow_was_added(self):
        soup = self.soup()
        service = BeautifulSoup((ROOT / 'service.html').read_text(), 'html.parser')
        for anchor in soup.select('a[href]'):
            href = anchor['href']
            if href.startswith('#'):
                self.assertIsNotNone(soup.find(id=href[1:]), href)
            if href.startswith('service.html#'):
                self.assertIsNotNone(service.find(id=href.split('#', 1)[1]), href)
            self.assertNotIn('petition', href)
            self.assertNotIn('notion.', href)

    def test_road_intake_distinguishes_city_and_outside_city_phone(self):
        road = self.soup().select_one('#road-damage')
        self.assertIn('高雄市內', road.select_one('a[href="tel:1999"]').get_text())
        self.assertIn('外縣市', road.select_one('a[href="tel:+88673352999"]').get_text())
        self.assertIn('權責機關', road.get_text())
        self.assertTrue(road.select_one('a[href="https://rdec.kcg.gov.tw/cp.aspx?n=5968D3B4BBA6EBD9"]'))

    def test_schedule_source_follows_canonical_data_without_copying_slots(self):
        legal = {**self.legal, 'sourceTitle': '十月公開表測試', 'sourceUrl': 'https://example.gov.tw/october', 'observedAt': '2026-10-01',
                 'sessions': [{'date': '2099-10-31', 'start': '22:37', 'end': '23:49'}]}
        soup = self.soup(legal=legal)
        guide = soup.select_one('#legal-consultation')
        self.assertEqual(guide.select_one('a[href="https://example.gov.tw/october"]').get_text(strip=True).split('↗')[0], '十月公開表測試')
        self.assertTrue(guide.select_one('time[datetime="2026-10-01"]'))
        self.assertNotIn('2099-10-31', guide.get_text())
        self.assertNotIn('22:37', guide.get_text())
        self.assertTrue(guide.select_one('a[href="service.html#monthly-heading"]'))

    def test_office_facts_follow_service_page_and_missing_contact_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'data').mkdir()
            shutil.copyfile(ROOT / 'data/site-profile.json', root / 'data/site-profile.json')
            source = (ROOT / 'service.html').read_text()
            source = source.replace('07-821-2536', '07-000-0000').replace('tel:+88678212536', 'tel:+88670000000')
            source = source.replace('830 高雄市鳳山區錦田路231號', '測試地址').replace('14:00–18:00', '14:00–17:00')
            (root / 'service.html').write_text(source)
            office = load_office(root)
            rendered = render_guides(self.data, office, self.legal)
            self.assertEqual(office['phone'], '07-000-0000')
            self.assertEqual(office['address'], '測試地址')
            self.assertIn('14:00–17:00', rendered)
            self.assertNotIn('07-821-2536', rendered)
            (root / 'service.html').write_text('<main>No contact facts</main>')
            with self.assertRaises(ValueError):
                load_office(root)

    def test_duplicate_ids_missing_evidence_and_unsafe_links_fail(self):
        cases = []
        duplicate = copy.deepcopy(self.data)
        duplicate['guides'][1]['id'] = duplicate['guides'][0]['id']
        cases.append(duplicate)
        missing = copy.deepcopy(self.data)
        missing['guides'][0]['sources'] = []
        cases.append(missing)
        for url in ('javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com'):
            unsafe = copy.deepcopy(self.data)
            unsafe['guides'][0]['actions'][0]['url'] = url
            cases.append(unsafe)
        for case in cases:
            with self.assertRaises(ValueError):
                validate(case)

    def test_text_is_escaped_and_dates_come_from_source_not_wall_clock(self):
        data = copy.deepcopy(self.data)
        data['checkedAt'] = '2020-01-02'
        data['guides'][0]['preparation'][0] = '<script>alert("x")</script>'
        soup = self.soup(data=data)
        self.assertFalse(soup.find('script'))
        self.assertIn('<script>alert("x")</script>', soup.get_text())
        self.assertEqual(soup.find('time')['datetime'], '2020-01-02')

    def test_build_has_own_metadata_shared_markers_and_print_control(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ('data/service-guides.json', 'data/legal-schedule.json', 'data/site-profile.json', 'service.html', 'templates/events-page.html'):
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, root / name)
            rendered = build(root)
            self.assertEqual(rendered, build(root), 'Repeated builds must be deterministic')
            soup = BeautifulSoup(rendered, 'html.parser')
            self.assertEqual(soup.select_one('link[rel="canonical"]')['href'], BASE)
            self.assertNotIn('activities.html', str(soup.head))
            self.assertEqual(len(soup.select('h1')), 1)
            self.assertTrue(soup.select_one('button.print-page[type="button"][hidden]'))
            self.assertEqual(len(json.loads(soup.select_one('script[type="application/ld+json"]').string)), 2)
            for marker in ('shared-header:start', 'shared-header:end', 'shared-footer:start', 'shared-footer:end'):
                self.assertEqual(rendered.count('<!-- ' + marker + ' -->'), 1)


if __name__ == '__main__':
    unittest.main()
