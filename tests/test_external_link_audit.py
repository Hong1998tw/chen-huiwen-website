"""Offline tests for the bounded external-link audit report."""
import json
import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from scripts import audit_external_links as audit

ROOT = Path(__file__).resolve().parents[1]


class FingerprintAndInventoryTests(unittest.TestCase):
    def test_canonical_url_deduplicates_fragment_host_case_and_default_port(self):
        left = audit.canonical_url('HTTPS://Example.COM:443/source#section-a')
        right = audit.canonical_url('https://example.com/source#section-b')
        self.assertEqual(left, 'https://example.com/source')
        self.assertEqual(left, right)
        self.assertEqual(audit.url_fingerprint(left), audit.url_fingerprint(right))

    def test_query_values_are_not_collapsed_and_credentials_are_not_probed(self):
        first = audit.canonical_url('https://example.com/item?id=1')
        second = audit.canonical_url('https://example.com/item?id=2')
        self.assertNotEqual(audit.url_fingerprint(first), audit.url_fingerprint(second))
        self.assertIsNone(audit.canonical_url('https://user:pass@example.com/private'))

    def test_inventory_merges_same_url_sources_without_network_access(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            (root / 'one.html').write_text(
                '<a href="https://Example.com:443/a#one">one</a>', encoding='utf-8'
            )
            (root / 'two.html').write_text(
                '<iframe src="https://example.com/a#two"></iframe>', encoding='utf-8'
            )
            (root / 'data' / 'refs.json').write_text(
                json.dumps({'sourceUrl': 'https://example.com/a#json'}), encoding='utf-8'
            )
            self.assertEqual(
                audit.inventory(root),
                {'https://example.com/a': {'one.html', 'two.html', 'data/refs.json'}},
            )


class ReportPersistenceTests(unittest.TestCase):
    url = 'https://example.com/source'
    inventory = {url: {'fixture.html'}}

    def run_with_first_probe_interrupted(self, output_exists):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as directory:
            output = Path(directory) / 'external-links.json'
            if output_exists:
                output.write_text(json.dumps({
                    'reportVersion': 1, 'state': 'complete', 'checkedAt': 'stale',
                    'finishedAt': 'stale', 'summary': {'PASS': 1}, 'links': [],
                }), encoding='utf-8')
            with patch.object(sys, 'argv', ['audit_external_links.py', str(output)]), \
                    patch.object(audit, 'inventory', return_value=self.inventory), \
                    patch.object(audit, 'probe', side_effect=KeyboardInterrupt) as probe, \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(KeyboardInterrupt):
                    audit.main()
            probe.assert_called_once_with(self.url, {'fixture.html'}, 10, 2, 0.5)
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(report['state'], 'running')
            self.assertEqual(report['links'], [])
            self.assertNotIn('finishedAt', report)
            self.assertNotIn('summary', report)
            self.assertNotEqual(report['checkedAt'], 'stale')

    def test_old_complete_report_is_replaced_before_first_probe(self):
        self.run_with_first_probe_interrupted(output_exists=True)

    def test_missing_output_gets_running_report_before_first_probe(self):
        self.run_with_first_probe_interrupted(output_exists=False)

    def test_failed_initial_report_write_prevents_probe(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as directory:
            output = Path(directory) / 'external-links.json'
            with patch.object(sys, 'argv', ['audit_external_links.py', str(output)]), \
                    patch.object(audit, 'inventory', return_value=self.inventory), \
                    patch.object(audit, '_write_report', side_effect=OSError('fixture write failure')) as write, \
                    patch.object(audit, 'probe') as probe, \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(OSError):
                    audit.main()
            write.assert_called_once()
            probe.assert_not_called()

    def test_later_probe_interrupt_keeps_partial_report_running(self):
        first_result = {
            'url': self.url, 'fingerprint': audit.url_fingerprint(self.url),
            'files': ['fixture.html'], 'status': 'PASS', 'httpStatus': 200,
            'final_url': self.url, 'reason': 'reachable_not_fact_verified',
            'retryClass': 'not_retryable', 'attempts': [],
        }
        urls = {
            'https://example.com/one': {'one.html'},
            'https://example.com/two': {'two.html'},
        }
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as directory:
            output = Path(directory) / 'external-links.json'
            with patch.object(sys, 'argv', ['audit_external_links.py', str(output)]), \
                    patch.object(audit, 'inventory', return_value=urls), \
                    patch.object(audit, 'probe', side_effect=[first_result, KeyboardInterrupt]), \
                    patch.object(audit.time, 'sleep'), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(KeyboardInterrupt):
                    audit.main()
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(report['state'], 'running')
            self.assertEqual(report['links'], [first_result])
            self.assertNotIn('finishedAt', report)
            self.assertNotIn('summary', report)

    def test_successful_run_marks_report_complete(self):
        result = {
            'url': self.url, 'fingerprint': audit.url_fingerprint(self.url),
            'files': ['fixture.html'], 'status': 'PASS', 'httpStatus': 200,
            'final_url': self.url, 'reason': 'reachable_not_fact_verified',
            'retryClass': 'not_retryable', 'attempts': [],
        }
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as directory:
            output = Path(directory) / 'external-links.json'
            with patch.object(sys, 'argv', ['audit_external_links.py', str(output)]), \
                    patch.object(audit, 'inventory', return_value=self.inventory), \
                    patch.object(audit, 'probe', return_value=result), \
                    patch.object(audit.time, 'sleep'), \
                    contextlib.redirect_stdout(io.StringIO()):
                audit.main()
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(report['state'], 'complete')
            self.assertEqual(report['links'], [result])
            self.assertEqual(report['summary'], {'PASS': 1})
            self.assertIn('finishedAt', report)


class ClassificationAndRetryTests(unittest.TestCase):
    def test_only_not_found_responses_are_fail(self):
        self.assertEqual(audit.classify(404), ('FAIL', 'not_found'))
        self.assertEqual(audit.classify(410), ('FAIL', 'not_found'))
        for code, reason in ((401, 'authentication'), (403, 'access_denied'), (429, 'rate_limited')):
            self.assertEqual(audit.classify(code), ('BLOCKED', reason))
        self.assertEqual(audit.classify(None, 'network_error'), ('BLOCKED', 'network_error'))
        self.assertEqual(audit.classify(503), ('BLOCKED', 'server_error'))
        self.assertEqual(audit.classify(None, 'tls_error'), ('BLOCKED', 'tls_error'))
        self.assertFalse(audit.retryable(None, 'tls_error'))
        self.assertTrue(audit.retryable(408, None))

    def test_cli_rejects_unbounded_timeout_before_inventory(self):
        with patch.object(sys, 'argv', ['audit_external_links.py', 'unused.json', '--timeout', '31']), \
                patch.object(audit, 'inventory') as inventory, \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                audit.main()
        self.assertEqual(raised.exception.code, 2)
        inventory.assert_not_called()

    def test_403_429_and_auth_are_not_retried(self):
        for code in (401, 403, 407, 429):
            with self.subTest(code=code):
                error = HTTPError('https://example.com/', code, 'fixture', {}, None)
                with patch.object(audit, 'urlopen', side_effect=error) as open_url:
                    result = audit.probe('https://example.com/', [], 1, 2, 0.25)
                self.assertEqual(open_url.call_count, 1)
                self.assertEqual(result['status'], 'BLOCKED')
                self.assertFalse(result['attempts'][0]['retry_scheduled'])

    def test_transient_503_retries_once_and_unknown_stays_blocked(self):
        class Response:
            status = 204
            url = 'https://example.com/'
            def __enter__(self): return self
            def __exit__(self, *args): return False

        temporary = HTTPError('https://example.com/', 503, 'fixture', {}, None)
        with patch.object(audit, 'urlopen', side_effect=[temporary, Response()]) as open_url, \
                patch.object(audit.time, 'sleep') as sleep:
            result = audit.probe('https://example.com/', [], 1, 2, 0.25)
        self.assertEqual(open_url.call_count, 2)
        sleep.assert_called_once_with(0.25)
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['retryClass'], 'recovered_after_retry')
        self.assertTrue(result['attempts'][0]['retry_scheduled'])

        missing = HTTPError('https://example.com/', 404, 'fixture', {}, None)
        with patch.object(audit, 'urlopen', side_effect=[temporary, missing]):
            result = audit.probe('https://example.com/', [], 1, 2, 0.25)
        self.assertEqual(result['status'], 'FAIL')
        self.assertEqual(result['retryClass'], 'terminal_not_found_after_retry')

        with patch.object(audit, 'urlopen', side_effect=OSError('fixture transport failure')):
            result = audit.probe('https://example.com/', [], 1, 2, 0.25)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['reason'], 'network_error')
        self.assertEqual(result['retryClass'], 'bounded_retry_exhausted')


if __name__ == '__main__':
    unittest.main()
