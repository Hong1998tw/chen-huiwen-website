import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_public
import verify_all_pages as coverage


class AllPageVerificationTests(unittest.TestCase):
    def test_roster_matches_exact_public_html_artifact(self):
        expected = sorted(path for path in build_public.public_paths(ROOT) if path.endswith('.html'))
        self.assertEqual(coverage.pages(ROOT), expected)
        self.assertGreaterEqual(len(expected), 100)

    def test_live_content_omission_fails(self):
        source = (ROOT / 'index.html').read_bytes()

        def fetch(base, path, key, timeout):
            self.assertEqual(path, '/')
            return 200, base, source.replace('慧文會武'.encode(), '其他文字'.encode())

        result = coverage.verify_page('index.html', ROOT, fetcher=fetch)
        self.assertEqual(result['status'], 'Failed')

    def test_legacy_alias_misdirection_fails(self):
        source = (ROOT / 'mktexp26/index.html').read_bytes()

        def fetch(base, path, key, timeout):
            self.assertEqual(path, '/mktexp26/')
            return 200, base + 'mktexp26/', source.replace(b'activity-market.html', b'activity-mooncake.html')

        result = coverage.verify_page('mktexp26/index.html', ROOT, fetcher=fetch)
        self.assertEqual(result['status'], 'Failed')

    def test_public_page_round_trip(self):
        def fetch(base, path, key, timeout):
            local = ROOT / ((path.lstrip('/') + 'index.html') if path.endswith('/') and path != '/' else (path.lstrip('/') or 'index.html'))
            return 200, base + path.lstrip('/'), local.read_bytes()

        for page in ('index.html', 'renwu-anju-social-housing/index.html', 'mktexp26/index.html', 'offline.html'):
            with self.subTest(page=page):
                self.assertEqual(coverage.verify_page(page, ROOT, fetcher=fetch)['status'], 'Passed')


if __name__ == '__main__':
    unittest.main()
