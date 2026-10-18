"""The Cloudflare candidate never adds a request-time Worker or private data."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import build_cloudflare_public
from verify_cloudflare_delivery import check_receipt, verify
from unittest.mock import MagicMock, patch
from verify_cloudflare_assets import public_request, error_summary
from urllib.error import HTTPError

class StaticDeliveryTests(unittest.TestCase):
    def test_assets_only_configuration(self):
        config=json.loads((ROOT/'wrangler.public.jsonc').read_text())
        self.assertEqual(config['name'],'huiwen-website')
        self.assertEqual(config['routes'],[{'pattern':'www.huiwen.tw','custom_domain':True}])
        self.assertFalse(config['preview_urls'])
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
    def test_existing_artifact_receipt_uses_manifest_digest_without_rebuilding(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact=Path(directory)/'public'
            artifact.mkdir()
            page=b'<html><body>public fixture</body></html>'
            (artifact/'index.html').write_bytes(page)
            manifest={'version':1,'publicRecordCount':0,
                      'files':{'index.html':hashlib.sha256(page).hexdigest()}}
            encoded=(json.dumps(manifest,ensure_ascii=False,separators=(',',':'))+'\n').encode()
            publication=artifact/'publication-manifest.json'
            publication.write_bytes(encoded)
            sha='a'*40
            with patch.object(build_cloudflare_public.build_public,'build') as build:
                with patch.object(build_cloudflare_public,'validate_artifact_contract',return_value={}) as validate, \
                        patch.object(build_cloudflare_public,'page_font_namespace_records',return_value={}):
                    receipt=build_cloudflare_public.add_delivery_metadata(artifact,sha)
                    expected_headers=build_cloudflare_public.render_headers(artifact,manifest)
            build.assert_not_called()
            validate.assert_called_once_with(artifact.resolve(),build_cloudflare_public.ROOT.resolve())
            self.assertEqual(receipt['sourceCommit'],sha)
            self.assertEqual(receipt['publicArtifactDigest'],hashlib.sha256(encoded).hexdigest())
            self.assertEqual(receipt['publicFileCount'],1)
            self.assertEqual(json.loads((artifact/'deployment.json').read_text()),receipt)
            self.assertEqual((artifact/'_headers').read_text(),expected_headers)
    def test_asset_checks_use_one_explicit_automation_identity(self):
        for path in ['/', '/index.html', '/mktexp26/', '/data/case-context.json']:
            request = public_request('https://example.test' + path)
            self.assertEqual(request.get_header('User-agent'), 'huiwen-public-asset-verifier')
            self.assertEqual(request.get_header('Accept-encoding'), 'identity')
        error = HTTPError('https://example.test/', 403, 'Forbidden', {'Content-Type':'text/html'}, None)
        self.assertIn('HTTP 403', error_summary(error))
    def test_success_receipt_clears_earlier_not_found_status(self):
        sha='a'*40;digest='b'*64
        good={'schemaVersion':1,'provider':'cloudflare-static-assets','sourceCommit':sha,'publicArtifactDigest':digest}
        response=MagicMock()
        response.__enter__.return_value=response
        response.status=200
        response.read.return_value=json.dumps(good).encode()
        earlier=HTTPError('https://example.test/deployment.json',404,'Not Found',{},None)
        with patch('verify_cloudflare_delivery.urlopen',side_effect=[earlier,response]):
            result=verify(sha,digest,'https://example.test',attempts=2,delay=0)
        self.assertEqual(result['status'],'PASS')
        self.assertEqual(result['httpStatus'],200)
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
    def test_live_security_header_and_asset_check_follows_exact_receipt(self):
        text=(ROOT/'.github/workflows/cloudflare-public.yml').read_text()
        receipt=text.index('python scripts/verify_cloudflare_delivery.py')
        security=text.index('python scripts/verify_security_headers.py')
        self.assertGreater(security,receipt)
        self.assertIn('--artifact-root _site',text[security:])

if __name__=='__main__':
    unittest.main()
