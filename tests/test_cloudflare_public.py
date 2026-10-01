"""The Cloudflare candidate never adds a request-time Worker or private data."""
import json
from pathlib import Path
import sys
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from verify_cloudflare_delivery import check_receipt

class StaticDeliveryTests(unittest.TestCase):
    def test_assets_only_configuration(self):
        config=json.loads((ROOT/'wrangler.public.jsonc').read_text())
        self.assertEqual(config['name'],'huiwen-website')
        self.assertNotIn('main',config)
        self.assertNotIn('triggers',config)
        self.assertNotIn('d1_databases',config)
        self.assertNotIn('cache_options',config)
        self.assertNotIn('run_worker_first',config['assets'])
        self.assertEqual(config['assets'],{'directory':'./_site','html_handling':'none','not_found_handling':'404-page'})
    def test_receipt_is_bound_to_provider_commit_and_artifact(self):
        sha='a'*40;digest='b'*64
        good={'schemaVersion':1,'provider':'cloudflare-static-assets','sourceCommit':sha,'publicArtifactDigest':digest}
        self.assertTrue(check_receipt(good,sha,digest))
        for key,value in [('provider','github-pages'),('sourceCommit','c'*40),('publicArtifactDigest','d'*64),('schemaVersion',2)]:
            self.assertFalse(check_receipt({**good,key:value},sha,digest))
        self.assertFalse(check_receipt(None,sha,digest))
    def test_pages_is_recovery_only(self):
        text=(ROOT/'.github/workflows/pages.yml').read_text()
        self.assertIn('workflow_dispatch:',text)
        self.assertNotIn('  push:',text)
        self.assertIn('path: _site',text)
    def test_production_verification_follows_exact_cloudflare_delivery(self):
        text=(ROOT/'.github/workflows/production-verification.yml').read_text()
        self.assertIn("workflows: ['Cloudflare public delivery verification']",text)
        for gate in ['steps.http.outcome','steps.all_pages.outcome','steps.browser.outcome','steps.native.outcome']:
            self.assertIn(gate,text)
        self.assertIn('github.event.workflow_run.head_sha',text)
    def test_delivery_bridge_is_read_only(self):
        text=(ROOT/'.github/workflows/cloudflare-public.yml').read_text()
        self.assertIn('contents: read',text)
        self.assertNotIn('secrets.',text)
        self.assertNotIn('wrangler deploy',text)

if __name__=='__main__':
    unittest.main()
