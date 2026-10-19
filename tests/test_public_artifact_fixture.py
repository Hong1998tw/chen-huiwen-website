"""Focused checks for immutable public-artifact fixture reuse and isolation."""
import os
from pathlib import Path
import tempfile
import unittest

from public_artifact_fixture import (
    ArtifactTemplateCache,
    build_fixture_key,
    hash_input_paths,
)


class ArtifactTemplateCacheTests(unittest.TestCase):
    def test_same_clean_key_builds_once_and_copies_are_mutation_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = ArtifactTemplateCache()
            calls = []

            def builder(destination):
                calls.append(destination)
                (destination / 'artifact.txt').write_text('standard artifact')

            key = build_fixture_key('source-sha', 'clean-input-digest', 'fake-builder-v1', {'mode': 'standard'})
            first = cache.copy_to(key, builder, root / 'class-one')
            second = cache.copy_to(key, builder, root / 'class-two')
            first_file = first / 'artifact.txt'
            second_file = second / 'artifact.txt'
            template_file = cache._template / 'artifact.txt'

            first_stat = os.lstat(first_file)
            second_stat = os.lstat(second_file)
            self.assertEqual(len(calls), 1)
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
            calls = []

            def builder(destination):
                calls.append(destination)
                (destination / 'input.txt').write_text(source.read_text())

            cache.copy_to(clean_key, builder, root / 'clean-one')
            cache.copy_to(clean_key, builder, root / 'clean-two')
            self.assertEqual(len(calls), 1)

            source.write_text('{"status":"dirty"}')
            dirty_digest = hash_input_paths(root, ['builder-input.json'])
            dirty_key = build_fixture_key('source-sha', dirty_digest, 'fake-builder-v1', {'revision': 1})
            self.assertNotEqual(clean_key, dirty_key)
            cache.copy_to(dirty_key, builder, root / 'dirty-input')
            self.assertEqual(len(calls), 2)

            changed_module_key = build_fixture_key(
                'source-sha', dirty_digest, 'fake-builder-v1', {'revision': 2},
            )
            self.assertNotEqual(dirty_key, changed_module_key)
            cache.copy_to(changed_module_key, builder, root / 'changed-module')
            self.assertEqual(len(calls), 3)

            changed_source_key = build_fixture_key(
                'different-source-sha', dirty_digest, 'fake-builder-v1', {'revision': 2},
            )
            self.assertNotEqual(changed_module_key, changed_source_key)
            cache.copy_to(changed_source_key, builder, root / 'changed-source')
            self.assertEqual(len(calls), 4)

            # Dirty builder inputs are always rebuilt, even if the same SHA and
            # dirty digest are requested again; HEAD alone never enables reuse.
            cache.copy_to(dirty_key, builder, root / 'dirty-again', cacheable=False)
            cache.copy_to(dirty_key, builder, root / 'dirty-again-two', cacheable=False)
            self.assertEqual(len(calls), 6)
            cache.close()


if __name__ == '__main__':
    unittest.main()
