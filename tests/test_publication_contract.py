"""Publication boundaries and high-impact negative deployment fixtures."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_public as public
import verify_production as live


class PublicProjectionTests(unittest.TestCase):
    def setUp(self):
        self.rows = public.public_records(ROOT)
        self.schema = json.loads((ROOT / 'schema/public-achievement.schema.json').read_text())

    def test_only_reviewed_records_and_public_fields(self):
        raw = json.loads((ROOT / 'data/achievements.json').read_text())
        self.assertEqual({r['id'] for r in self.rows}, {r['id'] for r in raw if public.is_public(r)})
        self.assertTrue(any(not public.is_public(r) for r in raw))
        for row in self.rows:
            self.assertFalse({'editorialReview', 'verification', 'verifiedAt', 'villageMethod'} & row.keys())
        public.validate_schema(self.rows, self.schema)

    def test_unknown_nested_source_fields_never_reach_public_projection(self):
        row = copy.deepcopy(self.rows[0])
        row['editorialReview'] = {'privateNote': 'synthetic fixture'}
        row['sources'][0]['internalNote'] = 'synthetic fixture'
        projected = public.project_value(row, self.schema['items'])
        self.assertNotIn('editorialReview', projected)
        self.assertNotIn('internalNote', projected['sources'][0])

    def test_public_schema_rejects_review_fields_and_pending_status(self):
        for change in ({'editorialReview': {}}, {'status': '待核驗'}):
            rows = copy.deepcopy(self.rows)
            rows[0].update(change)
            with self.assertRaises(ValueError):
                public.validate_schema(rows, self.schema)

    def test_map_cannot_carry_editorial_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            rows = json.loads((ROOT / 'data/achievement-map.json').read_text())
            rows[0]['editorialReview'] = {'note': 'synthetic fixture'}
            (root / 'data/achievement-map.json').write_text(json.dumps(rows))
            with self.assertRaises(ValueError):
                public.validate_map(root, self.rows)

    def test_projection_is_current(self):
        public.write_projection(ROOT, check=True)

    def test_public_status_transition_can_build_before_map_regeneration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            (root / 'schema').mkdir()
            (root / 'schema/public-achievement.schema.json').write_text(json.dumps(self.schema))
            rows = json.loads((ROOT / 'data/achievements.json').read_text())
            changed = next(row for row in rows if public.is_public(row))
            removed_id = changed['id']
            changed['status'] = '待核驗'
            (root / 'data/achievements.json').write_text(json.dumps(rows))
            mapped = json.loads((ROOT / 'data/achievement-map.json').read_text())
            (root / 'data/achievement-map.json').write_text(json.dumps(mapped))
            # The first build-graph step can generate from changed source even
            # while downstream map output still belongs to the previous release.
            projection = public.write_projection(root)
            self.assertNotIn(removed_id, {row['id'] for row in projection})
            with self.assertRaises(ValueError):
                public.write_projection(root, check=True)
            (root / 'data/achievement-map.json').write_text(json.dumps([row for row in mapped if row['id'] != removed_id]))
            public.write_projection(root, check=True)

    def test_build_cannot_replace_source_or_unrelated_directory(self):
        with self.assertRaises(ValueError):
            public.build(ROOT, ROOT)
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            original = destination / 'unrelated.txt'
            original.write_text('keep this fixture')
            with self.assertRaises(ValueError):
                public.build(ROOT, destination)
            self.assertEqual(original.read_text(), 'keep this fixture')

    def test_artifact_allowlist_and_legacy_alias(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'public'
            public.build(ROOT, destination)
            paths = {p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()}
            self.assertFalse(any(p.startswith(('docs/', 'scripts/', 'tests/', '.github/', 'schema/')) for p in paths))
            self.assertNotIn('data/content-governance.json', paths)
            self.assertNotIn('data/civic-home.json', paths)
            self.assertNotIn('README.md', paths)
            self.assertEqual((destination / 'data/achievements.json').read_bytes(), (destination / public.PROJECTION).read_bytes())
            self.assertNotEqual((destination / 'data/achievements.json').read_bytes(), (ROOT / 'data/achievements.json').read_bytes())
            public.validate_artifact_links(destination)


class CriticalDeploymentTests(unittest.TestCase):
    def html(self, name):
        return (ROOT / name).read_text()

    def reject(self, name, old, new):
        original = self.html(name)
        self.assertIn(old, original)
        self.assertTrue(live.critical_differences(original, original.replace(old, new)))

    def test_all_wrong_phones_fail_even_when_old_coverage_passes(self):
        original = self.html('service.html')
        wrong = original.replace('07-821-2536', '07-000-0000').replace('tel:+88678212536', 'tel:+88670000000')
        first, second = live.PageParser(), live.PageParser()
        first.feed(original)
        second.feed(wrong)
        self.assertGreaterEqual(live.visible_text_coverage(first, second), live.MIN_TEXT_COVERAGE)
        self.assertTrue(live.critical_differences(original, wrong))

    def test_tel_target_only_fails(self):
        self.reject('service.html', 'tel:+88678212536', 'tel:+88670000000')

    def test_address_fails(self):
        self.reject('service.html', '錦田路231號', '錦田路999號')

    def test_office_hours_fail(self):
        self.reject('service.html', '09:00–12:00', '10:00–12:00')

    def test_appointment_time_fails(self):
        self.reject('service.html', '19:30–21:00', '18:30–21:00')

    def test_bank_account_fails(self):
        self.reject('political-donation.html', '752200636579', '000000000000')

    def test_election_date_fails(self):
        self.reject('election.html', '2026/11/28', '2026/11/29')

    def test_critical_block_removal_fails(self):
        self.reject('service.html', 'class="hours-card"', 'class="ordinary-card"')

    def test_cloudflare_email_obfuscation_is_normalized(self):
        address = 'office@example.invalid'
        payload = bytes([23] + [ord(char) ^ 23 for char in address]).hex()
        local = f'<div class="footer-grid"><a href="mailto:{address}">{address}</a></div>'
        remote = f'<div class="footer-grid"><a href="/cdn-cgi/l/email-protection#{payload}"><span data-cfemail="{payload}">[email protected]</span></a></div>'
        self.assertEqual(live.critical_differences(local, remote), [])

    def test_representative_detail_pages_and_public_alias(self):
        self.assertGreaterEqual(sum(p.startswith('achievement-') for p in live.CORE_PAGES), 3)
        self.assertEqual(live.canonical_bytes('data/achievements.json'), (ROOT / public.PROJECTION).read_bytes())


if __name__ == '__main__':
    unittest.main()
