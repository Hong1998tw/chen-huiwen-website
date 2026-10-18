"""Offline contract test for the inactive A07 weekly-workflow candidate."""
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

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


class WeeklyCandidateContractTests(unittest.TestCase):
    def test_workflow_contract_and_mock_timeout_preserve_partial_report(self):
        config = load_yaml(CANDIDATE)
        reference = load_yaml(REFERENCE)
        self.assertIsInstance(config, dict)
        self.assertEqual(set(config['on']), {'workflow_dispatch', 'schedule'})
        self.assertEqual(config['on']['schedule'], [{'cron': '30 20 * * 0'}])
        self.assertEqual(config['permissions'], {'contents': 'read'})

        job = config['jobs']['report']
        self.assertEqual(job['runs-on'], 'ubuntu-latest')
        self.assertEqual(int(job['timeout-minutes']), 20)
        steps = job['steps']
        reference_steps = reference['jobs']['review']['steps']
        for action in ('actions/checkout@', 'actions/setup-python@', 'actions/upload-artifact@'):
            expected = next(step['uses'] for step in reference_steps if step.get('uses', '').startswith(action))
            actual = next(step['uses'] for step in steps if step.get('uses', '').startswith(action))
            self.assertEqual(actual, expected)
        self.assertEqual(steps[0]['with']['persist-credentials'].lower(), 'false')
        self.assertEqual(named_step(steps, 'Set up Python')['with']['python-version'], '3.12')
        self.assertEqual(
            shlex.split(named_step(steps, 'Install report and contract-test dependencies')['run']),
            ['python', '-m', 'pip', 'install', '--disable-pip-version-check',
             'beautifulsoup4==4.13.5', 'PyYAML==6.0.3'],
        )
        self.assertIn('test_a07_weekly_candidate_contract.py',
                      named_step(steps, 'Validate the candidate workflow contract')['run'])

        report_step = named_step(steps, 'Create bounded external-link report')
        report_command = shlex.split(report_step['run'])
        self.assertEqual(report_command[:4],
                         ['timeout', '--signal=TERM', '--kill-after=10s', '900s'])
        self.assertEqual(report_command[4:6], ['python3', 'scripts/audit_external_links.py'])
        self.assertEqual(report_command[7:],
                         ['--timeout', '1', '--attempts', '2', '--interval', '0.5'])

        inventory_count = len(audit_external_links.inventory(ROOT))
        attempt_count = int(report_command[report_command.index('--attempts') + 1])
        timeout_seconds = float(report_command[report_command.index('--timeout') + 1])
        interval_seconds = float(report_command[report_command.index('--interval') + 1])
        deadline_seconds = 900
        kill_after_seconds = 10
        worst_case_seconds = inventory_count * (
            attempt_count * timeout_seconds + attempt_count * interval_seconds
        )  # Retry pauses plus the existing pause after each URL.
        self.assertLessEqual(worst_case_seconds + 60, deadline_seconds)
        self.assertGreaterEqual(int(job['timeout-minutes']) * 60,
                                deadline_seconds + kill_after_seconds + 180)

        summary_step = named_step(steps, 'Summarize report')
        artifact_step = named_step(steps, 'Preserve JSON report')
        self.assertEqual(summary_step['if'], 'always()')
        self.assertEqual(artifact_step['if'], 'always()')
        self.assertEqual(artifact_step['with']['path'], 'external-links.json')
        self.assertEqual(int(artifact_step['with']['retention-days']), 30)
        self.assertEqual(artifact_step['with']['if-no-files-found'], 'warn')
        all_run_text = '\n'.join(step.get('run', '') for step in steps).lower()
        for forbidden in ('gh issue', 'notify', 'owner', 'assignee', '${{ secrets.'):
            self.assertNotIn(forbidden, all_run_text)

        # Replace only the command executables in PATH. The report producer writes a
        # running JSON fixture and blocks; the timeout shim terminates it with 124.
        # No production probe or network request is invoked.
        with tempfile.TemporaryDirectory() as temporary:
            temp = Path(temporary)
            bin_dir = temp / 'bin'
            bin_dir.mkdir()
            mock_python = bin_dir / 'python3'
            mock_python.write_text(
                f'''#!{sys.executable}
import json
import time
from pathlib import Path
Path('external-links.json').write_text(json.dumps({{
    'reportVersion': 1,
    'state': 'running',
    'checkedAt': '2026-10-19T00:00:00+00:00',
    'links': [{{'status': 'PASS'}}, {{'status': 'BLOCKED'}}],
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
child = subprocess.Popen(args[3:])
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
            test_env['PATH'] = str(bin_dir) + os.pathsep + test_env.get('PATH', '')
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
            summary_env = os.environ.copy()
            summary_env.update({
                'REPORT_PATH': str(partial_path),
                'SOURCE_SHA': 'a' * 40,
                'GITHUB_STEP_SUMMARY': str(summary_path),
            })
            summary_result = subprocess.run(
                [sys.executable, '-c', inline_python(summary_step['run'])],
                cwd=ROOT,
                env=summary_env,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(summary_result.returncode, 0, summary_result.stderr)
            summary = summary_path.read_text(encoding='utf-8')
            self.assertIn('running', summary)
            self.assertIn('a' * 40, summary)
            self.assertIn(f'盤點連結總數：{inventory_count}', summary)
            self.assertIn(f'已記錄結果：2/{inventory_count}', summary)
            self.assertIn('PASS：1', summary)
            self.assertIn('BLOCKED：1', summary)
            self.assertIn('部分報告', summary)


if __name__ == '__main__':
    unittest.main()
