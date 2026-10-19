"""Offline contract test for the inactive A07 weekly-workflow candidate."""
import contextlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

from scripts import audit_external_links


ROOT = Path(__file__).resolve().parents[1]
CANDIDATE = ROOT / 'docs/maintenance-candidates/a07-weekly-link-report.yml.example'
REFERENCE = ROOT / '.github/workflows/content-freshness.yml'


def load_yaml(path):
    return yaml.load(path.read_text(encoding='utf-8'), Loader=yaml.BaseLoader)


def named_step(steps, name):
    return next(step for step in steps if step.get('name') == name)


def inline_python(run):
    match = re.fullmatch(r"python - <<'PY'\n(.*?)\nPY\n?", run, re.DOTALL)
    if not match:
        raise AssertionError('expected a single inline Python block')
    return match.group(1)


def current_sha():
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


class WeeklyCandidateContractTests(unittest.TestCase):
    def setUp(self):
        self.public_urls = {
            f'https://public.example/{index:03d}': {'nested/public.html' if index == 0 else 'data/public.json'}
            for index in range(62)
        }
        self.source_sha = current_sha()
        self.artifact_receipt = {
            'sourceCommit': self.source_sha,
            'publicArtifactDigest': 'b' * 64,
            'publicFileCount': 600,
            'publicRecordCount': 429,
            'provider': 'cloudflare-static-assets',
        }

    def execute_summary(self, script, report_path, summary_path, saved_summary):
        environment = {
            'REPORT_PATH': str(report_path),
            'PUBLIC_ARTIFACT_PATH': '/tmp/public-artifact-fixture',
            'SOURCE_SHA': self.source_sha,
            'SUMMARY_ARTIFACT_PATH': str(saved_summary),
            'GITHUB_STEP_SUMMARY': str(summary_path),
        }
        with patch.dict(os.environ, environment, clear=False), \
                patch.object(audit_external_links, 'inventory_public_artifact',
                             return_value=(self.public_urls, self.artifact_receipt)) as inventory:
            scope = {'__name__': '__main__'}
            exec(compile(script, 'candidate-summary-fixture', 'exec'), scope)
        inventory.assert_called_once_with(Path(environment['PUBLIC_ARTIFACT_PATH']), self.source_sha)

    def test_contract_and_mock_timeout_keep_public_partial_receipt(self):
        config = load_yaml(CANDIDATE)
        reference = load_yaml(REFERENCE)
        self.assertIsInstance(config, dict)
        self.assertEqual(set(config['on']), {'workflow_dispatch', 'schedule'})
        self.assertEqual(config['on']['schedule'], [{'cron': '30 20 * * 0'}])
        self.assertEqual(config['permissions'], {'contents': 'read'})

        job = config['jobs']['report']
        self.assertEqual(job['runs-on'], 'ubuntu-latest')
        self.assertEqual(int(job['timeout-minutes']), 25)
        steps = job['steps']
        reference_steps = reference['jobs']['review']['steps']
        for action in ('actions/checkout@', 'actions/setup-python@', 'actions/upload-artifact@'):
            expected = next(step['uses'] for step in reference_steps if step.get('uses', '').startswith(action))
            actual = next(step['uses'] for step in steps if step.get('uses', '').startswith(action))
            self.assertEqual(actual, expected)
        self.assertEqual(steps[0]['with']['persist-credentials'].lower(), 'false')
        self.assertEqual(named_step(steps, 'Set up Python')['with']['python-version'], '3.12')
        dependencies = shlex.split(named_step(steps, 'Install pinned public-packager and report dependencies')['run'])
        self.assertEqual(dependencies[:5], [
            'python', '-m', 'pip', 'install', '--disable-pip-version-check',
        ])
        self.assertEqual(set(dependencies[5:]), {
            'beautifulsoup4==4.13.5', 'html5lib==1.1', 'fonttools[woff]==4.66.1',
            'brotli==1.2.0', 'zopfli==0.4.3', 'PyYAML==6.0.3',
        })
        self.assertIn('test_a07_weekly_candidate_contract.py',
                      named_step(steps, 'Validate the inactive candidate contract with local fixtures')['run'])

        build_step = named_step(steps, 'Build the exact public artifact once')
        self.assertIn('scripts/build_public.py', build_step['run'])
        self.assertIn('$RUNNER_TEMP/a07-public-artifact', build_step['run'])
        self.assertNotIn('build_all.py', build_step['run'])
        self.assertNotIn('quality.py', build_step['run'])
        receipt_step = named_step(steps, 'Attach the canonical source and artifact receipt without rebuilding')
        self.assertIn('--wrap-existing-artifact', receipt_step['run'])
        self.assertIn('--source-commit "$GITHUB_SHA"', receipt_step['run'])
        self.assertLess(steps.index(build_step), steps.index(receipt_step))

        report_step = named_step(steps, 'Create bounded report from manifest-listed public HTML and JSON')
        report_command = shlex.split(report_step['run'])
        self.assertEqual(report_command[:6], [
            'timeout', '--signal=TERM', '--kill-after=10s', '900s',
            'python3', 'scripts/audit_external_links.py',
        ])
        self.assertIn('--public-artifact', report_command)
        self.assertIn('$RUNNER_TEMP/a07-public-artifact', report_command)
        self.assertEqual(report_command[report_command.index('--source-sha') + 1], '$GITHUB_SHA')
        self.assertEqual(report_command[report_command.index('--timeout') + 1], '8')
        self.assertEqual(report_command[report_command.index('--attempts') + 1], '2')
        self.assertEqual(report_command[report_command.index('--interval') + 1], '0.5')

        summary_step = named_step(steps, 'Summarize and validate report')
        artifact_step = named_step(steps, 'Preserve report and summary for 30 days')
        self.assertEqual(summary_step['if'], 'always()')
        self.assertEqual(artifact_step['if'], 'always()')
        self.assertIn('external-links.json', artifact_step['with']['path'])
        self.assertIn('external-link-summary.md', artifact_step['with']['path'])
        self.assertEqual(int(artifact_step['with']['retention-days']), 30)
        self.assertEqual(artifact_step['with']['if-no-files-found'], 'warn')
        all_run_text = '\n'.join(step.get('run', '') for step in steps).lower()
        for forbidden in ('gh issue', 'notify', 'owner', 'assignee', '${{ secrets.'):
            self.assertNotIn(forbidden, all_run_text)
        self.assertNotIn('audit_external_links.inventory(', all_run_text)

        attempt_count = int(report_command[report_command.index('--attempts') + 1])
        timeout_seconds = float(report_command[report_command.index('--timeout') + 1])
        interval_seconds = float(report_command[report_command.index('--interval') + 1])
        deadline_seconds = 900
        kill_after_seconds = 10
        # Two 8-second attempts, the retry pause, and the inter-URL pause.
        worst_case_seconds = len(self.public_urls) * (
            attempt_count * timeout_seconds + interval_seconds + interval_seconds
        )
        self.assertGreater(worst_case_seconds, deadline_seconds)
        self.assertGreaterEqual(int(job['timeout-minutes']) * 60,
                                deadline_seconds + kill_after_seconds + 180)

        # Replace only the command executables in PATH. No HTTP probe is run.
        with tempfile.TemporaryDirectory() as temporary:
            temp = Path(temporary)
            bin_dir = temp / 'bin'
            bin_dir.mkdir()
            first_url, second_url = list(self.public_urls)[:2]
            mock_rows = [
                {'url': first_url, 'fingerprint': audit_external_links.url_fingerprint(first_url),
                 'files': sorted(self.public_urls[first_url]), 'status': 'PASS'},
                {'url': second_url, 'fingerprint': audit_external_links.url_fingerprint(second_url),
                 'files': sorted(self.public_urls[second_url]), 'status': 'BLOCKED'},
            ]
            mock_python = bin_dir / 'python3'
            mock_python.write_text(
                f'''#!{sys.executable}
import json
import os
import time
from pathlib import Path
Path('external-links.json').write_text(json.dumps({{
    'reportVersion': 1,
    'state': 'running',
    'checkedAt': '2026-10-19T00:00:00+00:00',
    'probeMode': 'public_artifact_http_get',
    'publicArtifact': json.loads(os.environ['MOCK_ARTIFACT_RECEIPT']),
    'links': json.loads(os.environ['MOCK_LINKS']),
}}), encoding='utf-8')
time.sleep(30)
''',
                encoding='utf-8',
            )
            mock_python.chmod(0o755)
            timeout_shim = bin_dir / 'timeout'
            timeout_shim.write_text(
                f'''#!{sys.executable}
import subprocess
import sys
import time
from pathlib import Path
args = sys.argv[1:]
if args[:3] != ['--signal=TERM', '--kill-after=10s', '900s']:
    raise SystemExit(97)
command = args[3:]
if '--public-artifact' not in command or '--source-sha' not in command:
    raise SystemExit(96)
child = subprocess.Popen(command)
deadline = time.monotonic() + 5
while time.monotonic() < deadline and not Path('external-links.json').exists():
    time.sleep(0.01)
if not Path('external-links.json').exists():
    child.kill()
    child.wait()
    raise SystemExit(98)
child.terminate()
try:
    child.wait(timeout=1)
except subprocess.TimeoutExpired:
    child.kill()
    child.wait()
raise SystemExit(124)
''',
                encoding='utf-8',
            )
            timeout_shim.chmod(0o755)
            test_env = os.environ.copy()
            test_env.update({
                'PATH': str(bin_dir) + os.pathsep + test_env.get('PATH', ''),
                'GITHUB_SHA': self.source_sha,
                'RUNNER_TEMP': str(temp / 'runner-temp'),
                'MOCK_ARTIFACT_RECEIPT': json.dumps(self.artifact_receipt),
                'MOCK_LINKS': json.dumps(mock_rows),
            })
            timed_out = subprocess.run(
                ['/bin/bash', '-e', '-o', 'pipefail', '-c', report_step['run']],
                cwd=temp,
                env=test_env,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(timed_out.returncode, 124, timed_out.stderr)
            partial_path = temp / 'external-links.json'
            partial = json.loads(partial_path.read_text(encoding='utf-8'))
            self.assertEqual(partial['state'], 'running')
            self.assertEqual([row['status'] for row in partial['links']], ['PASS', 'BLOCKED'])

            summary_path = temp / 'step-summary.md'
            saved_summary = temp / 'external-link-summary.md'
            summary_script = inline_python(summary_step['run'])
            self.execute_summary(summary_script, partial_path, summary_path, saved_summary)
            summary = summary_path.read_text(encoding='utf-8')
            self.assertEqual(summary, saved_summary.read_text(encoding='utf-8'))
            self.assertIn('running', summary)
            self.assertIn(self.source_sha, summary)
            self.assertIn(self.artifact_receipt['publicArtifactDigest'], summary)
            self.assertIn(f'公開 artifact 外連總數：{len(self.public_urls)}', summary)
            self.assertIn(f'已記錄結果：2/{len(self.public_urls)}', summary)
            self.assertIn('PASS：1', summary)
            self.assertIn('BLOCKED：1', summary)
            self.assertIn('部分報告', summary)

            partial['links'] = []
            partial_path.write_text(json.dumps(partial), encoding='utf-8')
            self.execute_summary(summary_script, partial_path, summary_path, saved_summary)
            no_results = summary_path.read_text(encoding='utf-8')
            self.assertIn('未探測的連結不計為 PASS', no_results)
            self.assertIn('PASS：0', no_results)


if __name__ == '__main__':
    unittest.main()
