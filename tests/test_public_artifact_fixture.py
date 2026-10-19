"""Focused checks for immutable public-artifact fixture reuse and isolation."""
import os
from pathlib import Path
import tempfile
import unittest

from public_artifact_fixture import (
    ArtifactTemplateCache,
    _build_cloudflare_fixture,
    build_fixture_key,
    hash_input_paths,
)


class ArtifactTemplateCacheTests(unittest.TestCase):
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
