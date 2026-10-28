"""Missing or misbound formal records must fail even above prose coverage limits."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from verify_production import critical_differences


class FormalLiveContractTests(unittest.TestCase):
    def test_one_missing_card_in_a_large_collection_fails(self):
        cards = ['<article class="case-card" data-case="case-' + str(i) + '"><a href="achievement-case-'
                 + str(i) + '.html">公開紀錄 ' + str(i) + '</a></article>' for i in range(100)]
        self.assertIn('facts', critical_differences(''.join(cards), ''.join(cards[:-1])))

    def test_short_record_anchor_cannot_be_rebound_to_another_body(self):
        page = '<article class="public-record" id="record-in-1234567890"><h2>書面反映排水需求</h2><p>僅列發文紀錄</p></article>'
        self.assertIn('facts', critical_differences(page, page.replace('1234567890', '0987654321')))

    def test_candidate_number_drift_fails(self):
        page = '<p class="kicker">2026 陳慧文5號</p>'
        self.assertIn('facts', critical_differences(page, page.replace('5號', '6號')))

    def test_decorative_markup_keeps_the_same_record_contract(self):
        page = '<article class="public-record" id="record-in-1234567890"><h2>排水需求</h2></article>'
        decorated = page.replace('排水需求', '<span>排水需求</span>')
        self.assertEqual(critical_differences(page, decorated), [])


if __name__ == '__main__':
    unittest.main()
