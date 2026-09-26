import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_public
import page_authority


class PageAuthorityTests(unittest.TestCase):
    def test_exact_artifact_coverage_with_existing_sources(self):
        rows = page_authority.catalog(ROOT)
        expected = {path for path in build_public.public_paths(ROOT) if path.endswith('.html')}
        self.assertEqual({row['path'] for row in rows}, expected)
        self.assertEqual(len(rows), len(expected))
        for row in rows:
            self.assertTrue((ROOT / row['source']).is_file())

    def test_excluded_intake_and_source_generated_pages_are_distinct(self):
        rows = {row['path']: row for row in page_authority.catalog(ROOT)}
        self.assertEqual(rows['petition.html']['kind'], 'excluded-intake')
        self.assertEqual(rows['petition.html']['editorScope'], 'none')
        self.assertEqual(rows['service.html']['editorScope'], 'partial')
        self.assertEqual(rows['achievement-metro-green-line.html']['source'], 'data/achievements.json')
        self.assertEqual(rows['mktexp26/index.html']['kind'], 'legacy-redirect')


if __name__ == '__main__':
    unittest.main()
