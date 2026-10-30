"""The publisher's candidate preflight versus the full quality gate kept by the required CI."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import candidate_preflight as preflight  # noqa: E402
import publish_from_notion as P  # noqa: E402

quality = preflight.quality
UNIT_SUITES = (
    [sys.executable, '-u', '-m', 'unittest', 'discover', '-v', '-s', 'tests', '-p', 'test_*.py'],
    [sys.executable, '-u', '-m', 'unittest', 'discover', '-v', '-s', 'tests/events'],
)


def commands(entry, root, env):
    calls = []
    with mock.patch.object(quality, 'run', side_effect=lambda _root, args, label=None: calls.append(list(args))), \
            mock.patch.dict(os.environ, env), redirect_stdout(StringIO()):
        status = entry(root)
    return status, calls


class StageContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def full(self, root):
        with mock.patch.object(sys, 'argv', ['quality.py', '--root', str(root), '--baseline-ref', 'BASE']):
            return quality.main()

    def candidate(self, root):
        return preflight.main(['--root', str(root), '--baseline-ref', 'BASE'])

    def test_preflight_runs_every_quality_stage_except_the_clean_tree_suites(self):
        full_status, full = commands(self.full, self.root, {'WORKERS_CI': ''})
        status, calls = commands(self.candidate, self.root, {'WORKERS_CI': ''})
        self.assertEqual((full_status, status), (0, 0))
        # Default quality is unchanged: both unit suites still run after the shared stages.
        self.assertEqual(full[-2:], list(map(list, UNIT_SUITES)))
        self.assertEqual(calls, full[:-2])
        validators = [call[1] for call in calls if call[1].startswith('scripts/validate_')]
        self.assertEqual(validators, ['scripts/' + name for name in quality.VALIDATORS])
        self.assertIn([sys.executable, 'scripts/validate_achievements.py', '--baseline-ref', 'BASE'], calls)
        self.assertEqual(sum(call[1:] == ['scripts/build_all.py'] for call in calls), 2, 'stale check and determinism rebuild')
        self.assertEqual(calls[-1], [sys.executable, 'scripts/build_public.py', '--check'])

    def test_preflight_ignores_the_workers_shortcut_and_requires_a_base(self):
        _, calls = commands(self.candidate, self.root, {'WORKERS_CI': '1'})
        self.assertEqual(sum(call[1:] == ['scripts/build_all.py'] for call in calls), 2)
        with mock.patch('sys.stderr'), self.assertRaises(SystemExit):
            preflight.main(['--root', str(self.root)])

    def test_failures_are_reported_and_never_marked_as_a_full_pass(self):
        failure = subprocess.CalledProcessError(1, ['scripts/validate_site.py'])
        with mock.patch.object(quality, 'run', side_effect=failure), mock.patch('sys.stderr'):
            self.assertEqual(preflight.main(['--root', str(self.root), '--baseline-ref', 'BASE']), 1)
        text = (ROOT / 'scripts/candidate_preflight.py').read_text(encoding='utf-8')
        self.assertIn('PASS: candidate preflight only', text)
        self.assertNotIn('PASS: deterministic quality', text)

    def test_required_ci_keeps_the_full_quality_gate(self):
        workflow = (ROOT / '.github/workflows/validate-source.yml').read_text(encoding='utf-8')
        self.assertIn('python scripts/quality.py --baseline-ref "$BASE_SHA"', workflow)
        self.assertNotIn('candidate_preflight', workflow)
        self.assertNotIn('candidate', (ROOT / 'scripts/quality.py').read_text(encoding='utf-8'))
        self.assertIn('validate', P.REQUIRED_CHECKS)

    def test_publisher_runs_the_preflight_against_the_worktree_base(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            candidate = P._deployment_control_candidate('a' * 32, '2026-10-01T12:00:00+08:00', root)
            with mock.patch.object(P, 'run') as run, \
                    mock.patch.object(P, 'changed_files', return_value=['data/deployment-request.json']):
                P.materialize(candidate, root)
            run.assert_called_once_with([sys.executable, 'scripts/candidate_preflight.py', '--baseline-ref', 'HEAD'], root)
            with mock.patch.object(P, 'run') as run, \
                    mock.patch.object(P, 'changed_files', return_value=['data/deployment-request.json']):
                P.materialize(candidate, root, quality=False)
            run.assert_not_called()


class DirtyCandidateRejectionTests(unittest.TestCase):
    """Real CLI on an uncommitted candidate in a disposable repository."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        scripts = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', 'scripts'],
                                          cwd=ROOT, text=True).splitlines()
        for name in [*scripts, 'data/achievements.json', 'data/villages.json']:
            dest = cls.root / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, dest)
        for args in (['init', '-q'], ['add', '.'],
                     ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'base']):
            subprocess.run(['git', *args], cwd=cls.root, check=True, stdout=subprocess.DEVNULL)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        subprocess.run(['git', 'restore', '.'], cwd=self.root, check=True)

    def reject(self, mutate, expected):
        path = self.root / 'data/achievements.json'
        rows = json.loads(path.read_text(encoding='utf-8'))
        mutate(rows)
        path.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')
        result = subprocess.run([sys.executable, 'scripts/candidate_preflight.py', '--baseline-ref', 'HEAD'],
                                cwd=self.root, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, result.stdout[-1000:])
        self.assertIn(expected, result.stdout + result.stderr)
        self.assertNotIn('PASS', result.stdout)

    def test_malformed_source_is_rejected(self):
        self.reject(lambda rows: rows[0].update(coordinates=[200, 300]), 'coordinate')

    def test_removed_stable_id_is_rejected_against_the_worktree_base(self):
        self.reject(lambda rows: rows.pop(0), 'ID')


if __name__ == '__main__':
    unittest.main()
