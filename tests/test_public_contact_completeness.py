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
        evidence_urls = {
            "wende-school-center": "https://employ.kh.edu.tw/Html/2026/6/%E9%B3%B3%E5%B1%B1%E5%8D%80115%E5%AD%B8%E5%B9%B4%E5%BA%A6%E6%96%87%E5%BE%B7%E5%9C%8B%E5%B0%8F%E7%AC%AC1%E8%99%9F%E7%AC%AC2%E6%AC%A1%E5%85%AC%E5%91%8A%E7%B0%A1%E7%AB%A0.html",
            "school-crossing-flags": "https://employ.kh.edu.tw/Html/2026/8/%E9%B3%B3%E5%B1%B1%E5%8D%80115%E5%AD%B8%E5%B9%B4%E5%BA%A6%E4%B8%AD%E5%B1%B1%E5%9C%8B%E5%B0%8F%E7%AC%AC4%E8%99%9F%E7%AC%AC1%E6%AC%A1%E5%85%AC%E5%91%8A%E7%B0%A1%E7%AB%A0.html",
            "fengshan-columbarium-capacity": "https://mso.kcg.gov.tw/cp.aspx?n=7EEA0D306412ED3A",
            "fengshan-second-market": "https://edbkcg.kcg.gov.tw/cp.aspx?n=58B03765A9BD67E6",
            "fengxin-softball-lighting": "https://www.bip.gov.tw/info.aspx?cid=7d36b488de635c9a&pageid=9aef2da48d1c26b7",
            "bade-detention": "https://wrb.kcg.gov.tw/ActivitiesDetailC001100.aspx?Cond=2afb5f34-d4d0-48c2-8f7a-7633695e3f4f",
            "dadong-park-governance": "https://khh.travel/zh-tw/attractions/detail/152/",
            "nanhe-park-youbike": "https://www.youbike.com.tw/region/kcg/news/status/6a05222fcaacd6244e0236a2/"
        }
        for identity,address in expected.items():
            row=rows[identity]
            self.assertIn(address,row['locationName'])
            self.assertIn(evidence_urls[identity], [s['url'] for s in row['sources']], identity)
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
