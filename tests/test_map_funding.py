"""Reviewed map funding retains the source amount, basis and attribution."""
import copy, json, sys, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from validate_achievements import validate
from build_public import public_records, validate_map

class FundingContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = json.loads((ROOT / 'data/achievements.json').read_text())
        cls.villages = json.loads((ROOT / 'data/villages.json').read_text())
        cls.case = next(row for row in cls.rows if row['id'] == 'wende-school-center')

    def test_only_reviewed_wende_has_funding_highlight(self):
        self.assertEqual([r['id'] for r in self.rows if r.get('funding')], ['wende-school-center'])
        funding = self.case['funding']
        self.assertEqual((funding['total'], funding['centralGrant']), (60357000, 26107100))
        self.assertEqual((funding['basis'], funding['currency']), ('核定總經費', 'TWD'))
        self.assertIn('林岱樺', funding['collaboration'])
        self.assertIn('2025年5月14日', funding['collaboration'])
        self.assertIn(funding['sourceUrl'], [s['url'] for s in self.case['sources']])
        validate_map(ROOT, public_records(ROOT))

    def test_rejects_amount_type_basis_date_and_unlisted_source(self):
        for key, value in [('total', True), ('total', -1), ('total', 60357000.5), ('centralGrant', 70000000),
                           ('basis', '已撥款'), ('currency', 'USD'), ('approvedOn', '2025-02-30'),
                           ('sourceUrl', 'https://example.org/unreviewed')]:
            with self.subTest(key=key, value=value):
                case = copy.deepcopy(self.case); case['funding'][key] = value
                errors, _ = validate([case], self.villages)
                self.assertTrue(any('funding' in e for e in errors), errors)

    def test_funding_is_identical_in_public_map_and_has_non_js_details(self):
        projected = next(r for r in public_records(ROOT) if r['id'] == self.case['id'])
        mapped = next(r for r in json.loads((ROOT / 'data/achievement-map.json').read_text()) if r['id'] == self.case['id'])
        self.assertEqual(projected['funding'], self.case['funding'])
        self.assertEqual(mapped['funding'], self.case['funding'])
        page = (ROOT / 'achievements.html').read_text()
        self.assertIn('核定總經費</span> <strong>6,035.7萬元</strong>', page)
        self.assertIn('中央補助 2,610.71萬元', page)
        self.assertIn('經費與共同爭取', page)

if __name__ == '__main__':
    unittest.main()
