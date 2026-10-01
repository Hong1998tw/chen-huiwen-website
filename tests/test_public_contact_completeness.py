"""Public-only address evidence and dated service guidance regressions."""
import json
from pathlib import Path
import unittest
from bs4 import BeautifulSoup
ROOT = Path(__file__).resolve().parents[1]

class PublicContactCompletenessTests(unittest.TestCase):
    def test_public_facility_addresses_keep_their_sources(self):
        rows = {r['id']:r for r in json.loads((ROOT/'data/achievements.json').read_text())}
        expected = {
            'wende-school-center':'文衡路356號',
            'school-crossing-flags':'光復路一段120巷8號',
            'fengshan-columbarium-capacity':'大寮區內坑里六和路78-12號',
            'fengshan-second-market':'二市場85號',
            'fengxin-softball-lighting':'新強路386號',
            'bade-detention':'八德路與文英路口',
            'dadong-park-governance':'光遠路及博愛路段',
            'nanhe-park-youbike':'南光街與南正一路口南側',
        }
        for identity,address in expected.items():
            row=rows[identity]
            self.assertIn(address,row['locationName'])
            self.assertTrue(any(s.get('sourceType')=='公共設施官方地址資料' and s.get('checkedAt')=='2026-10-01' for s in row['sources']))
        self.assertIsNone(rows['fengshan-columbarium-capacity']['coordinates'])
        self.assertNotIn('官網將本案呈現',' '.join(rows['fengshan-columbarium-capacity']['paragraphs']))
    def test_canonical_contact_and_print_share_the_verified_fax(self):
        service=BeautifulSoup((ROOT/'service.html').read_text(),'html.parser')
        contact=service.select_one('#contact .contact-card')
        self.assertIn('830 高雄市鳳山區錦田路231號',contact.get_text())
        self.assertIn('07-815-1104',contact.get_text())
        self.assertEqual(contact.select_one('.big-phone')['href'],'tel:+88678212536')
        self.assertTrue(contact.select_one('a[href^="https://www.kcc.gov.tw/MemberInfo_New.aspx"]'))
        handout=BeautifulSoup((ROOT/'service-print.html').read_text(),'html.parser').select_one('main').get_text()
        self.assertIn('07-815-1104',handout)
    def test_without_javascript_month_table_does_not_promise_current_availability(self):
        service=BeautifulSoup((ROOT/'service.html').read_text(),'html.parser')
        schedule=service.select_one('.schedule-text')
        self.assertIn('先來電確認',schedule.get_text())
        self.assertIn('不能當成其他月份',schedule.get_text())
        self.assertNotIn('先選日期',schedule.get_text())
        self.assertNotIn('列印當月時間表',service.get_text())
        self.assertNotIn('當月公益律師時間表',(ROOT/'service-print.html').read_text())
        canonical=json.loads((ROOT/'data/legal-schedule.json').read_text())
        self.assertEqual(len(schedule.select('tbody tr')),len(canonical['sessions']))
        self.assertIn(canonical['month'].replace('-',' 年 ')[:4],schedule.get_text())
