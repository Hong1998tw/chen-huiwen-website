"""Monthly source and archived/public schedule separation, without private attachments."""
import copy
import json
from pathlib import Path
import sys
import unittest
from bs4 import BeautifulSoup
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from build_service import render_schedule, validate_schedule, OWN_SCHEDULE_URL

class LegalScheduleHistoryTests(unittest.TestCase):
    def setUp(self):
        self.previous={'month':'2026-09','observedAt':'2026-09-22',
            'sourceUrl':'https://www.canva.com/design/example/view',
            'sourceTitle':'9月公開圖卡',
            'sessions':[{'date':'2026-09-22','start':'16:30','end':'18:00'}]}
        self.current={'month':'2026-10','observedAt':'2026-10-01',
            'sourceUrl':OWN_SCHEDULE_URL,'sourceTitle':'服務處10月文字公告',
            'sessions':[{'date':'2026-10-28','start':'10:00','end':'11:30'}],
            'history':[self.previous]}
    def test_text_announcement_and_archive_are_separate(self):
        page=BeautifulSoup(render_schedule(self.current),'html.parser')
        current=page.select_one('.schedule-text')
        archive=page.select_one('.schedule-archive')
        self.assertEqual(current['data-schedule-month'],'2026-10')
        self.assertIn('10/28（三）',current.get_text())
        self.assertIn('10:00–11:30',current.get_text())
        self.assertIn('服務處10月文字公告',current.get_text())
        self.assertFalse(current.select('a[href*="canva.com"],iframe'))
        self.assertEqual(archive.select_one('[data-archive-month]')['data-archive-month'],'2026-09')
        self.assertIn('9/22（二）',archive.get_text())
        self.assertNotIn('data-session-date',str(archive))
        self.assertTrue(archive.select_one('a[href*="canva.com"]'))
    def test_invalid_archive_cannot_be_displayed_as_current(self):
        for month in ['2026-10','2026-11']:
            record=copy.deepcopy(self.current)
            record['history'][0]['month']=month
            record['history'][0]['sessions'][0]['date']=month+'-22'
            with self.assertRaises(ValueError):
                validate_schedule(record)
        record=copy.deepcopy(self.current)
        record['history'][0]['sessions'][0]['date']='2026-10-22'
        with self.assertRaises(ValueError):
            validate_schedule(record)
    def test_private_attachment_url_and_html_are_never_needed(self):
        record=copy.deepcopy(self.current)
        record['sourceTitle']='<script>unsafe</script>'
        page=BeautifulSoup(render_schedule(record),'html.parser')
        self.assertFalse(page.select('script:not([type="application/json"])'))
        data=json.loads(page.select_one('#legal-schedule-data').string)
        self.assertEqual(data['sessions'],record['sessions'])
        for url in ['javascript:alert(1)','https://user:secret@example.com/card']:
            record['sourceUrl']=url
            with self.assertRaises(ValueError):
                validate_schedule(record)
