"""Regression tests for source identity, lifecycle safety and time-sensitive review."""
import copy
from datetime import datetime, date, timedelta
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from build_platforms import platform_registry, render_platforms
from build_events import render_events, calendar_url, validate
from build_profile import render_status
from check_content_freshness import evaluate


class PlatformIdentityTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / 'data/platforms.json').read_text())
        self.records = json.loads((ROOT / 'data/achievements.json').read_text())

    def test_legacy_strings_preserved_and_every_item_has_one_id(self):
        lookup, _ = platform_registry(self.data, self.records)
        texts = [text for entry in self.data['elections'] for section in entry['sections'] for text in section['items']]
        self.assertTrue(all(isinstance(text, str) for text in texts))
        self.assertEqual(len(lookup), len(texts))

    def test_reordering_source_items_does_not_move_evidence_to_other_promise(self):
        section = self.data['elections'][-1]['sections'][0]
        section['items'].reverse()
        rendered = render_platforms(self.data, self.records)
        climate = re.search(r'<li id="platform-item-2026-climate-resilience">(.*?)</li>', rendered, re.S).group(1)
        yellow = re.search(r'<li id="platform-item-2026-yellow-line-local-benefit">(.*?)</li>', rendered, re.S).group(1)
        self.assertIn('bade-detention', climate)
        self.assertNotIn('bade-detention', yellow)

    def test_unreviewed_text_change_fails_instead_of_rebinding_id(self):
        self.data['elections'][-1]['sections'][0]['items'][0] += '未核實新增文字'
        with self.assertRaises(ValueError):
            platform_registry(self.data, self.records)

    def test_nonpublic_evidence_is_rejected(self):
        self.data['itemsById']['2026-pedestrian-safety']['relatedRecordIds'] = ['unknown-case']
        with self.assertRaises(ValueError):
            platform_registry(self.data, self.records)

    def test_comparison_cannot_assert_fulfilment(self):
        self.data['crossTermComparisons'][0]['outcomeStatus'] = 'completed'
        with self.assertRaises(ValueError):
            platform_registry(self.data, self.records)

    def test_unavailable_historical_entries_explain_the_gap(self):
        rendered = render_platforms(self.data, self.records)
        self.assertIn('資料待補：', rendered)
        self.assertIn('政見公報全文尚未取得', rendered)
        self.assertIn('延續關係：待確認', rendered)


class EventLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.event = {'id': 'lifecycle-fixture', 'name': 'In-memory event fixture',
                      'start': '2026-10-08T16:00:00+08:00', 'end': '2026-10-08T16:50:00+08:00',
                      'content': 'Public fixture only', 'registration': '不需報名',
                      'sourceUrl': 'https://example.gov.tw/event', 'status': 'scheduled', 'updatedAt': '2026-09-22'}

    def test_calendar_copy_warning_and_stable_return_url(self):
        from urllib.parse import urlsplit, parse_qs
        details = parse_qs(urlsplit(calendar_url(self.event)).query)['details'][0]
        self.assertIn('不會自動更新', details)
        self.assertIn('#event-lifecycle-fixture', details)

    def test_cancelled_record_remains_without_registration_or_calendar(self):
        event = {**self.event, 'status': 'cancelled', 'changeNote': '主辦單位公告取消', 'registrationUrl': 'https://example.gov.tw/register'}
        rendered = render_events([event])
        self.assertIn('活動已取消', rendered)
        self.assertIn('event-lifecycle-fixture', rendered)
        self.assertNotIn('calendar.google.com', rendered)
        self.assertNotIn('前往報名', rendered)
        with self.assertRaises(ValueError):
            calendar_url(event)

    def test_reschedule_shows_old_and_new_time(self):
        event = {**self.event, 'status': 'rescheduled', 'changeNote': '主辦單位公告改期',
                 'previousSchedule': {'start': '2026-10-07T16:00:00+08:00', 'end': '2026-10-07T16:50:00+08:00'}}
        rendered = render_events([event])
        self.assertIn('2026/10/07 16:00', rendered)
        self.assertIn('2026/10/08 16:00', rendered)
        self.assertIn('時間已更改', rendered)

    def test_status_changes_require_evidence_and_previous_time(self):
        for changes in ({'status': 'cancelled'}, {'status': 'rescheduled', 'changeNote': 'changed'}, {'status': 'unknown'}):
            with self.assertRaises(ValueError):
                validate({**self.event, **changes})


class ContentReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'data').mkdir()
        for name in ('content-governance.json', 'legal-schedule.json', 'events.json', 'platforms.json', 'site-profile.json', 'achievements.json'):
            shutil.copyfile(ROOT / 'data' / name, self.root / 'data' / name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_recorded_date_is_current_with_unassigned_backlog(self):
        result = evaluate(self.root, '2026-09-22')
        self.assertFalse(result['alert'])
        self.assertEqual(result['status'], 'review_backlog')
        self.assertTrue(any(row['state'] == 'unassigned' for row in result['findings']))

    def test_month_turn_uses_taipei_not_utc(self):
        before = evaluate(self.root, datetime.fromisoformat('2026-09-30T15:59:59+00:00'))
        after = evaluate(self.root, datetime.fromisoformat('2026-09-30T16:00:00+00:00'))
        self.assertNotIn('legal-schedule-month', before['newExpiredIds'])
        self.assertIn('legal-schedule-month', after['newExpiredIds'])

    def test_same_expiry_does_not_alert_every_day(self):
        first = evaluate(self.root, '2026-10-01')
        next_day = evaluate(self.root, '2026-10-02', previous=first)
        self.assertTrue(first['alert'])
        self.assertFalse(next_day['alert'])
        self.assertTrue(next_day['expiredSignatures'])

    def test_corrected_month_reports_recovery_without_new_alert(self):
        first = evaluate(self.root, '2026-10-01')
        path = self.root / 'data/legal-schedule.json'
        data = json.loads(path.read_text())
        data.update(month='2026-10', validThrough='2026-10-31', observedAt='2026-10-01', nextReviewAt='2026-10-25')
        # Hypothetical local fixture only; never published to website source.
        data['sessions'] = [{'date': '2026-10-06', 'start': '16:30', 'end': '18:00'}]
        path.write_text(json.dumps(data))
        result = evaluate(self.root, '2026-10-02', previous=first)
        self.assertIn('legal-schedule-month', result['recoveredIds'])
        self.assertFalse(result['alert'])

    def test_identity_review_never_changes_result(self):
        path = self.root / 'data/site-profile.json'
        before = path.read_bytes()
        result = evaluate(self.root, '2026-11-29')
        self.assertIn('profile-identity', result['newExpiredIds'])
        self.assertEqual(before, path.read_bytes())
        self.assertIsNone(json.loads(before)['identity']['result'])

    def test_bad_validity_window_fails_closed(self):
        path = self.root / 'data/legal-schedule.json'
        data = json.loads(path.read_text())
        data['validThrough'] = '2026-10-31'
        path.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            evaluate(self.root, '2026-09-22')

    def test_month_label_alone_cannot_clear_an_expired_schedule(self):
        path = self.root / 'data/legal-schedule.json'
        data = json.loads(path.read_text())
        data.update(month='2026-10', validThrough='2026-10-31', observedAt='2026-10-01', nextReviewAt='2026-10-25')
        path.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            evaluate(self.root, '2026-10-02')

    def test_cancelled_and_past_events_do_not_require_reconfirmation(self):
        path = self.root / 'data/events.json'
        data = json.loads(path.read_text())
        # Independent of the published event count (WP0.4): a future fixture plus every real event.
        data['events'].append({'id': 'fixture-future', 'name': '測試', 'start': '2026-12-01T10:00:00+08:00',
                               'end': '2026-12-01T11:00:00+08:00', 'reviewDueAt': '2026-10-01'})
        for event in data['events']:
            event['status'] = 'cancelled'
        path.write_text(json.dumps(data))
        result = evaluate(self.root, '2026-10-02')
        self.assertFalse(any(row['id'].startswith('event-lifecycle:') for row in result['findings']))

    def test_profile_render_is_recorded_cutoff_not_machine_today(self):
        profile = json.loads((self.root / 'data/site-profile.json').read_text())
        rendered = render_status(profile)
        self.assertIn('2026-09-22', rendered)
        self.assertIn('後續任期與任職狀態請核對', rendered)
        self.assertNotIn('已當選', rendered)

    def review_record_fixtures(self, records, previous=None):
        (self.root / 'data/achievements.json').write_text(json.dumps(records))
        result = evaluate(self.root, '2026-09-22', previous=previous)
        rows = [row for row in result['findings'] if row['id'].startswith('public-record-freshness:')]
        return result, rows

    def test_records_fixed_clock_respects_strict_180_day_review_boundary(self):
        today = date(2026, 9, 22)
        records = [{'id': name, 'title': name, 'status': '持續追蹤',
                    'history': [{'date': (today - timedelta(days=days)).isoformat()}]}
                   for name, days in [('boundary', 180), ('older', 181), ('recent', 10)]]
        result, rows = self.review_record_fixtures(records)
        self.assertEqual([row['id'] for row in rows], ['public-record-freshness:older'])
        self.assertEqual(rows[0]['severity'], 'backlog')
        self.assertFalse(result['alert'])

    def test_editorial_updated_date_cannot_clear_a_record_review_reminder(self):
        record = {'id': 'old-record', 'title': 'Old record fixture', 'status': '爭取規劃',
                  'history': [{'date': '2021-10-19'}], 'updated': '2026-09-01'}
        first, original = self.review_record_fixtures([record])
        record['updated'] = '2026-09-22'
        second, refreshed = self.review_record_fixtures([record], previous=first)
        self.assertEqual(original, refreshed)
        self.assertFalse(second['alert'])

    def test_records_without_dates_need_manual_review_but_unpublished_records_are_excluded(self):
        records = [{'id': name, 'title': name, 'status': status, 'history': [{'date': '2026'}]}
                   for name, status in [('public-undated', '持續追蹤'), ('not-public', '待核驗'), ('done', '已完成')]]
        result, rows = self.review_record_fixtures(records)
        self.assertEqual([row['id'] for row in rows], ['public-record-freshness:public-undated'])
        self.assertEqual(rows[0]['state'], 'record_event_date_missing')
        self.assertEqual(rows[0]['ownerAssignment'], 'unassigned')
        self.assertFalse(result['alert'])

    def test_record_review_uses_latest_event_and_month_end_without_daily_alerts(self):
        records = [{'id': 'latest', 'title': 'Latest fixture', 'status': '持續追蹤',
                    'history': [{'date': '2026-09-01'}, {'date': '2019-01-01'}]},
                   {'id': 'month', 'title': 'Month fixture', 'status': '政策實施',
                    'history': [{'date': '2026-03'}]},
                   {'id': 'old', 'title': 'Old fixture', 'status': '持續追蹤',
                    'history': [{'date': '2019-01-01'}]}]
        first, rows = self.review_record_fixtures(records)
        second, repeated = self.review_record_fixtures(records, previous=first)
        self.assertEqual([row['id'] for row in rows], ['public-record-freshness:old'])
        self.assertEqual(rows, repeated)
        self.assertFalse(second['changed'])
        self.assertFalse(second['alert'])


if __name__ == '__main__':
    unittest.main()
