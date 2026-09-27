import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from editorial_pages import validate_page, render_page
from page_seo import apply as apply_seo
from publication_path_guard import evaluate


class EditorialPages(unittest.TestCase):
    def sample(self):
        blank = {'type':'paragraph','title':'','text':'服務處核對公開紀錄。','date':'','url':'','alt':'','credit':'','address':'','publicAccessConfirmed':False}
        return {'section':'council','title':'議會公開資料整理','summary':'整理議會已公開資料。',
                'updated':'2026-09-27','eventStart':'2026-09-27T10:00+08:00','eventEnd':'2026-09-27T11:00+08:00',
                'seo':{'title':'議會公開資料整理｜陳慧文','description':'本頁整理議會公開紀錄與可追溯來源。',
                       'image':'https://www.huiwen.tw/assets/site-share-20260909.png','imageAlt':'陳慧文議會公開資料整理'},
                'blocks':[blank]}

    def test_derived_route_time_and_map_app_link(self):
        path='page-council-public-record.html'
        record=self.sample()
        record['blocks'].append({'type':'map','title':'會勘地點','text':'','date':'','url':'','alt':'','credit':'','address':'高雄市鳳山區錦田路231號','publicAccessConfirmed':False})
        validate_page(path,record,ROOT)
        html=render_page(path,record,ROOT)
        self.assertIn('https://www.huiwen.tw/'+path,html)
        self.assertIn('maps/search/?api=1&amp;query=',html)
        self.assertIn('2026-09-27T10:00+08:00',html)
        self.assertIn('<h1>議會公開資料整理</h1>',html)

    def test_invalid_calendar_time_and_vague_location_fail_closed(self):
        path='page-council-public-record.html'
        record=self.sample(); record['eventStart']='2026-02-30T10:00+08:00'
        with self.assertRaises(ValueError): validate_page(path,record,ROOT)
        record=self.sample(); record['eventEnd']='2026-09-27T09:00+08:00'
        with self.assertRaises(ValueError): validate_page(path,record,ROOT)
        record=self.sample(); record['blocks'].append({'type':'map','title':'','text':'','date':'','url':'','alt':'','credit':'','address':'鳳山車站','publicAccessConfirmed':False})
        with self.assertRaises(ValueError): validate_page(path,record,ROOT)

    def test_external_media_requires_public_access_confirmation(self):
        record=self.sample()
        record['blocks']=[{'type':'photo','title':'','text':'活動照片','date':'',
                           'url':'https://drive.google.com/file/d/1234567890abcde/view',
                           'alt':'活動照片','credit':'服務處','address':'','publicAccessConfirmed':False}]
        with self.assertRaises(ValueError): validate_page('page-council-public-record.html',record,ROOT)
        record['blocks'][0]['publicAccessConfirmed']=True
        validate_page('page-council-public-record.html',record,ROOT)

    def test_website_seo_updates_search_social_and_schema_together(self):
        source=(ROOT/'achievement-changle-hexing-youbike.html').read_text()
        seo=self.sample()['seo']
        changed=apply_seo(source,seo,'achievement-changle-hexing-youbike.html',ROOT)
        self.assertIn('<title>'+seo['title']+'</title>',changed)
        self.assertIn('name="description" content="'+seo['description']+'"',changed)
        self.assertIn('property="og:description" content="'+seo['description']+'"',changed)
        self.assertIn('name="twitter:description" content="'+seo['description']+'"',changed)
        self.assertIn('"description":"'+seo['description']+'"',changed)

    def test_publisher_path_guard_allows_exact_new_page_and_parent(self):
        branch='notion-publish/editorial-page/page-council-public-record.html-abcdef12'
        files=['data/editorial-pages.json','page-council-public-record.html','council-records.html','sitemap.xml','data/search-index.json']
        self.assertTrue(evaluate(branch,'huiwen-publisher[bot]','Bot','',files)[0])
        self.assertFalse(evaluate(branch,'huiwen-publisher[bot]','Bot','',files+['admin/src/index.ts'])[0])
        self.assertFalse(evaluate(branch,'huiwen-publisher[bot]','Bot','',files+['news.html'])[0])


if __name__ == '__main__': unittest.main()
