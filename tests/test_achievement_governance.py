"""Synthetic cases only. No real service cases or registry is needed by CI."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from achievement_metadata import facts_html, head_text, is_public, search_text, village_lookup
from audit_achievement_coverage import Matcher, compare, normalize_location, read_candidates
from validate_achievements import privacy_issues, validate


def villages():
    return [dict(district='測試區', name=n, currentHead=h, term='測試任期', boundaryName=n, sourceUrl='https://test.gov.tw/directory', sourceDate=None, verifiedAt='2026-09-12') for n,h in [('測試甲里','測試甲里長'),('測試乙里','測試乙里長')]]


def case():
    return dict(id='test-road', title='測試工程', summary='測試用公共工程', categories=['交通與基建'], subcategories=['道路'], villages=['測試甲里'], district='測試區', scope='測試區', status='持續追蹤', coordinates=None, locationName='測試路565巷', locationNote='第一路口至第二路口；代表位置不是工程範圍。', budget='', updated='2026-09-12', paragraphs=['測試內容'], history=[dict(date='2026-08-01',title='會勘',text='測試歷程')], images=[], sources=[dict(title='測試公告',url='https://test.gov.tw/works/1')], related=[])


def candidate(**kwargs):
    return dict(candidate_id='test-candidate', candidate_status='待核驗', publicability='needs_verification', verification_status='pending', **kwargs)


class MetadataTests(unittest.TestCase):
    def test_village_lookup_is_district_scoped(self):
        rows=villages(); other=copy.deepcopy(rows[0]); other['district']='另一測試區'; other['currentHead']='另一里長'; rows.append(other)
        lookup=village_lookup(rows)
        self.assertEqual(len(lookup),3)
        self.assertEqual(lookup[('另一測試區','測試甲里')]['currentHead'],'另一里長')

    def test_single_village_semantic_facts(self):
        facts=facts_html(case(),village_lookup(villages()))
        self.assertIn('<dt>里別</dt><dd>測試甲里</dd>',facts)
        self.assertIn('<dt>現任里長</dt><dd>測試甲里長</dd>',facts)
        self.assertIn('位置／地址',facts)
        self.assertIn('工程範圍／位置說明',facts)

    def test_cross_village(self):
        c=case(); c['villages']=['測試甲里','測試乙里']
        self.assertEqual(head_text(c,village_lookup(villages())),'測試甲里 測試甲里長；測試乙里 測試乙里長')

    def test_city_policy(self):
        c=case(); c.update(scope='全市政策',villages=[],locationName='')
        facts=facts_html(c,village_lookup(villages()))
        self.assertIn('<dt>服務範圍</dt><dd>高雄市</dd>',facts)
        self.assertIn('<dt>現任里長</dt><dd>不適用</dd>',facts)
        self.assertNotIn('位置／地址',facts)
        self.assertFalse(validate([c],villages())[0])

    def test_unknown_village_fails(self):
        c=case(); c['villages']=['不存在里']
        self.assertTrue(validate([c],villages())[0])

    def test_missing_head_fails(self):
        rows=villages(); rows[0]['currentHead']=''
        self.assertTrue(validate([case()],rows)[0])

    def test_invalid_coordinates(self):
        for coord in ([91,120],[22,181],[True,120],[22,float('nan')],[22], '22,120'):
            with self.subTest(coord=coord):
                c=case();c['coordinates']=coord
                self.assertTrue(validate([c],villages())[0])

    def test_stable_id_preservation(self):
        c=case(); before=copy.deepcopy(c); c['id']='renamed-road'
        self.assertTrue(validate([c],villages(),[before])[0])

    def test_search_has_head_and_location(self):
        text=search_text(case(),village_lookup(villages()))
        self.assertIn('測試甲里長',text)
        self.assertIn('測試路565巷',text)
        self.assertIn('第一路口',text)

    def test_privacy_detects_nested_private_payloads(self):
        for value in ({'notes_private':'synthetic'}, {'text':'09'+'12345678'}, {'text':'A'+'123456789'}, {'text':'https://'+'drive.google.com/file/d/synthetic'}, {'text':'住戶王小明住在測試路1號'}):
            self.assertTrue(privacy_issues(value))

    def test_public_engineering_and_head_names_allowed(self):
        self.assertFalse(privacy_issues({'locationName':'測試路1巷','currentHead':'測試里長'}))

    def test_internal_notes_not_rendered(self):
        c=case();c.update(notes_private='SYNTHETIC_PRIVATE_SENTINEL',verification={'attribution':'SYNTHETIC_PRIVATE_SENTINEL'})
        text=facts_html(c,village_lookup(villages()))+search_text(c,village_lookup(villages()))
        self.assertNotIn('SYNTHETIC_PRIVATE_SENTINEL',text)

    def test_build_does_not_generate_pending_page(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            for name in ['scripts','templates','data','assets']:
                (root/name).mkdir()
            for name in ['build_cases.py','achievement_metadata.py','validate_achievements.py']:
                shutil.copy(ROOT/'scripts'/name,root/'scripts'/name)
            shutil.copy(ROOT/'templates/case-page.html',root/'templates/case-page.html')
            for name in ['styles.css','map.css','map.js','digital.css','digital.js']:
                shutil.copy(ROOT/name,root/name)
            (root/'sitemap.xml').write_text('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://www.huiwen.tw/about.html</loc></url><url><loc>https://www.huiwen.tw/achievement-test-pending.html</loc></url></urlset>')
            c=case(); pending=copy.deepcopy(c);pending.update(id='test-pending',status='待核驗')
            (root/'data/achievements.json').write_text(json.dumps([c,pending],ensure_ascii=False))
            (root/'data/villages.json').write_text(json.dumps(villages(),ensure_ascii=False))
            (root/'assets/fengshan-villages.geojson').write_text('{"features": []}')
            (root/'achievement-test-pending.html').write_text('stale page')
            subprocess.run([sys.executable,str(root/'scripts/build_cases.py')],check=True,capture_output=True)
            self.assertFalse((root/'achievement-test-pending.html').exists())
            self.assertTrue((root/'achievement-test-road.html').is_file())
            self.assertIn('測試甲里長',(root/'achievements.html').read_text())
            self.assertNotIn('test-pending',(root/'achievements.html').read_text())
            sitemap=(root/'sitemap.xml').read_text()
            self.assertIn('about.html',sitemap)
            self.assertIn('achievement-test-road.html',sitemap)
            self.assertNotIn('achievement-test-pending.html',sitemap)
            subprocess.run([sys.executable,str(root/'scripts/build_cases.py')],check=True,capture_output=True)
            self.assertEqual(sitemap,(root/'sitemap.xml').read_text())


class AuditTests(unittest.TestCase):
    def test_normalization(self):
        pairs=[('高雄市鳳山區五甲二路５６５ 巷','五甲二路565巷'),('臺灣830高雄市鳳山區測試路五百六十五巷','測試路565巷'),('甲路 × 乙街','乙街與甲路'),('測試路一二三號','測試路123號')]
        for a,b in pairs:
            self.assertEqual(normalize_location(a),normalize_location(b))

    def test_exact_id(self):
        report=compare([candidate(achievement_id='test-road')],[case()])
        self.assertEqual(report['results'][0]['coverage_status'],'existing')

    def test_stable_mapping(self):
        hits,level,_=Matcher([case()],{'test-candidate':'test-road'}).match(candidate())
        self.assertEqual((hits,level),(['test-road'],'stable_mapping'))

    def test_location_match_requires_identity_review(self):
        c=case();c['locationName']='高雄市鳳山區五甲二路565巷'
        report=compare([candidate(normalized_location='五甲二路５６５巷')],[c])
        self.assertEqual(report['results'][0]['match_level'],'normalized_location')
        self.assertEqual(report['results'][0]['coverage_status'],'possible_duplicate')

    def test_different_lane_is_not_a_match(self):
        c=case();c['locationName']='五甲二路565巷'
        hits,_,_=Matcher([c]).match(candidate(normalized_location='五甲二路529巷'))
        self.assertEqual(hits,[])

    def test_unknown_explicit_id_never_falls_back(self):
        report=compare([candidate(achievement_id='unknown',normalized_location='測試路565巷')],[case()])
        self.assertEqual(report['results'][0]['coverage_status'],'conflict')

    def test_mapping_conflict(self):
        report=compare([candidate(achievement_id='test-road')],[case()],{'test-candidate':'other'})
        self.assertEqual(report['results'][0]['coverage_status'],'conflict')

    def test_pending_is_not_published(self):
        c=case();c['status']='待核驗'
        report=compare([candidate(achievement_id=c['id'])],[c])
        self.assertEqual(report['summary']['published_achievements'],0)
        self.assertEqual(report['results'][0]['coverage_status'],'insufficient_evidence')

    def test_no_private_fields_in_output(self):
        c=candidate(achievement_id='test-road',notes_private='PRIVATE_SENTINEL',original_case_id='PRIVATE_CASE',source_file='PRIVATE_PATH',candidate_title='PRIVATE_TITLE',body_draft='PRIVATE_BODY')
        report=json.dumps(compare([c],[case()]))
        for private in ['PRIVATE_SENTINEL','PRIVATE_CASE','PRIVATE_PATH','PRIVATE_TITLE','PRIVATE_BODY']:
            self.assertNotIn(private,report)

    def test_coverage_excludes_private_and_unverified(self):
        a=candidate(achievement_id='test-road');a['publicability']='publishable'
        b=candidate();b.update(candidate_id='private',publicability='private_only')
        d=candidate();d['candidate_id']='unverified'
        report=compare([a,b,d],[case()])
        self.assertEqual(report['summary']['publishable_candidates'],1)
        self.assertEqual(report['summary']['coverage'],1)
        self.assertIsNone(compare([d],[case()])['summary']['coverage'])

    def test_needs_update(self):
        c=candidate(achievement_id='test-road',latest_date='2026-09-13')
        self.assertEqual(compare([c],[case()])['results'][0]['coverage_status'],'needs_update')

    def test_verified_missing_requires_sources_and_attribution(self):
        c=candidate(official_sources='https://test.gov.tw/works/1',attribution_status='direct')
        c.update(publicability='publishable',verification_status='verified')
        self.assertEqual(compare([c],[case()])['results'][0]['coverage_status'],'missing')
        c['attribution_status']='unclear'
        self.assertEqual(compare([c],[case()])['results'][0]['coverage_status'],'insufficient_evidence')

    def test_facet_matching_with_date(self):
        c=candidate(district='測試區',villages='測試甲里',categories='交通與基建',first_date='2026-08-01',latest_date='2026-08-02')
        self.assertEqual(Matcher([case()]).match(c)[1],'village_category_date')

    def test_xlsx_reader_no_optional_dependency(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'registry.xlsx'
            values=['candidate_id','publicability','verification_status']
            def xmlrow(n,values):
                return '<row>'+''.join(f'<c r="{chr(65+i)}{n}" t="inlineStr"><is><t>{v}</t></is></c>' for i,v in enumerate(values))+'</row>'
            with zipfile.ZipFile(p,'w') as z:
                z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="候選總表" r:id="s1"/></sheets></workbook>')
                z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="s1" Target="worksheets/sheet1.xml"/></Relationships>')
                z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+xmlrow(1,values)+xmlrow(2,['test','needs_verification','pending'])+'</sheetData></worksheet>')
            self.assertEqual(read_candidates(p)[0]['candidate_id'],'test')

    def test_xlsx_typed_dates_both_epochs(self):
        for epoch_flag, serial in [('0', '46277'), ('1', '44815')]:
            with tempfile.TemporaryDirectory() as d:
                p=Path(d)/'registry.xlsx'
                with zipfile.ZipFile(p,'w') as z:
                    z.writestr('xl/workbook.xml',f'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="{epoch_flag}"/><sheets><sheet name="候選總表" r:id="s1"/></sheets></workbook>')
                    z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="s1" Target="worksheets/sheet1.xml"/></Relationships>')
                    z.writestr('xl/worksheets/sheet1.xml',f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1" t="inlineStr"><is><t>latest_date</t></is></c></row><row><c r="A2"><v>{serial}</v></c></row></sheetData></worksheet>')
                from audit_achievement_coverage import xlsx_rows
                self.assertEqual(xlsx_rows(p,'候選總表')[0]['latest_date'],'2026-09-12')


if __name__=='__main__':
    unittest.main()
