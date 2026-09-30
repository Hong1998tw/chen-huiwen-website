import copy
import json
from pathlib import Path
import sys
import unittest
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from achievement_metadata import history_date_key, latest_history_event
from build_election_page import latest, tracking_items


class HistoryOrderingTests(unittest.TestCase):
    def test_session_label_does_not_outrank_an_explicit_date(self):
        events = [
            {'date': '第4屆第7次定期大會', 'title': '提案'},
            {'date': '2026-09-17', 'title': '現行範圍'},
            {'date': '2026-09-22', 'title': '質詢回應'},
        ]
        original = copy.deepcopy(events)
        self.assertEqual(latest_history_event(events)['date'], '2026-09-22')
        self.assertEqual(latest({'history': events})['date'], '2026-09-22')
        self.assertEqual(events, original)

    def test_year_month_and_range_labels_are_not_discarded_or_rewritten(self):
        events = [{'date': '2026-04-28'}, {'date': '2026-07-29 至 08-06'}]
        self.assertEqual(latest_history_event(events)['date'], '2026-07-29 至 08-06')
        self.assertGreater(history_date_key('2026'), history_date_key('2025-12-31'))
        self.assertGreater(history_date_key('2026-09'), history_date_key('2026-04-28'))
        self.assertFalse(history_date_key('114學年度第2學期')[0])
        self.assertEqual(latest_history_event([{'date': '114學年度第2學期'}])['date'], '114學年度第2學期')
        self.assertIsNone(latest_history_event([]))

    def test_tracking_sort_does_not_use_session_labels_or_edit_dates(self):
        records = [
            {'id': 'label', 'status': '持續追蹤', 'sources': [{}], 'history': [{'date': '第4屆第7次定期大會'}], 'updated': '2099-01-01'},
            {'id': 'dated', 'status': '持續追蹤', 'sources': [{}], 'history': [{'date': '2026-09-22'}], 'updated': '2000-01-01'},
        ]
        self.assertEqual([r['id'] for r in tracking_items(records)], ['dated', 'label'])

    def test_published_case_selects_the_dated_response_but_keeps_every_record(self):
        records = json.loads((ROOT / 'data/achievements-public.json').read_text())
        boai = next(r for r in records if r['id'] == 'boai-card-rehab-bus-points')
        soup = BeautifulSoup((ROOT / 'achievement-boai-card-rehab-bus-points.html').read_text(), 'html.parser')
        self.assertEqual(soup.select_one('.case-latest time').get_text(), '2026-09-22')
        self.assertIn('交通部門質詢追問制度進度', soup.select_one('.case-latest').get_text())
        self.assertEqual([n.get_text() for n in soup.select('.case-timeline time')], [h['date'] for h in boai['history']])
        range_page = BeautifulSoup((ROOT / 'achievement-guopi-retaining-wall.html').read_text(), 'html.parser')
        self.assertEqual(range_page.select_one('.case-latest time').get_text(), '2026-07-29 至 08-06')

    def test_election_static_copy_keeps_the_known_date_and_neutral_missing_date_label(self):
        soup = BeautifulSoup((ROOT / 'election.html').read_text(), 'html.parser')
        link = soup.select_one('#campaign-tracking h3 a[href="achievement-boai-card-rehab-bus-points.html"]')
        self.assertEqual(link.find_parent('article').select_one('.campaign-record time').get_text(), '2026-09-22')
        self.assertNotIn('日期尚未確認', soup.get_text())


if __name__ == '__main__':
    unittest.main()
