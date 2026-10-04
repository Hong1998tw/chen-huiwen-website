"""Public updates must describe website additions without inventing event freshness."""
import copy
from email.utils import parsedate_to_datetime
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_updates as updates


class ContentUpdatesTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / 'data/content-updates.json').read_text())

    def test_initial_entries_are_website_additions_only(self):
        updates.validate(self.data)
        self.assertEqual(len(self.data['updates']), 2)
        self.assertTrue(all(item['eventDate'] is None for item in self.data['updates']))
        body = updates.render_page_body(self.data)
        self.assertEqual(body.count('網站補充日期'), 3)  # Explanation plus two entries.
        self.assertEqual(body.count('不適用（本次為網站內容補充）'), 2)
        self.assertIn('這次補充不表示工程有新的進展', body)

    def test_rss_uses_website_time_even_for_an_old_event(self):
        data = copy.deepcopy(self.data)
        data['updates'][0]['eventDate'] = '2020-03-04'
        rss = ET.fromstring(updates.render_rss(data))
        for item in data['updates']:
            entry = next(node for node in rss.findall('./channel/item') if node.findtext('guid').endswith(item['id']))
            self.assertEqual(parsedate_to_datetime(entry.findtext('pubDate')), updates.website_time(item['websiteUpdatedAt']))
            self.assertIn('事件日期：' + updates.event_label(item), entry.findtext('description'))
            self.assertIn('RSS 顯示的日期採網站補充時間', entry.findtext('description'))

    def test_feed_links_are_absolute_and_guid_stays_stable(self):
        first = ET.fromstring(updates.render_rss(self.data))
        data = copy.deepcopy(self.data)
        data['updates'][0]['websiteUpdatedAt'] = '2026-09-23T10:00:00+08:00'
        second = ET.fromstring(updates.render_rss(data))
        self.assertEqual({node.findtext('guid') for node in first.findall('./channel/item')}, {node.findtext('guid') for node in second.findall('./channel/item')})
        for entry in first.findall('./channel/item'):
            self.assertTrue(entry.findtext('link').startswith(updates.BASE + 'updates.html#update-'))
            self.assertNotIn('href="service', entry.findtext('description'))
            self.assertIn('https://www.huiwen.tw/', entry.findtext('description'))

    def test_entries_sort_by_website_addition_not_event_date(self):
        data = copy.deepcopy(self.data)
        data['updates'][0]['eventDate'] = '2000-01-01'
        data['updates'][0]['websiteUpdatedAt'] = '2026-09-23T08:00:00+08:00'
        data['updates'][1]['eventDate'] = '2026-09-21'
        self.assertEqual(updates.ordered_updates(data)[0]['id'], data['updates'][0]['id'])

    def test_missing_event_date_cannot_silently_become_today(self):
        data = copy.deepcopy(self.data)
        del data['updates'][0]['eventDate']
        with self.assertRaises(ValueError):
            updates.validate(data)

    def test_rejects_unknown_fields_and_duplicate_ids(self):
        for mutate in (
            lambda data: data['updates'][0].update({'privateNote': 'synthetic fixture'}),
            lambda data: data['updates'][0]['sources'][0].update({'internalOwner': 'synthetic fixture'}),
            lambda data: data['updates'][1].update({'id': data['updates'][0]['id']}),
        ):
            data = copy.deepcopy(self.data)
            mutate(data)
            with self.assertRaises(ValueError):
                updates.validate(data)

    def test_rejects_unconfirmed_date_precision_and_missing_timezone(self):
        for value in ['2026-09', '2026-02-30', '']:
            data = copy.deepcopy(self.data)
            data['updates'][0]['eventDate'] = value
            with self.assertRaises(ValueError):
                updates.validate(data)
        for value in ['2026-09-22', '2026-09-22T17:00:00', '2026-02-30T17:00:00+08:00']:
            data = copy.deepcopy(self.data)
            data['updates'][0]['websiteUpdatedAt'] = value
            with self.assertRaises(ValueError):
                updates.validate(data)

    def test_rejects_executable_credential_and_internal_links(self):
        for url in ['javascript:alert(1)', 'http://example.invalid', 'https://user:pass@example.invalid/', 'docs/MAINTENANCE.md']:
            data = copy.deepcopy(self.data)
            data['updates'][0]['pageUrl'] = url
            with self.assertRaises(ValueError):
                updates.validate(data)

    def test_text_escaping_in_html_and_rss(self):
        data = copy.deepcopy(self.data)
        data['updates'][0]['title'] = '<script>synthetic()</script> & fixture'
        self.assertNotIn('<script>synthetic()', updates.render_page_body(data))
        self.assertIn('&lt;script&gt;', updates.render_page_body(data))
        rss = ET.fromstring(updates.render_rss(data))
        self.assertIn(data['updates'][0]['title'], [item.findtext('title') for item in rss.findall('./channel/item')])

    def test_build_is_deterministic_and_only_writes_its_two_outputs(self):
        names = ['data/content-updates.json', 'templates/case-page.html', 'styles.css', 'digital.css', 'digital.js']
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in names:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
            before = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names}
            updates.build(root)
            first = ((root / 'updates.html').read_bytes(), (root / 'updates.xml').read_bytes())
            updates.build(root)
            self.assertEqual(first, ((root / 'updates.html').read_bytes(), (root / 'updates.xml').read_bytes()))
            self.assertEqual(before, {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names})
            self.assertEqual({path.relative_to(root).as_posix() for path in root.rglob('*') if path.is_file()} - set(names), {'updates.html', 'updates.xml'})
            html = first[0].decode()
            self.assertEqual(html.count('<!-- shared-header:start -->'), 1)
            self.assertEqual(html.count('<!-- shared-footer:start -->'), 1)
            self.assertIn('type="application/rss+xml"', html)


if __name__ == '__main__':
    unittest.main()
