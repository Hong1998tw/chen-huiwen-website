import unittest, sys
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from build_events import render_events, calendar_url

class EventTests(unittest.TestCase):
    def setUp(self):
        # In-memory fixture only: never written to deployable event data or HTML.
        self.event = dict(id='calendar-check', name='測試 & 時間', start='2026-09-30T23:30:00+08:00', end='2026-10-01T01:00:00+08:00', content='<script>測試</script>', registration='採電話報名', location='測試地點', sourceUrl='https://example.gov.tw/event')
    def test_calendar_timezone_and_encoding(self):
        q = parse_qs(urlsplit(calendar_url(self.event)).query)
        self.assertEqual(q['dates'], ['20260930T153000Z/20260930T170000Z'])
        self.assertEqual(q['text'], ['測試 & 時間'])
        self.assertEqual(q['ctz'], ['Asia/Taipei'])
    def test_no_fake_registration_and_escape_html(self):
        s = render_events([self.event])
        self.assertNotIn('<script>', s)
        self.assertNotIn('前往報名', s)
        self.assertIn('官方資訊', s)
        self.assertIn('https://example.gov.tw/event', s)
        self.assertIn('加入 Google 日曆', s)
        self.assertIn('2026/10/01 01:00', s)
    def test_reject_bad_dates_duplicates_and_urls(self):
        for change in [dict(end=self.event['start']), dict(start='2026-09-30T23:30:00'), dict(registrationUrl='javascript:alert(1)'), dict(sourceUrl='javascript:alert(1)')]:
            with self.assertRaises(ValueError): render_events([{**self.event, **change}])
        with self.assertRaises(ValueError): render_events([self.event,self.event])
    def test_empty_has_no_booking_or_calendar_button(self):
        s=render_events([])
        self.assertNotIn('calendar.google', s)
        self.assertNotIn('event-card', s)

if __name__=='__main__': unittest.main()
