"""Focused checks for immutable public-artifact fixture reuse and isolation."""
from contextlib import redirect_stderr
from io import StringIO
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

from public_artifact_fixture import (
    ArtifactTemplateCache,
    _build_cloudflare_fixture,
    _cloudflare_input_identity,
    _module_state,
    _stable_value,
    _UNSUPPORTED,
    build_fixture_key,
    hash_input_paths,
    prepare_cloudflare_test_artifact,
)


class ArtifactTemplateCacheTests(unittest.TestCase):
    def test_function_code_identity_stays_stable_after_adaptive_execution(self):
        def builder(items):
            return sum(item['value'] for item in items)

        before = _stable_value(builder)
        self.assertIsNot(before, _UNSUPPORTED)
        for _ in range(100):
            builder([{'value': value} for value in range(4)])
        self.assertEqual(_stable_value(builder), before)

    def test_real_cloudflare_builder_pair_shares_one_immutable_fixture(self):
        root = Path(__file__).resolve().parents[1]
        scripts = str(root / 'scripts')
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        import build_cloudflare_public as cloudflare
        import build_artifact_page_fonts as producer
        import public_artifact_fixture as fixture

        key, revision, cacheable, reason = _cloudflare_input_identity(root, cloudflare, producer)
        self.assertRegex(key or '', r'^[a-f0-9]{64}$')
        self.assertTrue(cacheable, reason)
        self.assertIsNone(reason)

        cache = fixture._CLOUDFLARE_CACHE
        cache.close()
        original_build = cache._build
        build_calls = []

        def counted_build(builder, builder_args):
            build_calls.append(builder)
            return original_build(builder, builder_args)

        started = time.perf_counter()
        cache_events = StringIO()
        cache._build = counted_build
        try:
            with patch.dict(os.environ, {'PAGE_FONT_ARTIFACT_ROOT': ''}):
                with redirect_stderr(cache_events):
                    with tempfile.TemporaryDirectory() as first_directory, \
                            tempfile.TemporaryDirectory() as second_directory:
                        first = prepare_cloudflare_test_artifact(
                            root, first_directory, cloudflare, producer,
                        )
                        second = prepare_cloudflare_test_artifact(
                            root, second_directory, cloudflare, producer,
                        )
                        self.assertEqual(len(build_calls), 1)
                        self.assertIsNotNone(cache._key)
                        self.assertEqual(cache_events.getvalue().count('cache=miss'), 1)
                        self.assertEqual(cache_events.getvalue().count('cache=hit'), 1)
                        self.assertIn('reason=exact_identity', cache_events.getvalue())

                        first_files = sorted(
                            path.relative_to(first).as_posix()
                            for path in first.rglob('*') if path.is_file()
                        )
                        second_files = sorted(
                            path.relative_to(second).as_posix()
                            for path in second.rglob('*') if path.is_file()
                        )
                        self.assertEqual(first_files, second_files)
                        first_digest = hash_input_paths(first, first_files)
                        second_digest = hash_input_paths(second, second_files)
                        self.assertEqual(first_digest, second_digest)
                        self.assertGreater(len(first_files), 300)

                        for relative in first_files:
                            first_stat = os.lstat(first / relative)
                            second_stat = os.lstat(second / relative)
                            self.assertTrue(stat.S_ISREG(first_stat.st_mode))
                            self.assertTrue(stat.S_ISREG(second_stat.st_mode))
                            self.assertEqual(first_stat.st_nlink, 1)
                            self.assertEqual(second_stat.st_nlink, 1)
                            self.assertNotEqual(
                                (first_stat.st_dev, first_stat.st_ino),
                                (second_stat.st_dev, second_stat.st_ino),
                            )

                        first_receipt = json.loads((first / 'deployment.json').read_text())
                        second_receipt = json.loads((second / 'deployment.json').read_text())
                        self.assertEqual(first_receipt, second_receipt)
                        self.assertEqual(first_receipt.get('sourceCommit'), revision)
                        before_mutation = (second / 'index.html').read_bytes()
                        (first / 'index.html').write_bytes(b'changed class copy')
                        self.assertEqual((second / 'index.html').read_bytes(), before_mutation)
                        self.assertEqual((cache._template / 'index.html').read_bytes(), before_mutation)

                        elapsed = time.perf_counter() - started
                        print(json.dumps({
                            'event': 'real-cloudflare-fixture-pair',
                            'builderModule': cloudflare.__name__,
                            'buildCalls': len(build_calls),
                            'secondCallHit': 'exact_identity',
                            'moduleKey': key,
                            'sourceCommit': revision,
                            'fileCount': len(first_files),
                            'outputSha256': first_digest,
                            'elapsedSeconds': round(elapsed, 3),
                        }, sort_keys=True))
        finally:
            cache._build = original_build

    def test_builder_receipt_source_commit_must_match_input_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            site = root / 'site'
            site.mkdir()

            def matching_builder(_root, destination, revision):
                (destination / 'deployment.json').write_text(
                    '{"sourceCommit":"' + revision + '"}', encoding='utf-8',
                )

            _build_cloudflare_fixture(site, root, 'source-sha', matching_builder)
            self.assertEqual(
                (site / 'deployment.json').read_text(encoding='utf-8'),
                '{"sourceCommit":"source-sha"}',
            )

            def rebinding_builder(_root, destination, _revision):
                (destination / 'deployment.json').write_text(
                    '{"sourceCommit":"different-sha"}', encoding='utf-8',
                )

            with self.assertRaisesRegex(ValueError, 'sourceCommit'):
                _build_cloudflare_fixture(site, root, 'source-sha', rebinding_builder)

    def test_same_clean_key_builds_once_and_copies_are_mutation_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = ArtifactTemplateCache()

            def builder(destination):
                (destination / 'artifact.txt').write_text('standard artifact')

            key = build_fixture_key('source-sha', 'clean-input-digest', 'fake-builder-v1', {'mode': 'standard'})
            first = cache.copy_to(key, builder, root / 'class-one')
            template = cache._template
            second = cache.copy_to(key, builder, root / 'class-two')
            first_file = first / 'artifact.txt'
            second_file = second / 'artifact.txt'
            template_file = cache._template / 'artifact.txt'

            first_stat = os.lstat(first_file)
            second_stat = os.lstat(second_file)
            self.assertIs(cache._template, template)
            self.assertTrue(first_stat.st_nlink == second_stat.st_nlink == 1)
            self.assertNotEqual((first_stat.st_dev, first_stat.st_ino),
                                (second_stat.st_dev, second_stat.st_ino))
            first_file.write_text('mutation from class one')
            self.assertEqual(second_file.read_text(), 'standard artifact')
            self.assertEqual(template_file.read_text(), 'standard artifact')
            cache.close()

    def test_source_dirty_input_and_module_changes_cannot_reuse_a_template(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'builder-input.json'
            source.write_text('{"status":"clean"}')
            clean_digest = hash_input_paths(root, ['builder-input.json'])
            clean_key = build_fixture_key('source-sha', clean_digest, 'fake-builder-v1', {'revision': 1})

            cache = ArtifactTemplateCache()

            def builder(destination):
                (destination / 'input.txt').write_text(source.read_text())

            cache.copy_to(clean_key, builder, root / 'clean-one')
            template = cache._template
            cache.copy_to(clean_key, builder, root / 'clean-two')
            self.assertIs(cache._template, template)

            source.write_text('{"status":"dirty"}')
            dirty_digest = hash_input_paths(root, ['builder-input.json'])
            dirty_key = build_fixture_key('source-sha', dirty_digest, 'fake-builder-v1', {'revision': 1})
            self.assertNotEqual(clean_key, dirty_key)
            cache.copy_to(dirty_key, builder, root / 'dirty-input')
            dirty_template = cache._template
            self.assertEqual((root / 'dirty-input/input.txt').read_text(), '{"status":"dirty"}')

            changed_module_key = build_fixture_key(
                'source-sha', dirty_digest, 'fake-builder-v1', {'revision': 2},
            )
            self.assertNotEqual(dirty_key, changed_module_key)
            cache.copy_to(changed_module_key, builder, root / 'changed-module')
            changed_module_template = cache._template
            self.assertIsNot(changed_module_template, dirty_template)

            changed_source_key = build_fixture_key(
                'different-source-sha', dirty_digest, 'fake-builder-v1', {'revision': 2},
            )
            self.assertNotEqual(changed_module_key, changed_source_key)
            cache.copy_to(changed_source_key, builder, root / 'changed-source')
            self.assertIsNot(cache._template, changed_module_template)

            # Dirty builder inputs are always rebuilt, even if the same SHA and
            # dirty digest are requested again; HEAD alone never enables reuse.
            cache.copy_to(dirty_key, builder, root / 'dirty-again', cacheable=False)
            cache.copy_to(dirty_key, builder, root / 'dirty-again-two', cacheable=False)
            self.assertEqual((root / 'dirty-again/input.txt').read_text(), '{"status":"dirty"}')
            self.assertIsNotNone(cache._template)
            cache.close()

    def test_nested_closure_values_are_part_of_cache_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = ArtifactTemplateCache()

            def make_builder(captured):
                def outer():
                    def nested(destination):
                        (destination / 'artifact.txt').write_text(captured['value'])
                    return nested

                nested_builder = outer()

                def builder(destination):
                    nested_builder(destination)

                return builder

            closed_a = make_builder({'value': 'closedA'})
            closed_b = make_builder({'value': 'closedB'})
            first = cache.copy_to('same-module-state-and-input', closed_a, root / 'closed-a')
            first_template = cache._template
            second = cache.copy_to('same-module-state-and-input', closed_b, root / 'closed-b')

            self.assertEqual((first / 'artifact.txt').read_text(), 'closedA')
            self.assertEqual((second / 'artifact.txt').read_text(), 'closedB')
            self.assertIsNot(cache._template, first_template)
            cache.close()

    def test_builder_code_change_invalidates_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = ArtifactTemplateCache()

            def make_builder(use_first_code):
                if use_first_code:
                    def builder(destination):
                        (destination / 'artifact.txt').write_text('codeA')
                else:
                    def builder(destination):
                        (destination / 'artifact.txt').write_text('codeB')
                return builder

            code_a = make_builder(True)
            code_b = make_builder(False)
            self.assertEqual(code_a.__qualname__, code_b.__qualname__)
            first = cache.copy_to('same-input-and-module-state', code_a, root / 'code-a')
            first_template = cache._template
            second = cache.copy_to('same-input-and-module-state', code_b, root / 'code-b')

            self.assertEqual((first / 'artifact.txt').read_text(), 'codeA')
            self.assertEqual((second / 'artifact.txt').read_text(), 'codeB')
            self.assertIsNot(cache._template, first_template)
            cache.close()

    def test_mutable_closure_change_invalidates_cached_template(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = ArtifactTemplateCache()
            captured = {'value': 'before'}

            def builder(destination):
                (destination / 'artifact.txt').write_text(captured['value'])

            first = cache.copy_to('same-input', builder, root / 'before')
            first_template = cache._template
            captured['value'] = 'after'
            second = cache.copy_to('same-input', builder, root / 'after')

            self.assertEqual((first / 'artifact.txt').read_text(), 'before')
            self.assertEqual((second / 'artifact.txt').read_text(), 'after')
            self.assertIsNot(cache._template, first_template)
            cache.close()

    def test_default_and_keyword_default_changes_invalidate_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = ArtifactTemplateCache()

            def positional_builder(destination, value='defaultA'):
                (destination / 'artifact.txt').write_text(value)

            first = cache.copy_to('same-input', positional_builder, root / 'default-a')
            positional_template = cache._template
            positional_builder.__defaults__ = ('defaultB',)
            second = cache.copy_to('same-input', positional_builder, root / 'default-b')
            self.assertEqual((first / 'artifact.txt').read_text(), 'defaultA')
            self.assertEqual((second / 'artifact.txt').read_text(), 'defaultB')
            self.assertIsNot(cache._template, positional_template)

            def keyword_builder(destination, *, value='keywordA'):
                (destination / 'artifact.txt').write_text(value)

            third = cache.copy_to('same-input', keyword_builder, root / 'keyword-a')
            keyword_template = cache._template
            keyword_builder.__kwdefaults__ = {'value': 'keywordB'}
            fourth = cache.copy_to('same-input', keyword_builder, root / 'keyword-b')
            self.assertEqual((third / 'artifact.txt').read_text(), 'keywordA')
            self.assertEqual((fourth / 'artifact.txt').read_text(), 'keywordB')
            self.assertIsNot(cache._template, keyword_template)
            cache.close()

    def test_unknown_and_circular_captured_state_always_bypasses_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = ArtifactTemplateCache()

            class UnknownState:
                def __init__(self, value):
                    self.value = value

            self.assertIsNone(build_fixture_key(
                'source-sha', 'input-digest', 'builder', {'unknown': object()},
            ))
            self.assertIsNone(build_fixture_key(
                'source-sha', 'input-digest', 'builder', {'class-state': UnknownState},
            ))
            cyclic_state = []
            cyclic_state.append(cyclic_state)
            self.assertIsNone(build_fixture_key(
                'source-sha', 'input-digest', 'builder', {'cycle': cyclic_state},
            ))
            shared_state = {'value': 'shared'}
            self.assertIsNone(build_fixture_key(
                'source-sha', 'input-digest', 'builder',
                {'left': shared_state, 'right': shared_state},
            ))
            unknown_module = types.ModuleType('unknown_module_state')
            unknown_module.state = object()
            self.assertIs(_module_state(unknown_module), _UNSUPPORTED)
            circular_module = types.ModuleType('circular_module_state')
            circular_state = []
            circular_state.append(circular_state)
            circular_module.state = circular_state
            self.assertIs(_module_state(circular_module), _UNSUPPORTED)
            deeply_nested = []
            current = deeply_nested
            for _ in range(1200):
                child = []
                current.append(child)
                current = child
            self.assertIsNone(build_fixture_key(
                'source-sha', 'input-digest', 'builder', {'deep': deeply_nested},
            ))

            captured = UnknownState('unknownA')

            def unknown_builder(destination):
                (destination / 'artifact.txt').write_text(captured.value)

            first = cache.copy_to('same-input', unknown_builder, root / 'unknown-a')
            captured.value = 'unknownB'
            second = cache.copy_to('same-input', unknown_builder, root / 'unknown-b')
            self.assertEqual((first / 'artifact.txt').read_text(), 'unknownA')
            self.assertEqual((second / 'artifact.txt').read_text(), 'unknownB')

            cycle = []
            cycle.append(cycle)

            def circular_builder(destination):
                (destination / 'artifact.txt').write_text(str(len(cycle)))

            third = cache.copy_to('same-input', circular_builder, root / 'circular-one')
            cycle.append('changed')
            fourth = cache.copy_to('same-input', circular_builder, root / 'circular-two')
            self.assertEqual((third / 'artifact.txt').read_text(), '1')
            self.assertEqual((fourth / 'artifact.txt').read_text(), '2')
            cache.close()


if __name__ == '__main__':
    unittest.main()
