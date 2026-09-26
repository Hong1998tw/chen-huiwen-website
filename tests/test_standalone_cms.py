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

class StandaloneCMS(unittest.TestCase):
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

if __name__=='__main__':unittest.main()
