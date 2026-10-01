"""Start-only schedules must survive the same public and CMS publication path."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_events as B
import build_election_page as E
import publish_from_notion as P
from check_content_freshness import evaluate


class OptionalEndTests(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT / 'data/events.json').read_text()
        self.data = json.loads(self.text)
        self.event = next(e for e in self.data['events'] if e['id'] == 'campaign-headquarters-opening-2026-10-31')

    def row(self, event):
        return {'pageId': 'optional-end-fixture', 'fields': {k: event.get(k) for k in P.EVENT_FIELDS},
                'system': {'siteId': event['id'], 'syncedHash': P.sha(event)}}

    def test_public_start_only_preserves_cards_without_calendar_duration(self):
        self.assertIsNone(self.event['end'])
        for end in [None, 'omitted']:
            event = copy.deepcopy(self.event)
            if end == 'omitted': event.pop('end')
            html = B.render_events([event])
            self.assertIn('2026/10/31（六）15:50', html)
            self.assertNotIn('calendar.google.com', html)
            self.assertNotIn('calendar.google.com', E.render_events({'events': [event]}))
            self.assertEqual(html.count('<img '), 2)
            for image in event['images']:
                self.assertTrue((ROOT / image['src']).is_file())
                self.assertIn(image['src'], html)
            with self.assertRaises(ValueError): B.calendar_url(event)
        for end in ['', False, 0, 'bad', '2026-10-31T15:00:00+08:00', '2026-10-31T16:00:00']:
            with self.assertRaises(ValueError): B.validate({**self.event, 'end': end})

    def test_cms_round_trip_and_all_nullable_end_transitions(self):
        candidate = P.prepare_event(self.row(self.event), self.text)
        self.assertEqual(candidate.errors, [])
        self.assertFalse(candidate.changed)
        self.assertEqual(candidate.new_text, self.text)
        transitions = [dict(content='更新活動說明'), dict(end='2026-10-31T17:00:00+08:00'),
                       dict(status='cancelled', changeNote='取消測試'),
                       dict(status='rescheduled', changeNote='改期測試', start='2026-11-01T15:50:00+08:00')]
        for patch in transitions:
            row = self.row(self.event)
            row['fields'].update(patch)
            candidate = P.prepare_event(row, self.text)
            self.assertEqual(candidate.errors, [])
            new = json.loads(candidate.new_text)
            self.assertEqual(new['events'][0], self.data['events'][0])
            updated = new['events'][1]
            self.assertEqual(updated['images'], self.event['images'])
            self.assertEqual(updated['location'], self.event['location'])
            self.assertTrue(candidate.preview)
            B.render_events([updated])
            if patch.get('end'):
                row = self.row(updated); row['fields']['end'] = None
                cleared = P.prepare_event(row, candidate.new_text)
                self.assertEqual(cleared.errors, [])
                self.assertIsNone(json.loads(cleared.new_text)['events'][1]['end'])

    def test_bad_image_paths_and_incomplete_metadata_are_rejected(self):
        for patch in [{'src': 'https://example.com/image.png'}, {'width': 0}, {'alt': ''}]:
            event = copy.deepcopy(self.event); event['images'][0].update(patch)
            with self.assertRaises(ValueError): B.validate(event)

    def test_freshness_uses_announced_day_without_inventing_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'data').mkdir()
            config = {'timezone': 'Asia/Taipei', 'owners': [{'id': 'events', 'assignmentStatus': 'assigned'}],
                      'checks': [{'id': 'events', 'kind': 'events', 'ownerId': 'events', 'source': 'data/events.json', 'reviewTask': '核對活動'}]}
            (root / 'data/content-governance.json').write_text(json.dumps(config))
            for status in ['scheduled', 'cancelled']:
                event = {**self.event, 'status': status}
                (root / 'data/events.json').write_text(json.dumps({'events': [event]}))
                for day in ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']:
                    report = evaluate(root, as_of=day)
                    expected = status == 'scheduled' and day in ['2026-10-30', '2026-10-31']
                    self.assertEqual(bool(report['findings']), expected)
                self.assertIsNone(event['end'])


if __name__ == '__main__': unittest.main()
