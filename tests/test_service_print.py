import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from build_service_print import render


class ServicePrintTests(unittest.TestCase):
    def test_publisher_accepts_derived_service_pages_but_not_code(self):
        from publish_from_notion import check_allowed, PublishError
        check_allowed('legal-schedule', ['data/legal-schedule.json', 'service.html', 'service-print.html', 'service-guides.html', 'data/search-index.json'])
        with self.assertRaises(PublishError):
            check_allowed('legal-schedule', ['scripts/build_service_print.py'])

    def test_handout_reads_schedule_and_contact_without_another_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ('service.html', 'templates/case-page.html', 'data/legal-schedule.json',
                         'data/page-metadata.json', 'styles.css', 'digital.css', 'digital.js'):
                (root/name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT/name, root/name)
            path = root/'service.html'
            path.write_text(path.read_text().replace('錦田路231號', '測試路456號'))
            path = root/'data/legal-schedule.json'
            schedule = json.loads(path.read_text())
            # Exercise the still-supported dated legacy format independently of the current complete plan.
            schedule.pop('closedDates',None)
            schedule.pop('weekdayTimes',None)
            schedule['sessions'] = [{'date':'2026-10-01','start':'16:00','end':'17:00','lawyer':'林岡輝'}]
            schedule['month'] = '2026-10'
            path.write_text(json.dumps(schedule))
            page = BeautifulSoup(render(root), 'html.parser')
            main = page.select_one('main')
            self.assertIn('測試路456號', main.get_text())
            self.assertNotIn('錦田路231號', main.get_text())
            self.assertEqual(len(main.select('tbody tr')), 1)
            self.assertIn('16:00–17:00', main.get_text())
            self.assertIn('林岡輝',main.get_text())
            self.assertIn('2026-10', main.get_text())
            self.assertEqual(main.select_one('a.latest-url')['href'], 'https://www.huiwen.tw/service.html')
            self.assertTrue(main.select_one('.print-page').has_attr('hidden'))

    def test_missing_canonical_contact_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root/'data').mkdir()
            for name in ('legal-schedule.json','page-metadata.json'):
                shutil.copyfile(ROOT/'data'/name, root/'data'/name)
            (root/'service.html').write_text('<main>No contact section</main>')
            with self.assertRaisesRegex(ValueError, 'canonical contact'):
                render(root)
