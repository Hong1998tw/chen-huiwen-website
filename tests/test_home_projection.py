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
    render_home_map_svg,
    render_home_progress,
    render_featured_project,
    render_latest,
    render_services,
    render_contact,
)
from build_guides import load_office
from build_service import render_schedule
from build_civic import render_funding, funding_of
from publication_path_guard import compare_generated_outputs, evaluate
import latest_info

PALETTE={'#8f82bc','#6356a3','#f5cc46','#ffd2be','#ffffff','#292433','#665f70'}


def luminance(color):
    channels=[int(color[i:i+2],16)/255 for i in (1,3,5)]
    linear=[channel/12.92 if channel<=0.04045 else ((channel+0.055)/1.055)**2.4 for channel in channels]
    return sum(weight*channel for weight,channel in zip((0.2126,0.7152,0.0722),linear))


def contrast(a,b):
    high,low=sorted((luminance(a),luminance(b)),reverse=True)
    return (high+0.05)/(low+0.05)


class HomeProjectionTests(unittest.TestCase):
    def test_home_palette_tokens_and_small_text_contrast(self):
        css=(ROOT/'home.css').read_text()
        tokens=dict(re.findall(r'--(purple|deep|gold|peach|ink|muted):\s*(#[0-9a-f]{6})',css))
        self.assertEqual(tokens,{'purple':'#8f82bc','deep':'#6356a3','gold':'#f5cc46','peach':'#ffd2be','ink':'#292433','muted':'#665f70'})
        for retired in ('#3b307e','#29295a','#6657a3'):
            for name in ('home.css','civic.css','styles.css','digital.css','small-q.css'):
                self.assertNotIn(retired,(ROOT/name).read_text().lower(),name)
        # Small text pairs used by the homepage.
        for foreground,background in [('#ffffff','#6356a3'),('#6356a3','#ffffff'),('#292433','#ffd2be'),
                                      ('#292433','#f5cc46'),('#665f70','#ffffff'),('#292433','#f4f2f9'),('#665f70','#f4f2f9')]:
            self.assertGreaterEqual(contrast(foreground,background),4.5,(foreground,background))
        # Pairs the brief rules out for small text really are below 4.5:1.
        self.assertLess(contrast('#8f82bc','#ffffff'),4.5)
        self.assertLess(contrast('#6356a3','#ffd2be'),4.5)
        service=re.search(r'\.home-redesign \.home-service-copy small \{([^}]+)\}',css).group(1)
        self.assertIn('color: var(--ink)',service)
        tab=re.search(r'\.home-latest-tabs button\[aria-selected="true"\]::after \{([^}]+)\}',css).group(1)
        self.assertIn('background: var(--deep)',tab)
        action=re.search(r'\.home-redesign \.latest-action \{([^}]+)\}',css).group(1)
        self.assertIn('color: var(--ink)',action)
        self.assertIn('background: var(--gold)',action)

    def test_service_band_has_four_direct_tasks_and_canonical_month(self):
        office=load_office(ROOT)
        for month in ['2026-10','2027-02']:
            soup=BeautifulSoup(render_services(office,{'month':month}),'html.parser')
            links=soup.select('a.home-service-entry')
            self.assertEqual([a['data-home-task'] for a in links],['chat','phone','line','legal'])
            self.assertEqual(links[0]['href'],'service.html#contact')
            self.assertEqual(links[1]['href'],office['phoneUrl'])
            self.assertIn(office['phone'],links[1].get_text())
            self.assertEqual(links[2]['href'],'https://line.me/R/ti/p/@yve2766q')
            self.assertEqual(links[2]['rel'],['noopener','noreferrer'])
            self.assertEqual(links[3]['data-home-legal-month'],month)
            self.assertIn(str(int(month[-2:]))+'月',links[3].get_text())

    def test_home_page_sections_follow_the_selected_layout(self):
        soup=BeautifulSoup((ROOT/'index.html').read_text(),'html.parser')
        main=soup.select_one('main.home-redesign')
        children=[(node.name,node.get('id')) for node in main.find_all(recursive=False)]
        self.assertEqual(children,[('nav','service'),('section','latest'),('section','progress'),('section','council'),('section','contact')])
        self.assertEqual(main.select_one('h1').get_text(strip=True),'最新資訊')
        self.assertEqual(len(main.select('h1')),1)
        self.assertFalse(main.select('.hero, .hero-portrait, .home-recent, .home-task-paths'))
        self.assertIn('2026 鳳山區・陳慧文5號',main.select_one('#council').get_text())
        self.assertEqual(main.select_one('.home-map-preview img')['src'],'assets/fengshan-home-map.svg')
        tabs=main.select('[role="tab"]')
        self.assertEqual([t.get_text() for t in tabs],['全部','新聞','日常','活動'])
        self.assertEqual([t['aria-selected'] for t in tabs],['true','false','false','false'])
        self.assertTrue(main.select_one('[role="tablist"]').has_attr('hidden'))
        empty=main.select_one('[data-latest-empty]')
        self.assertIn('目前尚未收錄日常貼文',empty.get_text())
        self.assertEqual(empty.select_one('a')['href'],'https://www.facebook.com/hwcfs/')

    def test_latest_section_renders_feed_order_dates_and_fallbacks(self):
        feed=latest_info.project(ROOT)
        soup=BeautifulSoup(render_latest(feed,ROOT),'html.parser')
        items=soup.select('.latest-item')
        self.assertEqual(items[0]['data-latest-id'],feed['items'][0]['id'])
        self.assertIn('is-lead',items[0]['class'])
        self.assertEqual(items[0].select_one('img')['loading'],'eager')
        event=soup.select_one('[data-latest-id="event-campaign-headquarters-opening-2026-10-31"]')
        self.assertIn('活動時間',event.select_one('.latest-date').get_text())
        self.assertEqual(event.select_one('.latest-date time')['datetime'],'2026-10-31T15:50:00+08:00')
        # The publication time orders the list but is not repeated on the public card.
        self.assertIsNone(event.select_one('.latest-published'))
        self.assertNotIn('網站刊登',event.get_text())
        self.assertTrue(event.has_attr('data-event-start'))
        mazu=next(node for node in items if '媽祖港橋' in node.get_text())
        image=mazu.select_one('img')
        self.assertTrue(image['src'].startswith('https://images.newtalk.tw/'))
        self.assertEqual(image['data-latest-fallback'],'assets/news-20260907-mazu-port-bridge.jpg')
        self.assertEqual(image['referrerpolicy'],'no-referrer')
        fallback=mazu.select_one('[data-latest-media-fallback]')
        self.assertTrue(fallback.has_attr('hidden'))
        self.assertTrue(fallback.select_one('a')['href'].startswith('https://newtalk.tw/'))
        for node in items:
            self.assertTrue(node.select_one('.latest-title a')['href'])

    def test_cms_home_preview_targets_the_featured_project_and_latest_order(self):
        editor=(ROOT/'cms-page-editor.js').read_text()
        preview=editor.split('  function applyHomePreview',1)[1].split('  function applyCasePreview',1)[0]
        self.assertIn('[data-home-featured-project]',preview)
        self.assertIn('.home-featured-summary',preview)
        self.assertIn('[data-latest-items]',preview)
        self.assertIn('huiwen:latest-order',preview)
        self.assertIn("huiwen:latest-order",(ROOT/'home.js').read_text())
        self.assertNotIn('civic-story-grid',editor)

    def test_home_progress_omits_statistics_and_follows_catalog(self):
        records=json.loads((ROOT/'data/achievements-public.json').read_text())
        catalog=json.loads((ROOT/'data/public-record-catalog.json').read_text())
        soup=BeautifulSoup(render_home_progress(ROOT),'html.parser')
        # The homepage no longer shows record totals, stage counts or village coverage.
        self.assertFalse(soup.select('[data-home-stat], [data-home-status], .home-total-stat, .home-status-group, .home-village-coverage'))
        for phrase in ('筆公開紀錄','篇完整專題','收錄不等於完成','完整專題的辦理階段','個里有公開紀錄','非鳳山行政里總數'):
            self.assertNotIn(phrase,soup.get_text())
        self.assertEqual(len(catalog),2657)
        self.assertEqual(sum(row.get('recordFormat')=='full' for row in catalog),435)
        self.assertEqual(sum(row.get('recordFormat')=='short' for row in catalog),2222)
        status_counts={}
        for record in records:
            status_counts[record.get('status')]=status_counts.get(record.get('status'),0)+1
        self.assertEqual(sum(status_counts.values()),435)
        # The filtered page counts the catalog; short records carry no stage, so counts agree.
        for status,count in status_counts.items():
            self.assertEqual(sum(row.get('status')==status for row in catalog),count)
        self.assertEqual(soup.select_one('.home-map-text-link')['href'],'achievements.html#case-results')
        self.assertTrue(soup.select_one('.home-map-preview img'))
        fengshan={row['name'] for row in json.loads((ROOT/'data/villages.json').read_text()) if row['district']=='鳳山區'}
        village_set={v for r in catalog for v in r.get('villages',[]) if v in fengshan}
        self.assertGreater(len(village_set),60)
        self.assertIn('文德里',village_set)
        options=soup.select('#home-village option')
        self.assertEqual([o.get_text() for o in options[1:]],sorted(village_set))
        achievement_options=set(re.findall(r'<option value="(v:[^"]+)"',re.search(r'<select id="village-filter">.*?</select>',(ROOT/'achievements.html').read_text(),re.S).group(0)))
        self.assertTrue({option['value'] for option in options[1:]}<=achievement_options)
        form=soup.select_one('.home-village-form')
        self.assertEqual((form['method'],form['action'],form.get('role')),('get','achievements.html#case-results','search'))
        self.assertTrue(soup.select_one('.home-village-form noscript'))

    def test_cms_case_options_projection_is_complete_small_and_tracked_by_quality(self):
        import build_home
        full=json.loads((ROOT/'data/achievements-public.json').read_text())
        options=json.loads((ROOT/build_home.CASE_OPTIONS).read_text())
        self.assertEqual([row['id'] for row in options],[row['id'] for row in full])
        self.assertEqual(len(options),435)
        self.assertEqual(options,build_home.case_options(full))
        self.assertTrue(all(set(row)<=set(build_home.CASE_OPTION_FIELDS) for row in options))
        size=(ROOT/build_home.CASE_OPTIONS).stat().st_size
        self.assertLess(size,300_000)
        self.assertGreater((ROOT/'data/achievements-public.json').stat().st_size,1_000_000)
        # The preview and editor read only projected fields.
        preview=(ROOT/'cms-page-editor.js').read_text().split('  function applyHomePreview',1)[1].split('  function mediaPreview',1)[0]
        used=set(re.findall(r'(?:record|featured)\.([a-zA-Z]+)',preview))-{'images','imageMetadata','imageDimensions'}
        self.assertTrue(used<=set(build_home.CASE_OPTION_FIELDS),used)
        quality=(ROOT/'scripts/quality.py').read_text()
        for name in ('data/home-case-options.json','data/latest-info.json'):
            self.assertIn(name,quality,'tampered generated projections must fail the stale-output gate')
        from publish_from_notion import ALLOWED_PATHS
        self.assertIn('data/home-case-options.json',ALLOWED_PATHS['achievement-content'])
        self.assertIn('data/home-case-options.json',ALLOWED_PATHS['home-content'])

    def test_featured_project_projects_the_cms_selected_record(self):
        config=json.loads((ROOT/'data/civic-home.json').read_text())
        records={x['id']:x for x in json.loads((ROOT/'data/achievements-public.json').read_text())}
        soup=BeautifulSoup(render_featured_project(ROOT),'html.parser')
        card=soup.select_one('[data-home-featured-project]')
        self.assertEqual(card['data-home-featured-project'],config['featured'])
        self.assertEqual(card.select_one('h3 a').get_text(),records[config['featured']]['title'])
        self.assertEqual(card.select_one('.home-featured-summary').get_text(),config['summaries'][config['featured']])
        self.assertIn(records[config['featured']]['status'],card.select_one('.home-featured-status').get_text())

    def test_saved_cms_feature_and_summary_render_into_the_featured_project(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir()
            record={'id':'cms-selected-feature','title':'CMS 主打專題','summary':'原始政績摘要',
                    'status':'持續追蹤','categories':['交通與基建'],'villages':['測試里']}
            (root/'data/civic-home.json').write_text(json.dumps({
                'featured':record['id'],'reading':['other-feature'],
                'summaries':{record['id']:'CMS 儲存的首頁摘要'},
            }),encoding='utf-8')
            (root/'data/achievements-public.json').write_text(json.dumps([record]),encoding='utf-8')
            card=BeautifulSoup(render_featured_project(root),'html.parser').select_one('[data-home-featured-project]')
            self.assertEqual(card.select_one('h3 a').get_text(),'CMS 主打專題')
            self.assertEqual(card.select_one('.home-featured-summary').get_text(),'CMS 儲存的首頁摘要')
            self.assertIn('測試里',card.select_one('.home-featured-kicker').get_text())

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

    def test_editorial_executor_homepage_outputs_require_trusted_rebuild(self):
        args=('notion-publish/editorial-page/page-daily-morning-market.html-1234abcd','publisher[bot]','Bot','publisher[bot]')
        files=['data/editorial-pages.json','page-daily-morning-market.html','index.html','data/latest-info.json','data/search-index.json']
        self.assertTrue(evaluate(*args,files)[0])
        fonts=files+['assets/fonts/huiwen-site-sans/generated/huiwen-index-core-000000000000.woff2']
        self.assertFalse(evaluate(*args,fonts)[0])
        self.assertTrue(evaluate(*args,fonts,generated_files={fonts[-1]})[0])
        self.assertFalse(evaluate(*args,files+['scripts/build_home.py'],generated_files=set())[0])
        self.assertFalse(evaluate(*args,['index.html','data/latest-info.json'])[0])

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
