"""Contract checks for bounded browser verification of the built public artifact."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / '.github/workflows/cloudflare-public-qa.yml'


class CloudflarePublicQaWorkflowTests(unittest.TestCase):
    def test_static_asset_job_builds_and_checks_the_artifact_in_a_real_browser(self):
        text = WORKFLOW.read_text(encoding='utf-8')
        job = text.split('  static-assets:', 1)[1]
        self.assertRegex(job, r'(?m)^    timeout-minutes:\s*15\s*$')
        self.assertIn('npm ci --ignore-scripts --prefix tests/donation', job)
        self.assertIn('bash scripts/install_playwright_ci.sh', job)
        self.assertIn('python scripts/build_cloudflare_public.py', job)
        self.assertIn('wrangler@4.143.1 dev --local --config wrangler.public.jsonc --port 8789', job)
        self.assertIn('node tests/donation/service-worker-artifact-browser.mjs', job)
        self.assertIn('node --test tests/donation/service-worker-cache-policy.test.mjs', job)
        self.assertNotIn('production-browser.mjs', job)
        self.assertIn('tests/donation/results/cloudflare-assets/', job)


if __name__ == '__main__':
    unittest.main()
