"""Homepage facts are projections of editable public sources, not preview copies."""
import copy
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from bs4 import BeautifulSoup

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from build_home import (
    local_coordinate_records,
    render_about,
    render_event,
    render_home_map_svg,
    render_home_progress,
    render_recent_local,
    render_services,
    render_contact,
)
from build_guides import load_office
from build_service import render_schedule
from build_civic import render_funding, funding_of
from publication_path_guard import compare_generated_outputs, evaluate


class HomeProjectionTests(unittest.TestCase):
    def test_home_task_card_background_matches_its_light_text_colors(self):
        css=(ROOT/'home.css').read_text()
        card_rule=re.search(r'\.home-redesign \.home-task-paths a\s*\{([^}]+)\}',css)
        hover_rule=re.search(r'\.home-redesign \.home-task-paths a:hover\s*\{([^}]+)\}',css)
        self.assertIsNotNone(card_rule)
        self.assertIsNotNone(hover_rule)
        self.assertIn('background: var(--ink);',card_rule.group(1))
        self.assertIn('background: var(--ink);',hover_rule.group(1))
        foregrounds=['#d5f582','#e1e8de']
        background='#173f33'
        def luminance(color):
            channels=[int(color[i:i+2],16)/255 for i in (1,3,5)]
            linear=[channel/12.92 if channel<=0.04045 else ((channel+0.055)/1.055)**2.4 for channel in channels]
            return sum(weight*channel for weight,channel in zip((0.2126,0.7152,0.0722),linear))
        dark=luminance(background)
        for foreground in foregrounds:
            light=luminance(foreground)
            self.assertGreaterEqual((light+0.05)/(dark+0.05),4.5)

    def test_identity_summary_keeps_the_role_tied_to_its_record_date(self):
        profile=json.loads((ROOT/'data/site-profile.json').read_text())
        soup=BeautifulSoup(render_about(profile),'html.parser')
        section=soup.select_one('section.home-about#about-summary')
        self.assertIsNotNone(section)
        self.assertEqual(section.h2.get_text(),'陳慧文是誰？')
        self.assertEqual(section['aria-labelledby'],section.h2['id'])
        stamp=section.select_one('.home-about-note time')
        self.assertEqual(stamp['datetime'],profile['identity']['recordAsOf'])
        self.assertIn(profile['identity']['confirmedRole'],section.get_text())
        self.assertEqual(section.select_one('a.home-about-link')['href'],'about.html')
        self.assertNotIn('現任',section.get_text())
        later={**profile,'identity':{**profile['identity'],'recordAsOf':'2027-01-05','confirmedRole':'第5屆高雄市議員'}}
        self.assertIn('2027-01-05',render_about(later))
        self.assertIn('第5屆高雄市議員',render_about(later))
        with self.assertRaises(ValueError):
            render_about({**profile,'identity':{**profile['identity'],'recordAsOf':'2026-13-01'}})
        page=BeautifulSoup((ROOT/'index.html').read_text(),'html.parser')
        self.assertEqual(len(page.select('main > section.home-about')),1)

    def test_service_entry_uses_canonical_month_and_office(self):
        office=load_office(ROOT)
        for month in ['2026-10','2027-02']:
            soup=BeautifulSoup(render_services(office,{'month':month}),'html.parser')
            links=soup.select('a[data-home-legal-month]')
            self.assertEqual(len(links),1)
            self.assertEqual(links[0]['data-home-legal-month'],month)
            self.assertIn(str(int(month[-2:]))+'月',links[0].get_text())
            self.assertEqual(len(soup.select('.home-task-paths a')),2)
            self.assertEqual(len(soup.select('.home-lawyer-link')),1)
            self.assertEqual(len(soup.select('a[href^="tel:"]')),0)
            self.assertNotIn('服務處地址：',soup.get_text())

    def test_home_page_has_one_hero_contact_pair_and_two_task_cards(self):
        soup=BeautifulSoup((ROOT/'index.html').read_text(),'html.parser')
        main=soup.select_one('main.home-redesign')
        self.assertEqual(len(main.select('.hero-actions a')),2)
        office=load_office(ROOT)
        self.assertEqual(main.select_one('.hero-actions a.primary')['href'],office['phoneUrl'])
        self.assertEqual(main.select_one('.hero-actions a.primary').get_text(strip=True),'撥打服務處')
        self.assertEqual(main.select_one('.hero-actions a.outline')['href'],'https://line.me/R/ti/p/@yve2766q')
        self.assertEqual(len(main.select('.home-task-paths a')),2)
        self.assertEqual(len(main.select('.home-lawyer-link a[data-home-legal-month]')),1)
        self.assertEqual(len(main.select('.home-task-paths')),1)

    def test_home_page_has_only_the_requested_content_sections(self):
        soup=BeautifulSoup((ROOT/'index.html').read_text(),'html.parser')
        main=soup.select_one('main.home-redesign')
        sections=main.select(':scope > section')
        # about-summary: identity summary added below the first screen (AEO/GEO follow-up).
        self.assertEqual([section.get('id') for section in sections],
                         [None,'recent','home-local-progress','about-summary','council','contact'])
        self.assertEqual(len(main.select('.home-recent-list > li')),3)
        self.assertEqual(len(main.select('[data-home-local-record]')),1)
        self.assertFalse(main.select('.civic-story-grid, #map, .filters, .place'))
        self.assertEqual(main.select_one('.home-local-progress img')['src'],'assets/fengshan-home-map.svg')
        feature=main.select_one('[data-home-recent-item="local"] .home-recent-local')
        self.assertIsNotNone(feature)
        self.assertIsNotNone(feature.select_one('.home-recent-art--local span:first-child'))
        self.assertIsNotNone(feature.select_one('.home-recent-art--local span:nth-child(2)'))
        self.assertIsNotNone(feature.select_one('.home-recent-card-copy h3 a'))
        self.assertIsNotNone(feature.select_one('.home-recent-card-copy .home-recent-copy'))
        self.assertIsNotNone(feature.select_one('.home-recent-card-copy .home-recent-meta'))

    def test_cms_home_preview_targets_the_current_published_feature_slot(self):
        editor=(ROOT/'cms-page-editor.js').read_text()
        self.assertIn('[data-home-recent-item="local"] .home-recent-local',editor)
        self.assertIn('.home-recent-card-copy .home-recent-copy',editor)
        self.assertNotIn('civic-story-grid',editor)
        preview=editor.split('  function applyHomePreview',1)[1].split('  function applyCasePreview',1)[0]
        self.assertIn('typeof featured.lastRecordDate === "string"',preview)
        self.assertIn('latestHistoryEvent(history)?.date',preview)
        self.assertNotIn('localeCompare',preview)

    def test_home_stats_and_village_options_follow_public_projection(self):
        records=json.loads((ROOT/'data/achievements-public.json').read_text())
        html=render_home_progress(ROOT)
        soup=BeautifulSoup(html,'html.parser')
        status_counts={}
        for record in records:
            status_counts[record.get('status')]=status_counts.get(record.get('status'),0)+1
        self.assertEqual(int(soup.select_one('[data-home-stat="total"] strong').get_text()),len(records))
        village_set={v for r in records if r.get('district')=='鳳山區' and r.get('scope') not in {'全市政策','跨區服務'} for v in r.get('villages',[])}
        self.assertEqual(int(soup.select_one('[data-home-stat="villages"] strong').get_text()),len(village_set))
        linked={row['data-home-status']:int(row.select_one('strong').get_text()) for row in soup.select('[data-home-status]')}
        self.assertEqual(linked,status_counts)
        for anchor in soup.select('[data-home-status]'):
            self.assertIn('status=',anchor['href'])
        options=soup.select('#home-village option')
        self.assertEqual([o.get_text() for o in options[1:]],sorted(village_set))
        self.assertTrue(all(option['value']=='v:'+option.get_text() for option in options[1:]))
        self.assertEqual(soup.select_one('.home-village-form')['method'],'get')
        self.assertEqual(len(soup.select('.home-village-form button[type="reset"]')),1)
        self.assertTrue(soup.select_one('.home-village-form noscript'))

    def test_static_map_uses_only_published_fengshan_points_and_attributes_boundary(self):
        records=json.loads((ROOT/'data/achievements-public.json').read_text())
        geojson=json.loads((ROOT/'assets/fengshan-villages.geojson').read_text())
        features=geojson['features']
        locations=local_coordinate_records(records,features)
        svg=render_home_map_svg(records,geojson)
        self.assertGreater(len(locations),0)
        self.assertEqual(svg.count('<circle '),len(locations))
        self.assertEqual(svg.count('<path '),sum(x.get('properties',{}).get('district')=='鳳山區' for x in features))
        self.assertIn('公開紀錄已有的鳳山區座標',svg)
        self.assertIn(geojson['sourceUrl'],svg)
        self.assertIn(geojson['license'],svg)
        self.assertTrue(all(r.get('district')=='鳳山區' and r.get('scope') not in {'全市政策','跨區服務'} for r in locations))
        progress=BeautifulSoup(render_home_progress(ROOT),'html.parser')
        self.assertIn(geojson['sourceUrl'],str(progress.select_one('.home-map-preview figcaption')))
        self.assertIn(geojson['license'],str(progress.select_one('.home-map-preview figcaption')))
        map_link=progress.select_one('.home-map-preview a[aria-label^="在互動地圖查看公開紀錄"]')['href']
        self.assertEqual(map_link,'achievements.html?case=wende-school-center#achievement-map')
        self.assertEqual(progress.select_one('.home-map-text-link')['href'],'achievements.html#case-results')
        featured=next(row for row in records if row['id']=='wende-school-center')
        self.assertTrue(featured.get('coordinates'))
        self.assertIn("new URLSearchParams(location.search).get('case')",(ROOT/'map.js').read_text())

    def test_lawyer_reservation_copy_stays_outside_description_lists(self):
        schedule=json.loads((ROOT/'data/legal-schedule.json').read_text())
        for html in (render_schedule(schedule),render_contact(load_office(ROOT))):
            soup=BeautifulSoup(html,'html.parser')
            for node in soup.find_all(string=lambda value:value and ('預約制' in value or '先來電' in value)):
                self.assertIsNone(node.find_parent('dl'))

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

    def test_home_selection_projection_contains_one_current_public_feature(self):
        config=json.loads((ROOT/'data/civic-home.json').read_text())
        records={x['id']:x for x in json.loads((ROOT/'data/achievements-public.json').read_text())}
        html=render_recent_local(ROOT);soup=BeautifulSoup(html,'html.parser')
        self.assertEqual([x['data-home-local-record'] for x in soup.select('[data-home-local-record]')],[config['featured']])
        featured=records[config['featured']]
        self.assertEqual(soup.select_one('h3 a').get_text(),featured['title'])
        self.assertEqual(soup.get_text().count(featured['title']),1)
        self.assertNotIn('civic-reading',html)

    def test_saved_cms_feature_and_summary_render_into_the_current_home_card(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir()
            record={
                'id':'cms-selected-feature','title':'CMS 主打專題','summary':'原始政績摘要',
                'status':'持續追蹤','categories':['交通與基建'],'villages':['測試里'],
                'history':[{'date':'2026-09-27','title':'最新公開紀錄'}],
            }
            (root/'data/civic-home.json').write_text(json.dumps({
                'featured':record['id'],'reading':['other-feature'],
                'summaries':{record['id']:'CMS 儲存的首頁摘要'},
            }),encoding='utf-8')
            (root/'data/achievements-public.json').write_text(json.dumps([record]),encoding='utf-8')
            soup=BeautifulSoup(render_recent_local(root),'html.parser')
            card=soup.select_one('[data-home-local-record="cms-selected-feature"]')
            self.assertEqual(card.select_one('h3 a').get_text(),'CMS 主打專題')
            self.assertEqual(card.select_one('.home-recent-copy').get_text(),'CMS 儲存的首頁摘要')
            self.assertEqual(card.select_one('.home-recent-art--local span:nth-child(2)').get_text(),'測試里')
            self.assertIn('最新收錄 2026-09-27',card.select_one('.home-recent-meta').get_text())

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
