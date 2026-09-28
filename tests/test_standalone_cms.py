import json
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import publish_from_cms as cms
import publish_from_notion as engine
from page_copy import digest as page_digest, render as render_page_copy, render_with_manifest
from case_media import classify as classify_media, render as render_media

class StandaloneCMS(unittest.TestCase):
    def test_retryable_publish_errors_return_to_queue(self):
        receipt = {"id": "release-id", "lease": "lease-id"}
        retry = cms.receipt_for_publish_error(receipt, engine.PublishError("STALE_CHECKOUT", retryable=True))
        self.assertEqual(retry["status"], "queued")
        self.assertIn("下一輪", retry["message"])
        stop = cms.receipt_for_publish_error(receipt, engine.PublishError("VALIDATION"))
        self.assertEqual(stop["status"], "failed")

    def test_stale_structured_case_uses_current_main_only_after_case_candidate_validation(self):
        old_sha, live_sha = "a" * 40, "b" * 40
        item = {
            "id": "release-id", "path": "achievement-fixture.html", "version": 2,
            "base_commit": old_sha, "operation": "publish",
            "payload": json.dumps({"fields": {}, "case": {"title": "編輯後"}, "caseBase": {"title": "原始值"}}),
        }
        seen = {}

        def validated_candidate(current_item, *_args):
            seen.update(current_item)
            return engine.Candidate("achievement-content", current_item["id"], current_item["path"], {},
                                    current_item["base_commit"], "updated", True, "preview", "sha256:" + "c" * 64)

        with patch.object(cms, "catalog", return_value=[{"path": item["path"], "kind": "generated"}]), \
             patch.object(cms.engine, "run", return_value=SimpleNamespace(stdout=live_sha)), \
             patch.object(cms, "page_text", return_value=json.dumps({"schemaVersion": 1, "pages": {}})), \
             patch.object(cms, "case_candidate", side_effect=validated_candidate):
            candidate = cms.page_candidate(item, root=ROOT)

        self.assertEqual(candidate.base_hash, live_sha)
        self.assertEqual(seen["base_commit"], live_sha)
        self.assertEqual(item["base_commit"], old_sha, "the stored publication snapshot remains immutable")

    def test_stale_unstructured_page_does_not_loop_in_the_publication_queue(self):
        item = {
            "id": "release-id", "path": "service.html", "version": 1,
            "base_commit": "a" * 40, "operation": "publish", "payload": json.dumps({"fields": {}}),
        }
        with patch.object(cms, "catalog", return_value=[{"path": item["path"], "kind": "generated"}]), \
             patch.object(cms.engine, "run", return_value=SimpleNamespace(stdout="b" * 40)):
            with self.assertRaises(engine.PublishError) as raised:
                cms.page_candidate(item, root=ROOT)
        self.assertEqual(raised.exception.code, "BASE_DRIFT")
        self.assertFalse(raised.exception.retryable)
        self.assertIn("草稿已保留", raised.exception.plain())

    def test_empty_optional_case_history_is_not_shown_as_placeholder(self):
        html=(ROOT/'achievement-changle-hexing-youbike.html').read_text()
        self.assertNotIn('本專題尚未收錄具日期的推動歷程',html)
        self.assertIn('case-sources',html)

    def test_media_provider_rendering_and_private_host_rejection(self):
        self.assertEqual(classify_media('https://drive.google.com/file/d/1234567890abcdef/view','photo')[0],'drive')
        self.assertEqual(classify_media('https://www.facebook.com/example/posts/123','photo')[0],'facebook')
        self.assertIsNone(classify_media('https://127.0.0.1/private.jpg','photo'))
        html=render_media({'kind':'photo','url':'https://example.com/photo.jpg','alt':'現場照片',
                           'caption':'公開現場','credit':'拍攝者'})
        self.assertIn('<img',html)
        self.assertIn('width="1200" height="900"',html)
        self.assertIn('開啟原始內容',html)
    def test_visual_copy_manifest_is_stable_without_public_html_markers(self):
        source = '<!doctype html><html><head></head><body><main><section><p>Original &amp; text</p></section></main></body></html>'
        marked, count, manifest = render_with_manifest(source, 'fixture.html')
        self.assertEqual(count, 1)
        field_id = 'main>section:nth-of-type(1)>p:nth-of-type(1)'
        self.assertEqual(manifest, [{'id': field_id, 'sourceHash': page_digest('Original & text'), 'valueHash': page_digest('Original & text')}])
        self.assertNotIn('data-cms-edit-id', marked)
        self.assertIn('data-cms-editor-loader', marked)
        fields = {field_id: {'sourceHash': page_digest('Original & text'), 'value': 'Updated <script>alert(1)</script>'}}
        edited, _, edited_manifest = render_with_manifest(marked, 'fixture.html', fields)
        self.assertIn('Updated &lt;script&gt;alert(1)&lt;/script&gt;', edited)
        self.assertNotIn('<script>alert(1)</script>', edited)
        self.assertNotIn('data-cms-edit-id', edited)
        self.assertEqual(edited_manifest[0]['valueHash'], page_digest('Updated <script>alert(1)</script>'))
        self.assertEqual(render_page_copy(edited, 'fixture.html')[0], edited)

    def test_visual_copy_source_drift_fails_closed(self):
        source = '<html><head></head><body><main><p>Original text</p></main></body></html>'
        marked, _ = render_page_copy(source, 'fixture.html')
        field_id = 'main>p:nth-of-type(1)'
        fields = {field_id: {'sourceHash': page_digest('Original text'), 'value': 'Edited text'}}
        changed = marked.replace('Original text', 'Changed at source')
        with self.assertRaisesRegex(ValueError, 'source changed'):
            render_page_copy(changed, 'fixture.html', fields)

    def test_editor_runtime_loads_only_in_admin_iframe(self):
        source = '<html><head><script src="/cms-page-editor.js" defer></script></head><body><main><p>Copy</p></main></body></html>'
        marked, count = render_page_copy(source, 'fixture.html')
        self.assertEqual(count, 1)
        self.assertIn('data-cms-editor-loader', marked)
        self.assertIn("new URLSearchParams(location.search).get('cmsEdit')==='1'", marked)
        self.assertIn('window.self!==window.top', marked)
        self.assertIn("</scr'+'ipt>", marked)
        self.assertNotIn('<script src="/cms-page-editor.js" defer></script>', marked)
        self.assertNotIn('data-cms-edit-id', marked)
        self.assertEqual(render_page_copy(marked, 'fixture.html')[0], marked)

    def test_editor_manifest_retains_original_hash_from_legacy_instrumentation(self):
        source = f'<html><head></head><body><main><p data-cms-edit-id="main&gt;p:nth-of-type(1)" data-cms-source-hash="{"a" * 64}" data-cms-value-hash="{page_digest("Copy")}">Copy</p></main></body></html>'
        clean, _, fields = render_with_manifest(source, 'fixture.html')
        self.assertNotIn('data-cms-source-hash', clean)
        self.assertEqual(fields[0]['sourceHash'], 'a' * 64)

    def test_api_diagnostics_never_include_remote_secrets(self):
        error=urllib.error.HTTPError('https://example.test/?credential=private','401','private response',{},None)
        with patch('urllib.request.urlopen',side_effect=error):
            with self.assertRaises(cms.RunnerError) as caught:
                cms.fetch_json(object(),'CMS /internal/sync',30)
        self.assertEqual(str(caught.exception),'CMS /internal/sync: HTTP 401')
        error=urllib.error.HTTPError('https://example.test/?credential=private',403,'private response',{'cf-mitigated':'challenge'},None)
        with patch('urllib.request.urlopen',side_effect=error):
            with self.assertRaises(cms.RunnerError) as caught:
                cms.fetch_json(object(),'CMS /internal/sync',30)
        self.assertEqual(str(caught.exception),'CMS /internal/sync: HTTP 403 (edge challenge)')

    def test_sync_and_noop_preserve_canonical_bytes(self):
        for source in cms.sources(ROOT):
            text=(ROOT/engine.DATA_FILES[source['domain']]).read_text()
            item={**source,'document_id':source['id'],'base_hash':source['hash'],'payload':json.dumps(source['payload'])}
            candidate=cms.prepare(item,text)
            self.assertFalse(candidate.changed)
            self.assertEqual(candidate.new_text,text)

    def test_stale_base_never_overwrites_site(self):
        for source in cms.sources(ROOT):
            item={**source,'document_id':source['id'],'base_hash':'sha256:stale','payload':json.dumps(source['payload'])}
            with self.assertRaises(engine.PublishError) as caught:
                cms.prepare(item,(ROOT/engine.DATA_FILES[source['domain']]).read_text())
            self.assertEqual(caught.exception.code,'BASE_DRIFT')

    def test_new_event_has_no_synced_record_claim(self):
        source=next(s for s in cms.sources(ROOT) if s['domain']=='events')
        item={**source,'document_id':'d1c0a000-0000-4000-8000-000000000001','record_key':'event-new-cms-record','base_hash':'absent','payload':json.dumps(source['payload'])}
        candidate=cms.prepare(item,(ROOT/engine.DATA_FILES['events']).read_text())
        self.assertTrue(candidate.changed)
        self.assertEqual(json.loads(candidate.new_text)['events'][-1]['id'],'event-new-cms-record')

    def test_unknown_fields_preserved_by_existing_publisher(self):
        source=next(s for s in cms.sources(ROOT) if s['domain']=='events')
        text=(ROOT/engine.DATA_FILES['events']).read_text()
        data=json.loads(text);data['events'][0]['sourceGovernance']={'keep':True}
        source['hash']=engine.sha(data['events'][0]);source['payload']['name']+='（調整）'
        item={**source,'document_id':source['id'],'base_hash':source['hash'],'payload':json.dumps(source['payload'])}
        candidate=cms.prepare(item,engine.dump_events(data))
        self.assertEqual(json.loads(candidate.new_text)['events'][0]['sourceGovernance'],{'keep':True})

    def test_page_unpublish_is_a_versioned_reversible_source_change(self):
        commit=engine.run(['git','rev-parse','HEAD'],ROOT).stdout.strip()
        item={'id':'00000000-0000-4000-8000-000000000001','path':'activity-market.html',
              'operation':'unpublish','base_commit':commit,'version':1,'payload':json.dumps({'fields':{}})}
        candidate=cms.page_candidate(item)
        state=json.loads(candidate.new_text)
        self.assertEqual(state['pages']['activity-market.html']['status'],'unpublished')
        self.assertRegex(state['pages']['activity-market.html']['lastmod'],r'^20\d\d-\d\d-\d\d$')

    def test_case_draft_updates_canonical_dates_sources_and_optional_sections(self):
        commit=engine.run(['git','rev-parse','HEAD'],ROOT).stdout.strip()
        source=next(c for c in json.loads((ROOT/'data/achievements.json').read_text()) if c['id']=='changle-hexing-youbike')
        fields={key:source.get(key, [] if key=='media' else {} if key=='imageMetadata' else None) for key in cms.CASE_FIELDS}
        baseline=json.loads(json.dumps(fields))
        item={'id':'00000000-0000-4000-8000-000000000002','path':'achievement-changle-hexing-youbike.html',
              'operation':'publish','base_commit':commit,'version':1,'payload':json.dumps({'fields':{},'case':fields,'caseBase':baseline})}
        self.assertFalse(cms.page_candidate(item).changed)
        fields['history']=[{'date':'2026-09-24','title':'公開進度','text':'依公開文件持續核對'}]
        fields['updated']='2026-09-25'
        fields['sources'][0]['sourceDate']='2026-09-24'
        fields['media']=[{'kind':'photo','url':'https://drive.google.com/file/d/1234567890abcdef/view',
                          'alt':'現場照片','caption':'公開現場紀錄','credit':'陳慧文服務處','publicAccessConfirmed':True}]
        item['payload']=json.dumps({'fields':{},'case':fields,'caseBase':baseline})
        candidate=cms.page_candidate(item)
        self.assertTrue(candidate.changed)
        self.assertEqual(candidate.domain,'achievement-content')
        revised=next(c for c in json.loads(candidate.new_text) if c['id']==source['id'])
        self.assertEqual(revised['history'][0]['date'],'2026-09-24')
        self.assertEqual(revised['sources'][0]['sourceDate'],'2026-09-24')
        self.assertEqual(revised['media'][0]['kind'],'photo')
        stale=json.loads(json.dumps(baseline)); stale['updated']='2025-01-01'
        item['payload']=json.dumps({'fields':{},'case':fields,'caseBase':stale})
        with self.assertRaises(engine.PublishError) as error:
            cms.page_candidate(item)
        self.assertEqual(error.exception.code,'BASE_DRIFT')
        item['payload']=json.dumps({'fields':{},'case':fields,'caseBase':baseline})
        item['operation']='unpublish'
        self.assertEqual(cms.page_candidate(item).domain,'page-copy')

    def test_home_story_order_changes_canonical_source_and_rejects_drift(self):
        commit=engine.run(['git','rev-parse','HEAD'],ROOT).stdout.strip()
        baseline=json.loads((ROOT/'data/civic-home.json').read_text(encoding='utf-8'))
        edited=json.loads(json.dumps(baseline))
        order=[edited['featured'],*edited['reading']]
        edited['featured'],edited['reading']=order[1], [order[0],*order[2:]]
        item={'id':'00000000-0000-4000-8000-000000000009','path':'index.html',
              'operation':'publish','base_commit':commit,'version':1,
              'payload':json.dumps({'fields':{},'home':edited,'homeBase':baseline})}
        candidate=cms.page_candidate(item)
        self.assertEqual(candidate.domain,'home-content')
        self.assertTrue(candidate.changed)
        self.assertEqual(json.loads(candidate.new_text)['featured'],order[1])
        self.assertEqual(json.loads(candidate.new_text)['reading'][0],order[0])
        self.assertEqual(engine.http_check('home-content','index.html','publish',fetch=lambda _: (200,'<html>ok</html>')),'PASS')
        public=json.loads((ROOT/'data/achievements.json').read_text(encoding='utf-8'))
        replacement=next(row['id'] for row in public if cms.is_public(row) and row['id'] not in order)
        removed=order[-1] if len(order)>2 else order[0]
        edited['reading'].append(replacement)
        edited['summaries'][replacement]='新增公開專題的摘要'
        edited['reading'].remove(removed); del edited['summaries'][removed]
        item['payload']=json.dumps({'fields':{},'home':edited,'homeBase':baseline})
        selected=cms.page_candidate(item)
        self.assertIn(replacement,json.loads(selected.new_text)['reading'])
        self.assertNotIn(removed,json.loads(selected.new_text)['reading'])
        item['payload']=json.dumps({'fields':{'main>p:nth-of-type(1)':{'sourceHash':'a'*64,'value':'尚未發布的文字'}},'home':edited,'homeBase':baseline})
        with self.assertRaises(engine.PublishError) as error:
            cms.page_candidate(item)
        self.assertEqual(error.exception.code,'VALIDATION')
        stale=json.loads(json.dumps(baseline)); stale['summaries'][order[0]]+=' 已更新'
        item['payload']=json.dumps({'fields':{},'home':edited,'homeBase':stale})
        with self.assertRaises(engine.PublishError) as error:
            cms.page_candidate(item)
        self.assertEqual(error.exception.code,'BASE_DRIFT')
        duplicate=edited['reading'][0]
        item['payload']=json.dumps({'fields':{},'home':{**edited,'reading':[duplicate,duplicate]},'homeBase':baseline})
        with self.assertRaises(engine.PublishError) as error:
            cms.page_candidate(item)
        self.assertEqual(error.exception.code,'VALIDATION')

    def test_case_order_changes_preserve_existing_photos_and_check_source_drift(self):
        commit=engine.run(['git','rev-parse','HEAD'],ROOT).stdout.strip()
        source=next(c for c in json.loads((ROOT/'data/achievements.json').read_text()) if c['id']=='metro-green-line')
        fields={key:source.get(key, [] if key=='media' else {} if key=='imageMetadata' else None) for key in cms.CASE_FIELDS}
        fields['images']=list(source['images'])
        fields['sectionOrder']=list(cms.DEFAULT_SECTION_ORDER)
        baseline=json.loads(json.dumps(fields))
        item={'id':'00000000-0000-4000-8000-000000000003','path':'achievement-metro-green-line.html',
              'operation':'publish','base_commit':commit,'version':1,'payload':json.dumps({'fields':{},'case':fields,'caseBase':baseline})}
        self.assertFalse(cms.page_candidate(item).changed)
        fields['images'].reverse()
        fields['sectionOrder']=['sources','overview','history','media']
        item['payload']=json.dumps({'fields':{},'case':fields,'caseBase':baseline})
        candidate=cms.page_candidate(item)
        revised=next(c for c in json.loads(candidate.new_text) if c['id']==source['id'])
        self.assertEqual(revised['images'],list(reversed(source['images'])))
        self.assertEqual(revised['sectionOrder'],fields['sectionOrder'])
        fields['images']=source['images'][:1]
        item['payload']=json.dumps({'fields':{},'case':fields,'caseBase':baseline})
        with self.assertRaises(engine.PublishError) as error:
            cms.page_candidate(item)
        self.assertEqual(error.exception.code,'VALIDATION')
        fields['images']=list(source['images'])
        stale=json.loads(json.dumps(baseline)); stale['images'].reverse()
        item['payload']=json.dumps({'fields':{},'case':fields,'caseBase':stale})
        with self.assertRaises(engine.PublishError) as error:
            cms.page_candidate(item)
        self.assertEqual(error.exception.code,'BASE_DRIFT')

if __name__=='__main__':unittest.main()
