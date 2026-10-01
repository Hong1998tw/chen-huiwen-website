"""Generated event permissions remain bounded to the single source record."""
import copy
import json
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_events as B
import publish_from_notion as P
import publication_path_guard as G


class EventPathGuardTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / 'data/events.json').read_text())
        self.event = self.data['events'][-1]
        self.template = (ROOT / 'templates/events-page.html').read_text()
        self.key = self.event['id']
        self.branch = 'notion-publish/events/' + self.key + '-abcdef01'

    def verify(self, data, key=None, override=None):
        key = key or self.key
        selected = next(event for event in data['events'] if event['id'] == key)
        pages = {'activities.html': B.render_page(self.template, data['events']), B.event_path(selected): B.render_page(self.template, data['events'], selected)}
        pages.update(override or {})
        G.verify_event_source('notion-publish/events/' + key + '-abcdef01', json.dumps(self.data), json.dumps(data), pages.__getitem__, self.template)

    def test_single_record_allowlist_preserves_infrastructure_boundary(self):
        candidate = SimpleNamespace(domain='events', record_key=self.key, new_text=json.dumps(self.data))
        allowed = P.allowed_for(candidate)
        self.assertIn(B.event_path(self.event), allowed)
        self.assertIn('sitemap.xml', allowed)
        self.assertNotIn(B.event_path(self.data['events'][0]), allowed)
        for forbidden in ['event-other.html', 'scripts/build_events.py', 'templates/events-page.html', 'CNAME', 'credentials.json', '.github/workflows/activity-schedule-qa.yml']:
            self.assertFalse(G.evaluate(self.branch, 'publisher[bot]', 'Bot', '', ['data/events.json', forbidden])[0])
        self.assertTrue(G.evaluate(self.branch, 'publisher[bot]', 'Bot', '', ['data/events.json', B.event_path(self.event), 'sitemap.xml'])[0])
        self.assertFalse(G.evaluate(self.branch, 'publisher[bot]', 'Bot', '', [B.event_path(self.event)])[0])
        candidate.record_key='../secrets'
        with self.assertRaises(P.PublishError): P.allowed_for(candidate)

    def test_add_reschedule_cancel_and_preserved_unknown_fields(self):
        for change in [{'content': '更新公開說明'}, {'end': '2026-10-31T17:00:00+08:00'}, {'status': 'cancelled', 'changeNote': '活動取消'}, {'status': 'rescheduled', 'start': '2026-11-01T15:50:00+08:00', 'changeNote': '活動改期', 'previousSchedule': {'start': self.event['start'], 'end': None}}]:
            data = copy.deepcopy(self.data);data['events'][-1].update(change);self.verify(data)
        original = copy.deepcopy(self.data)
        self.data['events'][-1]['publicExtra'] = {'announcement': '公開補充欄位'}
        updated = copy.deepcopy(self.data);updated['events'][-1]['content'] = '更新公開說明';self.verify(updated)
        self.data = original
        data = copy.deepcopy(self.data)
        added = {**copy.deepcopy(self.event), 'id': 'event-20261102-fixture', 'start': '2026-11-02T15:50:00+08:00'}
        added = {key: value for key, value in added.items() if key in set(P.EVENT_FIELDS) | {'id', 'previousSchedule'}}
        data['events'].append(added);self.verify(data, added['id'])

    def test_location_round_trips_and_cms_updates_keep_other_fields(self):
        text = (ROOT / 'data/events.json').read_text()
        for event in self.data['events']:
            row = {'pageId': 'location-test', 'fields': {key: event.get(key) for key in P.EVENT_FIELDS}, 'system': {'siteId': event['id'], 'syncedHash': P.sha(event)}}
            candidate = P.prepare_event(row, text)
            self.assertEqual(candidate.errors, [])
            self.assertEqual(candidate.new_text, text)
            del row['fields']['location']
            self.assertEqual(P.prepare_event(row, text).new_text, text)
            row['fields']['location'] = '高雄市鳳山區錦田路231號'
            candidate = P.prepare_event(row, text)
            self.assertEqual(candidate.errors, [])
            updated = json.loads(candidate.new_text)
            result = next(item for item in updated['events'] if item['id'] == event['id'])
            self.assertEqual(result['location'], row['fields']['location'])
            for key, value in event.items():
                if key != 'location': self.assertEqual(result[key], value)
            self.verify(updated, event['id'])
            row['system']['syncedHash'] = P.sha(result)
            row['fields']['location'] = None
            cleared = P.prepare_event(row, candidate.new_text)
            self.assertEqual(cleared.errors, [])
            self.assertIsNone(next(item for item in json.loads(cleared.new_text)['events'] if item['id'] == event['id'])['location'])

    def test_bad_source_and_unrelated_records_are_rejected(self):
        data = copy.deepcopy(self.data);data['events'][0]['content'] += '旁筆被改'
        with self.assertRaises(ValueError): self.verify(data)
        for url in ['javascript:alert(1)', 'http://example.com/x', 'https://u:p@example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://drive.google.com/private']:
            data=copy.deepcopy(self.data);data['events'][-1]['sourceUrl']=url
            with self.assertRaises(ValueError): self.verify(data)
        for path in ['../secret.png','assets/events/../../secret.png','https://example.com/photo.png','assets/other-event.jpg']:
            data=copy.deepcopy(self.data);data['events'][-1]['images'][0]['src']=path
            with self.assertRaises(ValueError): self.verify(data)
        data=copy.deepcopy(self.data);data['schemaVersion']=3
        with self.assertRaises(ValueError): self.verify(data)
        with self.assertRaises(ValueError):
            self.verify(self.data, override={B.event_path(self.event): B.render_page(self.template, self.data['events'], self.event).replace(self.event['name'], '不符來源的名稱')})
        with self.assertRaises(ValueError):
            self.verify(self.data, override={'activities.html': '<main>被替換</main>'})


if __name__ == '__main__': unittest.main()
