"""Read-only edge diagnostics preserve provider-specific verification contracts."""
import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import check_cloudflare_edge as edge


class EdgeCacheTests(unittest.TestCase):
    def run_check(self, html='HIT', bypass='DYNAMIC', refill=None, flags=None,
                  html_status=200, bypass_status=200):
        calls = []
        public_reads = 0

        def fetch(url):
            nonlocal public_reads
            calls.append(url)
            status, cache = 200, 'HIT'
            if url == 'https://huiwen.tw/':
                status, cache = 301, None
            elif url == 'https://www.huiwen.tw/':
                public_reads += 1
                status = html_status
                cache = html if public_reads == 1 else refill
            elif 'production-verification=' in url:
                status, cache = bypass_status, bypass
            return edge.Check(url, status, None, 'cloudflare', None, cache, None)

        output = io.StringIO()
        with patch.object(sys, 'argv', ['check_cloudflare_edge.py', *(flags or [])]), \
                patch.object(edge, 'fetch', side_effect=fetch), contextlib.redirect_stdout(output):
            result = edge.main()
        return result, calls, output.getvalue()

    def test_cold_or_expired_html_can_refill_once_at_the_same_url(self):
        for first in ('MISS', 'EXPIRED'):
            for second in ('HIT', 'REVALIDATED', 'UPDATING', 'STALE'):
                with self.subTest(first=first, second=second):
                    result, calls, output = self.run_check(first, refill=second, flags=['--expect-html-cache'])
                    self.assertEqual(result, 0)
                    self.assertEqual(calls.count('https://www.huiwen.tw/'), 2)
                    self.assertEqual(calls[-1], 'https://www.huiwen.tw/')
                    self.assertIn(f'{first} -> {second}', output)

    def test_persistent_refill_or_uncacheable_html_still_fails(self):
        for second in ('MISS', 'EXPIRED', 'DYNAMIC', 'BYPASS', None):
            with self.subTest(second=second):
                result, calls, _ = self.run_check('MISS', refill=second, flags=['--expect-html-cache'])
                self.assertEqual(result, 2)
                self.assertEqual(calls.count('https://www.huiwen.tw/'), 2)

    def test_only_refill_states_are_retried_in_verification_mode(self):
        for initial, expected in [('HIT', 0), ('REVALIDATED', 0), ('UPDATING', 0),
                                  ('STALE', 0), ('DYNAMIC', 2), ('BYPASS', 2), (None, 2)]:
            with self.subTest(initial=initial):
                result, calls, _ = self.run_check(initial, flags=['--expect-html-cache'])
                self.assertEqual(result, expected)
                self.assertEqual(calls.count('https://www.huiwen.tw/'), 1)
        result, calls, _ = self.run_check('MISS')
        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 4)

    def test_legacy_bypass_guard_remains_strict_after_warmup(self):
        for bypass in ('HIT', 'REVALIDATED', 'UPDATING', 'STALE'):
            with self.subTest(bypass=bypass):
                result, calls, _ = self.run_check('EXPIRED', bypass, 'HIT', ['--expect-html-cache'])
                self.assertEqual(result, 3)
                self.assertEqual(sum('production-verification=' in url for url in calls), 1)

    def test_http_errors_cannot_pass_cached_or_bypass_checks(self):
        result, _, _ = self.run_check(flags=['--expect-html-cache'], html_status=403)
        self.assertEqual(result, 2)
        result, _, _ = self.run_check(flags=['--expect-html-cache'], bypass_status=503)
        self.assertEqual(result, 3)

    def test_static_asset_hit_requires_exact_release_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / 'publication-manifest.json'
            artifact.write_bytes(b'{"files":[]}\n')
            flags = ['--expect-static-assets', '--expected-sha', 'a' * 40, '--artifact', str(artifact)]
            for status, expected in [('PASS', 0), ('FAIL', 4), ('BLOCKED', 4)]:
                with self.subTest(status=status), patch.object(edge, 'verify_delivery', return_value={'status': status}) as verify:
                    result, _, _ = self.run_check(bypass='HIT', flags=flags)
                    self.assertEqual(result, expected)
                    args, kwargs = verify.call_args
                    self.assertEqual(args[0], 'a' * 40)
                    self.assertEqual(args[1], '72094c8b2dcf0bfb4f1d7ef1e19f4be87352e3165051f0a9f28b3169215a5896')
                    self.assertEqual(args[2], 'https://www.huiwen.tw/')
                    self.assertEqual(kwargs, {'attempts': 1, 'delay': 0})

    def test_static_assets_without_artifact_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            result, _, _ = self.run_check(bypass='HIT', flags=[
                '--expect-static-assets', '--expected-sha', 'a' * 40,
                '--artifact', str(Path(directory) / 'missing.json')])
            self.assertEqual(result, 4)

    def test_static_mode_requires_explicit_sha_and_cannot_disable_legacy_guard(self):
        for flags in (['--expect-static-assets'], ['--expect-static-assets', '--expect-html-cache']):
            with self.subTest(flags=flags), patch.object(sys, 'argv', ['check_cloudflare_edge.py', *flags]), \
                    patch.object(edge, 'fetch') as fetch, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    edge.main()
                self.assertEqual(error.exception.code, 2)
                fetch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
