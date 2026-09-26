import json
import sys
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import publish_from_cms as cms
import publish_from_notion as engine

class StandaloneCMS(unittest.TestCase):
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

    def test_unknown_fields_preserved_by_existing_publisher(self):
        source=next(s for s in cms.sources(ROOT) if s['domain']=='events')
        text=(ROOT/engine.DATA_FILES['events']).read_text()
        data=json.loads(text);data['events'][0]['sourceGovernance']={'keep':True}
        source['hash']=engine.sha(data['events'][0]);source['payload']['name']+='（調整）'
        item={**source,'document_id':source['id'],'base_hash':source['hash'],'payload':json.dumps(source['payload'])}
        candidate=cms.prepare(item,engine.dump_events(data))
        self.assertEqual(json.loads(candidate.new_text)['events'][0]['sourceGovernance'],{'keep':True})

if __name__=='__main__':unittest.main()
