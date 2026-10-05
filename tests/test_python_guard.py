"""Every script that writes repository artifacts refuses an unsupported Python before writing."""
import ast
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import python_guard
from python_guard import MINIMUM, require_supported_python

# Entry points that call the guard themselves, as their first repository import.
DIRECT = {
    'build_all', 'quality', 'build_legal_shared', 'build_public', 'build_cases', 'build_platforms',
    'build_events', 'build_service', 'build_guides', 'build_updates', 'build_profile', 'build_shared',
    'build_sitemap', 'build_search', 'build_share_cards', 'optimize_images', 'prepare_domain_candidate',
    'build_civic', 'editorial_pages',
}
# Report writers: they only write to a caller-chosen report/snapshot/output path and never
# regenerate site files, so an old interpreter cannot leave a half-built artifact behind.
REPORT_ONLY = {
    'audit_achievement_coverage', 'audit_external_links', 'check_content_freshness', 'inventory_site',
    'report_publication_diff', 'verify_production', 'verify_cloudflare_assets', 'verify_cloudflare_delivery',
}
WRITERS = {'write_text', 'write_bytes', 'copyfile', 'copy', 'copy2', 'copytree', 'rmtree', 'move',
           'unlink', 'mkdir', 'makedirs', 'save', 'touch', 'remove', 'rmdir', 'rename'}


def parse(name):
    return ast.parse((SCRIPTS / f'{name}.py').read_text(encoding='utf-8'))


def module_names():
    return {p.stem for p in SCRIPTS.glob('*.py')}


def imported_modules(node):
    if isinstance(node, ast.Import):
        return [alias.name.split('.')[0] for alias in node.names]
    if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
        return [node.module.split('.')[0]]
    return []


def top_level_repo_imports(tree, known):
    return {m for node in tree.body for m in imported_modules(node) if m in known}


def writer_call(node):
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    name = func.attr if isinstance(func, ast.Attribute) else getattr(func, 'id', None)
    if name in WRITERS:
        return True
    if name == 'replace' and isinstance(func, ast.Attribute) and getattr(func.value, 'id', '') == 'os':
        return True
    modes = [a.value for a in node.args[1:2] if isinstance(a, ast.Constant)]
    modes += [k.value.value for k in node.keywords if k.arg == 'mode' and isinstance(k.value, ast.Constant)]
    return name == 'open' and any(set('wax') & set(str(m)) for m in modes)


def writes_anywhere(tree):
    return any(writer_call(n) for n in ast.walk(tree))


def writes_at_import(tree):
    """Writer calls in module-level code (function and class bodies only run when called)."""
    def walk(node):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            if writer_call(child) or walk(child):
                return True
        return False
    guarded_main = [n for n in tree.body if isinstance(n, ast.If) and '__main__' in ast.dump(n.test)]
    wrapper = ast.Module(body=[n for n in tree.body if n not in guarded_main], type_ignores=[])
    return walk(wrapper)


def snapshot(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob('*'))
            if p.is_file() and '__pycache__' not in p.parts and '.git' not in p.parts}


class GuardFunctionTests(unittest.TestCase):
    def test_supported_versions_pass_silently(self):
        for version in [(3, 12, 0), (3, 12, 7), (3, 13, 1), (4, 0, 0)]:
            stream = io.StringIO()
            require_supported_python(version=version, stream=stream, environ={})
            self.assertEqual(stream.getvalue(), '', version)

    def test_older_version_exits_2_with_a_clear_bilingual_message(self):
        stream = io.StringIO()
        with self.assertRaises(SystemExit) as raised:
            require_supported_python(version=(3, 11, 9), stream=stream, environ={})
        self.assertEqual(raised.exception.code, 2)
        message = stream.getvalue()
        for expected in ['Python 3.11.9', 'Python 3.12 or newer', '.python-version', 'No files were written',
                         '不支援的 Python 3.11.9', '尚未寫入任何檔案']:
            self.assertIn(expected, message)

    def test_environment_knob_can_only_raise_the_minimum(self):
        raised = {python_guard.OVERRIDE_ENV: '99.0'}
        with self.assertRaises(SystemExit) as stop:
            require_supported_python(version=(3, 13, 0), stream=io.StringIO(), environ=raised)
        self.assertEqual(stop.exception.code, 2)
        self.assertEqual(python_guard.effective_minimum(environ=raised), (99, 0))
        for value in ['3.10', '3', '', 'not-a-version', '3.x']:
            environ = {python_guard.OVERRIDE_ENV: value}
            self.assertEqual(python_guard.effective_minimum(environ=environ), MINIMUM, value)
            with self.assertRaises(SystemExit):
                require_supported_python(version=(3, 11, 0), stream=io.StringIO(), environ=environ)

    def test_explicit_minimum_is_honoured(self):
        require_supported_python(version=(3, 10, 0), minimum=(3, 10), stream=io.StringIO(), environ={})
        with self.assertRaises(SystemExit):
            require_supported_python(version=(3, 10, 0), minimum=(3, 11), stream=io.StringIO(), environ={})

    def test_guard_module_itself_stays_parseable_on_old_grammar(self):
        # It must be importable by an old interpreter in order to explain the problem there.
        ast.parse((SCRIPTS / 'python_guard.py').read_text(encoding='utf-8'), feature_version=(3, 8))

    def test_minimum_matches_repository_python_pins(self):
        pinned = tuple(int(x) for x in (ROOT / '.python-version').read_text().strip().split('.')[:2])
        self.assertGreaterEqual(pinned, MINIMUM)
        versions = []
        for workflow in sorted((ROOT / '.github/workflows').glob('*.yml')):
            versions += re.findall(r"python-version:\s*['\"]?(\d+)\.(\d+)", workflow.read_text())
        self.assertTrue(versions)
        for major, minor in versions:
            self.assertGreaterEqual((int(major), int(minor)), MINIMUM)


class GuardPlacementTests(unittest.TestCase):
    def test_every_direct_entry_guards_before_any_other_repository_or_third_party_import(self):
        known = module_names()
        for name in sorted(DIRECT):
            body = parse(name).body
            positions = [i for i, node in enumerate(body) if 'python_guard' in imported_modules(node)]
            self.assertEqual(len(positions), 1, name)
            index = positions[0]
            call = body[index + 1]
            self.assertTrue(isinstance(call, ast.Expr) and isinstance(call.value, ast.Call)
                            and getattr(call.value.func, 'id', '') == 'require_supported_python', name)
            for node in body[:index]:
                is_doc = isinstance(node, ast.Expr) and isinstance(getattr(node, 'value', None), ast.Constant)
                is_stdlib_import = bool(imported_modules(node)) and all(
                    m in sys.stdlib_module_names for m in imported_modules(node))
                self.assertTrue(is_doc or is_stdlib_import, f'{name}: statement before guard at line {node.lineno}')
                self.assertFalse(set(imported_modules(node)) & known, name)

    def test_every_script_that_writes_files_is_guarded_covered_or_a_report_writer(self):
        known = module_names()
        trees = {name: parse(name) for name in known}
        guarded = {name for name, tree in trees.items() if 'python_guard' in top_level_repo_imports(tree, known)}
        self.assertEqual(guarded - {'python_guard'}, DIRECT)

        def pulls_guard(name, seen=()):
            for module in top_level_repo_imports(trees[name], known) - set(seen) - {name}:
                if module in guarded or pulls_guard(module, (*seen, name, module)):
                    return True
            return False

        for name, tree in sorted(trees.items()):
            if name in DIRECT or name == 'python_guard' or not writes_anywhere(tree):
                continue
            if name in REPORT_ONLY:
                continue
            self.assertTrue(pulls_guard(name),
                            f'{name}.py writes files but neither calls the guard nor imports a guarded module; '
                            'call require_supported_python() first or list it in REPORT_ONLY with a reason')
            self.assertFalse(writes_at_import(tree), f'{name}.py writes at import time before a guard can run')

    def test_report_only_allowlist_has_no_stale_entries(self):
        known = module_names()
        self.assertLessEqual(REPORT_ONLY, known)
        self.assertFalse(REPORT_ONLY & DIRECT)


class UnsupportedInterpreterTests(unittest.TestCase):
    """Run each entry point with the supported minimum forced above this interpreter."""

    ENTRY_POINTS = sorted(DIRECT | {'build_cloudflare_public', 'build_election_page', 'build_home',
                                    'build_page_content', 'build_service_print', 'publish_from_cms',
                                    'publish_from_notion'})

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        shutil.copytree(SCRIPTS, cls.root / 'scripts', ignore=shutil.ignore_patterns('__pycache__'))
        for folder in ['data', 'templates', 'assets']:
            (cls.root / folder).mkdir()
        (cls.root / 'index.html').write_text('<!doctype html><title>sentinel</title>')
        cls.env = {**os.environ, python_guard.OVERRIDE_ENV: '99.0', 'PYTHONDONTWRITEBYTECODE': '1'}

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def run_entry(self, name, root=None):
        return subprocess.run([sys.executable, f'scripts/{name}.py'], cwd=root or self.root,
                              capture_output=True, text=True, env=self.env, timeout=60)

    def test_each_entry_stops_with_status_2_before_writing(self):
        before = snapshot(self.root)
        for name in self.ENTRY_POINTS:
            result = self.run_entry(name)
            self.assertEqual(result.returncode, 2, f'{name}: {result.stderr[-500:]}')
            self.assertIn('No files were written', result.stderr, name)
            self.assertEqual(result.stdout, '', name)
            self.assertEqual(snapshot(self.root), before, f'{name} changed files')

    def test_the_check_detects_a_missing_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            shutil.copytree(self.root / 'scripts', root / 'scripts')
            target = root / 'scripts/build_legal_shared.py'
            text = target.read_text(encoding='utf-8')
            stripped = text.replace('from python_guard import require_supported_python\nrequire_supported_python()\n', '')
            self.assertNotEqual(text, stripped)
            target.write_text(stripped, encoding='utf-8')
            result = self.run_entry('build_legal_shared', root)
            self.assertNotEqual(result.returncode, 2)
            self.assertNotIn('No files were written', result.stderr)


@unittest.skipUnless(shutil.which('python3.11'), 'python3.11 is not installed')
class RealOlderInterpreterTests(unittest.TestCase):
    """With a real 3.11 interpreter: clear failure, nothing written, tracked files untouched."""

    @classmethod
    def setUpClass(cls):
        cls.python = shutil.which('python3.11')
        version = subprocess.check_output([cls.python, '-c', 'import sys;print(sys.version_info[:2])'], text=True)
        if tuple(int(x) for x in re.findall(r'\d+', version)) >= MINIMUM:
            raise unittest.SkipTest('python3.11 resolves to a supported interpreter')
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        try:
            listed = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'],
                                             cwd=ROOT, text=True, stderr=subprocess.DEVNULL).splitlines()
        except (OSError, subprocess.CalledProcessError):
            raise unittest.SkipTest('not a git checkout')
        for name in listed:
            source = ROOT / name
            if source.is_file():
                (cls.root / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, cls.root / name)
        for args in (['init', '-q'], ['add', '.'],
                     ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']):
            subprocess.run(['git', *args], cwd=cls.root, check=True, stdout=subprocess.DEVNULL)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_entries_fail_clearly_and_leave_the_tree_unchanged(self):
        for name in ['build_all', 'quality', 'editorial_pages', 'build_cases', 'build_public', 'build_cloudflare_public']:
            result = subprocess.run([self.python, f'scripts/{name}.py'], cwd=self.root, capture_output=True,
                                    text=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, timeout=120)
            self.assertEqual(result.returncode, 2, f'{name}: {result.stderr[-500:]}')
            self.assertIn('Unsupported Python 3.11', result.stderr, name)
            self.assertIn('No files were written', result.stderr, name)
            status = subprocess.check_output(['git', 'status', '--porcelain'], cwd=self.root, text=True)
            self.assertEqual(status, '', f'{name} left changes behind')

    def test_editorial_pages_no_longer_needs_newer_f_string_grammar(self):
        source = SCRIPTS / 'editorial_pages.py'
        code = 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())'
        result = subprocess.run([self.python, '-c', code, str(source)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr[-500:])


if __name__ == '__main__':
    unittest.main()
