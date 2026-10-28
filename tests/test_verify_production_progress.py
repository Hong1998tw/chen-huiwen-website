"""Offline regression: slow/failing checks must leave usable evidence mid-run."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(os.environ.get('VERIFIER_TEST_ROOT', Path(__file__).resolve().parents[1]))
VERIFIER = Path(os.environ.get('VERIFIER_TEST_MODULE', ROOT / 'scripts/verify_production.py'))
spec = importlib.util.spec_from_file_location('progress_candidate', VERIFIER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.ROOT = ROOT


class ProductionProgressTests(unittest.TestCase):
    def fixture(self, root, font_names=()):
        html = b'<html lang="zh-Hant-TW"><head><title>Test</title><meta name="description" content="public"></head><body>Public test text.</body></html>'
        payloads = {'index.html': html, **{name: b'font-fixture' for name in font_names}}
        for name, payload in payloads.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
        fonts = {name: {'sha256': hashlib.sha256(payloads[name]).hexdigest()} for name in font_names}
        contract = {'publication': {'files': {name: hashlib.sha256(body).hexdigest() for name, body in payloads.items()}},
                    'fonts': fonts, 'fontRoutes': ['index.html'], 'routes': {'index.html': {}}}
        api = types.SimpleNamespace(validate_artifact_contract=lambda *_: contract,
                                    validate_font_bytes=lambda *_: None,
                                    validate_route_html=lambda *_: None)
        return payloads, api

    def patches(self, root, report, api, fetch, *, attempts=1):
        stack = contextlib.ExitStack()
        stack.enter_context(patch.dict(sys.modules, {'page_font_contract': api}))
        stack.enter_context(patch.object(module, 'CORE_PAGES', ('index.html',)))
        stack.enter_context(patch.object(module, 'STATIC_FILES', ()))
        stack.enter_context(patch.object(module, 'fetch', fetch))
        stack.enter_context(patch.object(sys, 'argv', ['verify_production.py', '--artifact-root', str(root),
                                                    '--report', str(report), '--attempts', str(attempts), '--delay', '0']))
        return stack

    def test_slow_check_report_exists_before_fetch_returns_and_failure_stays_nonzero(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); report = root / 'report.json'
            _, api = self.fixture(root)
            entered, release = threading.Event(), threading.Event()
            def fetch(*_):
                entered.set()
                if not release.wait(3):
                    raise AssertionError('test release missing')
                raise TimeoutError('private@example.org 0912-345-678')
            output, codes = io.StringIO(), []
            with self.patches(root, report, api, fetch), contextlib.redirect_stdout(output):
                worker = threading.Thread(target=lambda: codes.append(module.main()))
                worker.start()
                try:
                    self.assertTrue(entered.wait(2))
                    pending = json.loads(report.read_text())
                    self.assertEqual(pending['status'], 'PENDING')
                    self.assertFalse(pending['complete'])
                    self.assertEqual(pending['activeChecks'][0]['path'], 'index.html')
                    self.assertEqual(pending['phases']['local_contract']['state'], 'completed')
                finally:
                    release.set(); worker.join(5)
                self.assertFalse(worker.is_alive())
            self.assertEqual(codes, [1])
            final = json.loads(report.read_text())
            self.assertEqual(final['status'], 'Failed')
            self.assertIn('index.html', json.loads((root / 'report.progress.json').read_text())['failedPaths'])
            self.assertEqual(json.loads((root / 'report.attempt-001.json').read_text())['status'], 'Failed')
            self.assertNotIn('private@example.org', output.getvalue())
            self.assertNotIn('0912-345-678', output.getvalue())

    def test_fast_font_failure_is_persisted_while_ordered_first_font_is_still_slow(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); report = root / 'report.json'
            slow, bad = 'assets/a.woff2', 'assets/b.woff2'
            payloads, api = self.fixture(root, (slow, bad))
            entered, release = threading.Event(), threading.Event()
            def fetch(_base, path, _cache, _timeout):
                local_path = 'index.html' if path == '/' else path.lstrip('/')
                if local_path == slow:
                    entered.set()
                    if not release.wait(3): raise AssertionError('test release missing')
                return 200, 'https://www.huiwen.tw/' + local_path, payloads[local_path]
            def validate(path, *_):
                if path == bad: raise ValueError('bad font private@example.org 0912-345-678')
            api.validate_font_bytes = validate
            output, codes = io.StringIO(), []
            with self.patches(root, report, api, fetch), contextlib.redirect_stdout(output):
                worker = threading.Thread(target=lambda: codes.append(module.main()))
                worker.start()
                try:
                    self.assertTrue(entered.wait(2))
                    deadline = time.monotonic() + 2
                    partial = {}
                    while time.monotonic() < deadline:
                        partial = json.loads(report.read_text())
                        if bad in partial.get('failedPaths', []): break
                        time.sleep(.01)
                    self.assertEqual(partial['status'], 'FAILED_PARTIAL')
                    self.assertIn(bad, partial['failedPaths'])
                    self.assertIn(slow, [row['path'] for row in partial['activeChecks']])
                    self.assertGreaterEqual(partial['completedFontChecks'], 1)
                finally:
                    release.set(); worker.join(5)
                self.assertFalse(worker.is_alive())
            self.assertEqual(codes, [1])
            final = json.loads(report.read_text())
            self.assertEqual(len(final['fontAssets']), 2)
            self.assertEqual(len(final['fontRoutes']), 1)
            self.assertNotIn('private@example.org', output.getvalue())
            self.assertNotIn('0912-345-678', report.read_text())

    def test_sigterm_saves_partial_and_restores_handler_without_pass(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); report = root / 'report.json'
            _, api = self.fixture(root)
            old = signal.getsignal(signal.SIGTERM)
            def fetch(*_):
                os.kill(os.getpid(), signal.SIGTERM)
                raise AssertionError('signal handler must interrupt')
            with self.patches(root, report, api, fetch), contextlib.redirect_stdout(io.StringIO()):
                code = module.main()
            partial = json.loads(report.read_text())
            self.assertEqual(code, 143)
            self.assertTrue(partial['interrupted'])
            self.assertFalse(partial['complete'])
            self.assertIn(partial['status'], {'PENDING', 'FAILED_PARTIAL'})
            self.assertIn('index.html', [r['path'] for r in partial['interruptedDuring']])
            self.assertEqual(signal.getsignal(signal.SIGTERM), old)

    def test_retry_keeps_earlier_failure_receipt_and_final_pass_requires_full_attempt(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); report = root / 'report.json'
            payloads, api = self.fixture(root)
            calls = []
            def fetch(_base, path, cache, timeout):
                calls.append((path, cache, timeout))
                if cache.endswith('-1'): raise TimeoutError()
                return 200, 'https://www.huiwen.tw/', payloads['index.html']
            with self.patches(root, report, api, fetch, attempts=2), contextlib.redirect_stdout(io.StringIO()):
                code = module.main()
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(report.read_text())['status'], 'Passed')
            self.assertEqual(json.loads((root/'report.attempt-001.json').read_text())['status'], 'Failed')
            self.assertEqual(json.loads((root/'report.attempt-002.json').read_text())['status'], 'Passed')
            progress = json.loads((root/'report.progress.json').read_text())
            self.assertTrue(progress['complete'])
            self.assertEqual([r['status'] for r in progress['attemptHistory']], ['Failed', 'Passed'])
            self.assertEqual(len(calls), 4)  # core + font-route on each attempt; no checks skipped
            self.assertTrue(all(timeout == 20 for _, _, timeout in calls))


    def test_checkpoint_rate_limit_keeps_stdout_and_failure_bypasses_interval(self):
        from urllib.error import HTTPError
        clock = [0.0]
        output = io.StringIO()
        with patch.object(module.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(module.VerificationProgress, '_start_checkpoint_clock'), \
                patch.object(module.VerificationProgress, '_write') as write, \
                contextlib.redirect_stdout(output):
            progress = module.VerificationProgress(Path('/tmp/not-written-by-mocked-writer.json'))
            progress.start_attempt(1); progress.start_phase('core_static', 102)
            initial = write.call_count
            for n in range(100):
                with progress.check('core_static', f'page-{n}.html'):
                    pass
            # Only the phase's first active path checkpoints; stdout retains 200 events.
            self.assertEqual(write.call_count - initial, 2)
            self.assertEqual(output.getvalue().count('"event": "check-start"'), 100)
            self.assertEqual(output.getvalue().count('"event": "check-end"'), 100)
            clock[0] = .2
            prior = write.call_count
            progress.fetch_failure('core_static', 'failed.html', HTTPError('https://example.test/', 403, 'secret', {}, None))
            self.assertEqual(write.call_count - prior, 2)
            self.assertEqual(write.call_args.args[1]['status'], 'FAILED_PARTIAL')
            self.assertEqual(write.call_args.args[1]['failureDetails'][0]['http'], 403)
            clock[0] = .8
            prior = write.call_count
            with progress.check('core_static', 'ordinary.html'):
                pass
            self.assertEqual(write.call_count, prior)
            clock[0] = 1.21
            with progress.check('core_static', 'next.html'):
                pass
            self.assertEqual(write.call_count - prior, 2)
            # A new phase's first active path also flushes before a slow call.
            progress.start_phase('next_phase', 1)
            prior = write.call_count
            with progress.check('next_phase', 'slow.html'):
                self.assertEqual(write.call_count - prior, 2)
            progress.stop_checkpoint.set()

    def test_http_code_progress_privacy_and_annotations_are_run_limited(self):
        from urllib.error import HTTPError
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); report = root/'report.json'
            _, api = self.fixture(root)
            def fetch(*_):
                raise HTTPError('https://www.huiwen.tw/?private@example.org', 403,
                                'arbitrary reason private@example.org 0912-345-678', {}, io.BytesIO(b'PRIVATE_BODY'))
            output = io.StringIO()
            with self.patches(root, report, api, fetch), patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}), \
                    contextlib.redirect_stdout(output):
                code = module.main()
            self.assertEqual(code, 1)
            progress = json.loads((root/'report.progress.json').read_text())
            self.assertTrue(any(d['errorType']=='HTTPError' and d.get('http')==403 for d in progress['failureDetails']))
            self.assertNotIn('arbitrary reason', json.dumps(progress))
            self.assertNotIn('private@example.org', json.dumps(progress))
            self.assertNotIn('PRIVATE_BODY', json.dumps(progress))
            warnings = [line for line in output.getvalue().splitlines() if line.startswith('::warning')]
            self.assertEqual(len(warnings), 1)  # Same source path fails in two phases.
            self.assertIn('HTTPError HTTP 403', warnings[0])
            self.assertNotIn('private@example.org', warnings[0])
        output = io.StringIO()
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}), contextlib.redirect_stdout(output):
            progress = module.VerificationProgress()
            progress.start_attempt(1)
            for n in range(15):
                progress.fetch_failure('core_static', f'page-{n}.html', HTTPError('https://example.test/', 404, 'secret', {}, None))
            progress.start_attempt(2)
            progress.fetch_failure('core_static', 'page-0.html', HTTPError('https://example.test/', 403, 'secret', {}, None))
        self.assertEqual(sum(line.startswith('::warning') for line in output.getvalue().splitlines()), 10)
        output = io.StringIO()
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}), contextlib.redirect_stdout(output):
            module.VerificationProgress().fetch_failure('core_static', 'index.html', TimeoutError('secret'))
        self.assertNotIn('::warning', output.getvalue())

    def test_checkpoint_clock_refreshes_blocked_path_without_new_events(self):
        with tempfile.TemporaryDirectory() as name, contextlib.redirect_stdout(io.StringIO()):
            path = Path(name)/'report.json'; progress = module.VerificationProgress(path)
            try:
                progress.start_attempt(1); progress.start_phase('core_static', 1)
                with progress.check('core_static', 'slow.html'):
                    initial = json.loads(path.read_text())['elapsedSeconds']
                    deadline = time.monotonic() + 2
                    current = {}
                    while time.monotonic() < deadline:
                        current = json.loads(path.read_text())
                        if current['elapsedSeconds'] - initial >= .9:
                            break
                        time.sleep(.02)
                    self.assertGreaterEqual(current['elapsedSeconds'] - initial, .9)
                    self.assertEqual(current['status'], 'PENDING')
                    self.assertFalse(current['complete'])
                    self.assertEqual(current['activeChecks'][0]['path'], 'slow.html')
            finally:
                progress.stop_checkpoint.set()


if __name__ == '__main__':
    unittest.main()
