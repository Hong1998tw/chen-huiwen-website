import copy, json, sys, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from build_service import validate_schedule, render_schedule
from publish_from_notion import prepare_legal, dump_legal
from build_legal_shared import FILES
class MonthlyCalendarTests(unittest.TestCase):
    def setUp(self):
        self.data=json.loads((ROOT/'data/legal-schedule.json').read_text())
    def test_public_sessions_are_named_and_current_october_plan_is_complete(self):
        validate_schedule(self.data)
        self.assertTrue(all(s.get('lawyer') for s in self.data['sessions']))
        self.assertTrue(all(d.startswith(self.data['month']) for d in self.data['closedDates']))
        rendered=render_schedule(self.data)
        self.assertIn('legal-schedule-data',rendered)
        self.assertIn('下載本月圖卡 PNG',rendered)
        self.assertNotIn('localStorage',rendered)
        self.assertNotIn('每月圖卡編輯',rendered)
        if self.data['sessions']:self.assertIn('<td>'+self.data['sessions'][0]['lawyer']+'</td>',rendered)
    def test_private_pending_dates_and_incomplete_public_plans_fail_closed(self):
        for patch in [{'unconfirmedDates':['2026-10-02']},{'closedDates':[]},{'sessions':[{**self.data['sessions'][0],'lawyer':'<b>名字</b>'}]}]:
            with self.assertRaises(ValueError):validate_schedule({**self.data,**patch})
    def test_rollover_archives_previous_month_without_nested_history(self):
        self.data={'schemaVersion':2,'month':'2026-10','observedAt':'2026-10-01','sourceUrl':'https://www.huiwen.tw/service.html#monthly-heading','sourceTitle':'測試排程','nextReviewAt':'2026-10-20','sessions':[{'date':'2026-10-01','start':'19:30','end':'21:00','lawyer':'林岡輝'}],'history':[{'month':'2026-09','observedAt':'2026-09-01','sourceUrl':'https://www.huiwen.tw/service.html#monthly-heading','sessions':[{'date':'2026-09-03','start':'19:30','end':'21:00'}]}]}
        fields={k:self.data[k] for k in ('month','observedAt','sourceUrl','sourceTitle','nextReviewAt')}
        fields.update(month='2026-11',nextReviewAt='2026-11-10')
        row={'pageId':'monthly-fixture','fields':fields,'sessions':[{'date':'2026-11-03','start':'16:30','end':'18:00','lawyer':'陳順得'}]}
        candidate=prepare_legal(row,dump_legal(self.data))
        self.assertEqual(candidate.errors,[])
        data=json.loads(candidate.new_text)
        self.assertEqual([m['month'] for m in data['history']],['2026-09','2026-10'])
        self.assertEqual(data['history'][-1]['sessions'],self.data['sessions'])
        self.assertNotIn('history',data['history'][-1])
        validate_schedule(data)
    def test_public_and_authenticated_renderers_are_byte_identical(self):
        for relative in FILES:self.assertEqual((ROOT/relative).read_bytes(),(ROOT/'admin/public'/relative).read_bytes(),relative)
    def test_public_page_does_not_load_staff_editor(self):
        page=(ROOT/'service.html').read_text()
        self.assertIn('legal-calendar.js',page)
        self.assertNotIn('legal-month-editor.js',page)
        self.assertNotIn('每月圖卡編輯',page)
        self.assertIn('公益律師諮詢時刻表',page)
        self.assertNotIn('查看 2026 年 9 月公開圖卡（歷史）',page)
if __name__=='__main__':unittest.main()
