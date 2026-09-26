import json
import sys
import unittest
from unittest.mock import patch
import urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import publish_from_cms as cms
import publish_from_notion as engine
from page_copy import digest as page_digest, render as render_page_copy

class StandaloneCMS(unittest.TestCase):
    def test_visual_copy_markers_are_stable_and_text_is_escaped(self):
        source = '<!doctype html><html><head></head><body><main><section><p>Original &amp; text</p></section></main></body></html>'
        marked, count = render_page_copy(source, 'fixture.html')
        self.assertEqual(count, 1)
        self.assertIn('data-cms-edit-id="main&gt;section:nth-of-type(1)&gt;p:nth-of-type(1)"', marked)
        field_id = 'main>section:nth-of-type(1)>p:nth-of-type(1)'
        fields = {field_id: {'sourceHash': page_digest('Original & text'), 'value': 'Updated <script>alert(1)</script>'}}
        edited, _ = render_page_copy(marked, 'fixture.html', fields)
        self.assertIn('Updated &lt;script&gt;alert(1)&lt;/script&gt;', edited)
        self.assertNotIn('<script>alert(1)</script>', edited)
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
        self.assertEqual(render_page_copy(marked, 'fixture.html')[0], marked)

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

if __name__=='__main__':unittest.main()
