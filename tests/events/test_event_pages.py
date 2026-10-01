"""Public contracts for immutable event pages, source-linked SEO and reminder choices."""
import copy
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_events as B


class EventPageTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / 'data/events.json').read_text())
        self.events = B.public_events(self.data)
        self.opening = next(item for item in self.events if item['id'] == 'campaign-headquarters-opening-2026-10-31')
        self.council = next(item for item in self.events if item['id'] == 'council-general-interpellation-2026-10-08')
        self.template = (ROOT / 'templates/events-page.html').read_text()

    def test_timeline_is_ordered_and_links_to_stable_pages_with_legacy_anchors(self):
        result = B.render_events(list(reversed(self.events)))
        self.assertIn('<ol class="event-timeline">', result)
        self.assertLess(result.index('id="event-' + self.council['id']), result.index('id="event-' + self.opening['id']))
        for event in self.events:
            self.assertIn('href="' + B.event_path(event) + '"', result)
            self.assertIn('id="event-' + event['id'] + '"', result)
        self.assertNotIn('<img ', result)

    def test_unknown_end_has_choice_but_no_prebuilt_range_or_default(self):
        result = B.render_detail(self.opening)
        self.assertIn('加入 Google 日曆（開始提醒）', result)
        self.assertIn('<option value="">請選擇提醒長度</option>', result)
        self.assertNotIn(' selected', result)
        self.assertNotIn('calendar.google.com', result)
        self.assertIn('<noscript>', result)
        self.assertIn(self.opening['sourceUrl'], result)
        self.assertNotIn('endDate', json.dumps(B.structured_event(self.opening)))
        with self.assertRaises(ValueError): B.calendar_url(self.opening)

    def test_maps_uses_only_known_public_location(self):
        self.assertEqual(parse_qs(urlsplit(B.maps_url(self.opening)).query), {'api': ['1'], 'query': [self.opening['location']]})
        self.assertIsNone(B.maps_url(self.council))
        self.assertNotIn('maps/search', B.render_detail(self.council))
        self.assertNotIn('location', B.structured_event(self.council))
        self.assertIn('活動地點請見議會公告', B.render_detail(self.council))
        self.assertNotIn(self.opening['location'], B.render_detail(self.council))

    def test_detail_seo_is_event_specific_and_never_borrows_another_event_photo(self):
        for event in self.events:
            result = B.render_page(self.template, self.events, event)
            url = B.SITE + B.event_path(event)
            self.assertIn('<link rel="canonical" href="' + url + '">', result)
            self.assertIn('href="activities.html#event-' + event['id'] + '"', result)
            self.assertEqual(result.count('<h1>'), 1)
            self.assertNotIn('{{', result)
            schemas = json.loads(re.search(r'<script type="application/ld\+json">(.*?)</script>', result, re.S)[1])
            self.assertEqual(next(item for item in schemas if item['@type'] == 'Event'), B.structured_event(event))
            self.assertNotIn('organizer', B.structured_event(event))
            self.assertNotIn('performer', B.structured_event(event))
        council = B.render_page(self.template, self.events, self.council)
        self.assertIn('非本活動照片', council)
        for image in self.opening['images']: self.assertNotIn(image['src'], council)
        opening = B.render_page(self.template, self.events, self.opening)
        self.assertIn('property="og:image" content="' + B.SITE + self.opening['images'][0]['src'], opening)

    def test_reschedule_cancel_and_nullable_transitions_keep_url(self):
        for end in [None, '2026-11-01T17:00:00+08:00']:
            event = {**copy.deepcopy(self.opening), 'status': 'rescheduled', 'start': '2026-11-01T15:50:00+08:00', 'end': end, 'changeNote': '活動改期', 'previousSchedule': {'start': self.opening['start'], 'end': self.opening['end']}}
            self.assertEqual(B.event_path(event), B.event_path(self.opening))
            schema = B.structured_event(event)
            self.assertEqual(schema['previousStartDate'], self.opening['start'])
            self.assertEqual('endDate' in schema, bool(end))
            self.assertIn('原定時間', B.render_detail(event))
        cancelled = {**self.opening, 'status': 'cancelled', 'changeNote': '活動取消'}
        result = B.render_detail(cancelled)
        self.assertNotIn('data-event-reminder', result)
        self.assertNotIn('calendar.google.com', result)
        self.assertNotIn('maps/search', result)
        self.assertEqual(B.structured_event(cancelled)['eventStatus'], 'https://schema.org/EventCancelled')
        self.assertIn('自行刪除或更正', result)

    def test_schema_paths_and_html_fail_closed(self):
        for data in [{'events': self.events}, {'schemaVersion': 3, 'events': self.events}, {'schemaVersion': 2, 'events': self.events * 2}]:
            with self.assertRaises(ValueError): B.public_events(data)
        for value in ['../private', 'a.html', 'x/y', 'x<script>', 'UPPER']:
            with self.assertRaises(ValueError): B.event_path({'id': value})
        event = {**self.opening, 'name': '</script><script>alert(1)</script>', 'content': '<img src=x onerror=alert(1)>'}
        result = B.render_page(self.template, [event], event)
        self.assertNotIn('<script>alert(1)', result)
        self.assertNotIn('<img src=x', result)
        self.assertIn('\\u003c', result)

    def test_build_is_deterministic_and_cannot_silently_remove_shared_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir(); (root / 'templates').mkdir()
            (root / 'data/events.json').write_text(json.dumps(self.data))
            (root / 'templates/events-page.html').write_text(self.template)
            B.build(root)
            original = {path.name: path.read_bytes() for path in root.glob('*.html')}
            B.build(root)
            self.assertEqual(original, {path.name: path.read_bytes() for path in root.glob('*.html')})
            (root / 'data/events.json').write_text(json.dumps({**self.data, 'events': [self.council]}))
            with self.assertRaises(ValueError): B.build(root)


if __name__ == '__main__': unittest.main()
