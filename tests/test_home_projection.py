"""Homepage facts are projections of editable public sources, not preview copies."""
import copy
import json
from pathlib import Path
import sys
import unittest
from bs4 import BeautifulSoup

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from build_home import render_services, render_event
from build_guides import load_office
from build_civic import render_stories, render_home_map, render_funding, funding_of
from publication_path_guard import compare_generated_outputs, evaluate


class HomeProjectionTests(unittest.TestCase):
    def test_service_entry_uses_canonical_month_and_office(self):
        office=load_office(ROOT)
        for month in ['2026-10','2027-02']:
            soup=BeautifulSoup(render_services(office,{'month':month}),'html.parser')
            links=soup.select('a[href="service.html#monthly-heading"]')
            self.assertEqual(len(links),1)
            self.assertEqual(links[0]['data-home-legal-month'],month)
            self.assertIn(str(int(month[-2:]))+'月',links[0].get_text())
            self.assertIsNotNone(soup.select_one('a[href="'+office['phoneUrl']+'"]'))
            self.assertIn(office['address'],soup.get_text())

    def test_home_event_follows_source_changes_and_cancellation(self):
        events=json.loads((ROOT/'data/events.json').read_text())['events']
        original=next(x for x in events if x['id']=='campaign-headquarters-opening-2026-10-31')
        for patch in [{},{'start':'2026-11-01T15:50:00+08:00','status':'rescheduled','changeNote':'公開改期說明','previousSchedule':{'start':original['start'],'end':None}}, {'status':'cancelled','changeNote':'公開取消說明'}]:
            event={**copy.deepcopy(original),**patch}
            html=render_event([event]);soup=BeautifulSoup(html,'html.parser')
            self.assertEqual(soup.select_one('time')['datetime'],event['start'])
            self.assertIn(event['name'],soup.get_text())
            self.assertIsNone(event['end'])
            self.assertNotIn('calendar.google.com',html)
            self.assertTrue(all(original['id'] in a['href'] for a in soup.select('a')))
            if event['status']=='cancelled': self.assertIn('活動已取消',soup.get_text())

    def test_home_selection_projection_tracks_current_source(self):
        config=json.loads((ROOT/'data/civic-home.json').read_text())
        records={x['id']:x for x in json.loads((ROOT/'data/achievements-public.json').read_text())}
        html=render_stories(config,records);soup=BeautifulSoup(html,'html.parser')
        self.assertEqual([x['data-record-id'] for x in soup.select('[data-record-id]')],[config['featured'],*config['reading']])
        featured=records[config['featured']]
        funding=funding_of(featured)
        if funding:
            self.assertIn(funding['sourceUrl'],html)
            if funding.get('collaboration'):
                self.assertIn(funding['collaboration'],soup.get_text())
        else:
            self.assertNotIn('civic-feature-funding',html)
        self.assertEqual(len(BeautifulSoup(render_home_map(config,records),'html.parser').select('.place')),len(config['reading'])+1)

    def test_home_feature_funding_uses_the_selected_record_amounts_and_source(self):
        record={
            'id':'fixture-funded-project', 'title':'測試經費專案',
            'funding':{
                'currency':'TWD', 'total':60357000, 'centralGrant':26107100,
                'approvedOn':'2026-09-01', 'approvalReference':'測試核定文號',
                'sourceUrl':'https://example.invalid/funding-source', 'sourceTitle':'測試來源',
                'collaboration':'測試共同爭取',
            },
        }
        html=render_funding(record)
        soup=BeautifulSoup(html,'html.parser')
        self.assertIn('6,035.7',soup.get_text())
        self.assertIn('2,610.71',soup.get_text())
        self.assertIn('3,424.99',soup.get_text())
        self.assertIn(record['funding']['sourceUrl'],html)

    def test_generated_home_permission_still_requires_domain_source_and_denies_code(self):
        for domain,source in [('events','data/events.json'),('legal-schedule','data/legal-schedule.json'),('achievement-content','data/achievements.json')]:
            args=(f'notion-publish/{domain}/fixture-12345678','publisher[bot]','Bot','publisher[bot]')
            self.assertTrue(evaluate(*args,[source,'index.html'])[0])
            self.assertFalse(evaluate(*args,['index.html'])[0])
            for unsafe in ['scripts/build_home.py','templates/home-main.html','CNAME','admin/src/security.ts']:
                self.assertFalse(evaluate(*args,[source,'index.html',unsafe])[0])

    def test_home_executor_generated_paths_require_a_trusted_exact_rebuild(self):
        args=('notion-publish/home-content/fixture-12345678','publisher[bot]','Bot','publisher[bot]')
        files=['data/civic-home.json','index.html','data/search-index.json','assets/fonts/generated-new.woff2']
        dynamic=set(files)-{'data/civic-home.json'}
        self.assertTrue(evaluate(*args,files,generated_files=dynamic)[0])
        self.assertFalse(evaluate(*args,files,generated_files={'index.html'})[0])

    def test_generated_rebuild_compares_exact_paths_and_bytes(self):
        expected={'data/civic-home.json':b'new source','index.html':b'new page','font-old.woff2':None,'font-new.woff2':b'font'}
        self.assertTrue(compare_generated_outputs(expected,expected)[0])
        self.assertFalse(compare_generated_outputs(expected,{**expected,'scripts/unsafe.py':b'code'})[0])
        self.assertFalse(compare_generated_outputs(expected,{**expected,'index.html':b'tampered'})[0])

    def test_generated_rebuild_rejects_symlink_and_executable_modes(self):
        expected={'data/civic-home.json':b'new source','index.html':b'new page'}
        modes={'data/civic-home.json':'100644','index.html':'100644'}
        self.assertTrue(compare_generated_outputs(expected,expected,expected_modes=modes,actual_modes=modes)[0])
        for mode in ('100755','120000'):
            actual_modes={**modes,'index.html':mode}
            self.assertFalse(compare_generated_outputs(expected,expected,expected_modes=modes,actual_modes=actual_modes)[0])


if __name__=='__main__': unittest.main()
