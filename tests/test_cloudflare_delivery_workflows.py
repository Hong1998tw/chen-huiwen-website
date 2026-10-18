"""Pure contract checks for bounded exact-source Cloudflare workflows."""
import re
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = (
    ROOT / '.github/workflows/cloudflare-public.yml',
    ROOT / '.github/workflows/cloudflare-preview.yml',
)


class CloudflareDeliveryWorkflowContractTests(unittest.TestCase):
    def test_both_waiters_have_explicit_budget_and_job_timeout(self):
        for path in WORKFLOWS:
            with self.subTest(workflow=path.name):
                text = path.read_text()
                waiter_lines = [
                    line for line in text.splitlines()
                    if 'python scripts/verify_cloudflare_delivery.py' in line
                ]
                self.assertEqual(len(waiter_lines), 1)
                waiter = waiter_lines[0]
                self.assertRegex(waiter, r'--attempts\s+420(?:\s|$)')
                self.assertRegex(waiter, r'--delay\s+5(?:\s|$)')
                self.assertNotIn('--expected-sha', waiter)
                self.assertEqual(
                    re.findall(r'(?m)^    timeout-minutes:\s*(\d+)\s*$', text),
                    ['45'],
                )
                self.assertNotIn('continue-on-error:', text)

    def test_shared_verifier_keeps_exact_source_and_byte_digest_gates(self):
        verifier = (ROOT / 'scripts/verify_cloudflare_delivery.py').read_text()
        self.assertIn(
            "expected = args.expected_sha or subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()",
            verifier,
        )
        self.assertIn(
            "digest = hashlib.sha256(Path(args.artifact).read_bytes()).hexdigest()",
            verifier,
        )
        self.assertIn("value.get('sourceCommit') == expected_sha", verifier)
        self.assertIn("value.get('publicArtifactDigest') == artifact_digest", verifier)
        self.assertIn("return 0 if result['status']=='PASS' else 1", verifier)


if __name__ == '__main__':
    unittest.main()
