import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from achievement_metadata import history_date_key, latest_history_event
from build_election_page import latest, tracking_items


class HistoryOrderingTests(unittest.TestCase):
    def test_cms_preview_ordering_matches_python_for_all_public_records(self):
        records = json.loads((ROOT / 'data/achievements.json').read_text())
        self.assertEqual(len(records), 429)
        payload = [{'id': row['id'], 'history': row.get('history', [])} for row in records]
        expected = []
        for row in payload:
            latest = latest_history_event(row['history'])
            expected.append(latest.get('date') if latest else None)

        source = (ROOT / 'cms-page-editor.js').read_text()
        start = source.index('  // Match scripts/achievement_metadata.py:')
        end = source.index('  function applyHomePreview', start)
        helpers = source[start:end]
        case_preview = source.split('  function applyCasePreview', 1)[1]
        self.assertIn('const latest = latestHistoryEvent(history);', case_preview)
        self.assertNotIn('localeCompare', case_preview)
        runner = helpers + '''
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const rows = JSON.parse(input);
  process.stdout.write(JSON.stringify(rows.map(row => latestHistoryEvent(row.history)?.date ?? null)));
});
'''
        result = subprocess.run(
            ['node', '-e', runner], input=json.dumps(payload, ensure_ascii=False),
            text=True, capture_output=True, check=True,
        )
        actual = json.loads(result.stdout)
        self.assertEqual(actual, expected)

        by_id = {row['id']: date for row, date in zip(payload, actual)}
        self.assertEqual(by_id['wufu-2nd-lane81-drainage'], '2019-12-25')
        self.assertEqual(by_id['fengbei-lane127-road-opening'], '2021-07-02')

    def test_cms_preview_preserves_calendar_first_range_and_stable_tie_rules(self):
        rows = [
            {'history': [{'date': '第4屆第7次定期大會'}, {'date': '2026-09-17'}, {'date': '2026-09-22'}]},
            {'history': [{'date': '2026-04-28'}, {'date': '2026-07-29 至 08-06'}]},
            {'history': [{'date': '113學年度第2學期'}, {'date': '114學年度第2學期'}]},
            {'history': [{'date': '2026-09-22', 'title': '先收錄'}, {'date': '2026-09-22', 'title': '後收錄'}]},
        ]
        expected = [(latest_history_event(row['history']) or {}).get('date') for row in rows]
        source = (ROOT / 'cms-page-editor.js').read_text()
        start = source.index('  // Match scripts/achievement_metadata.py:')
        end = source.index('  function applyHomePreview', start)
        runner = source[start:end] + '''
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const rows = JSON.parse(input);
  process.stdout.write(JSON.stringify(rows.map(row => latestHistoryEvent(row.history)?.date ?? null)));
});
'''
        result = subprocess.run(
            ['node', '-e', runner], input=json.dumps(rows, ensure_ascii=False),
            text=True, capture_output=True, check=True,
        )
        self.assertEqual(json.loads(result.stdout), expected)

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
