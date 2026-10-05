"""The public artifact ships a minimal, reviewed set of security headers and nothing more.

Tests build the real Cloudflare artifact and evaluate its `_headers` file the way
Cloudflare Static Assets does (every matching rule applies; repeated names combine).
"""
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_cloudflare_public as cloudflare
import verify_security_headers as verifier

FEATURES_DENIED = {'camera', 'microphone', 'geolocation', 'payment'}
FEATURE_API = re.compile(r'geolocation|getUserMedia|mediaDevices|PaymentRequest', re.I)


def parse_headers(text):
    """Return [(path_pattern, [(name, value), ...]), ...] from a `_headers` file."""
    rules = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if line[0] not in ' \t':
            rules.append((line.strip(), []))
        else:
            name, _, value = line.strip().partition(':')
            rules[-1][1].append((name.strip(), value.strip()))
    return rules


def response_headers(rules, path):
    """Headers Cloudflare would attach to `path`; duplicate names are comma-joined."""
    merged = {}
    for pattern, headers in rules:
        if re.fullmatch(re.escape(pattern).replace(r'\*', '.*'), path):
            for name, value in headers:
                key = name.lower()
                merged[key] = f'{merged[key]}, {value}' if key in merged else value
    return merged


class SecurityHeaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.site = Path(cls.temp.name)
        cloudflare.build(ROOT, cls.site, 'a' * 40)
        cls.text = (cls.site / '_headers').read_text()
        cls.rules = parse_headers(cls.text)
        files = ['/' + p.relative_to(cls.site).as_posix()
                 for p in cls.site.rglob('*') if p.is_file()]
        aliases = [line.split()[0] for line in (cls.site / '_redirects').read_text().splitlines()]
        cls.paths = sorted(set(files + aliases + ['/missing-page-for-404.html']))

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_catch_all_rule_matches_every_delivery_path(self):
        expected = {name.lower(): value for name, value in cloudflare.SECURITY_HEADERS}
        self.assertGreater(len(self.paths), 300)
        for required in ['/', '/index.html', '/mktexp26/', '/renwu-anju-social-housing/',
                         '/site.js', '/styles.css', '/data/search-index.json',
                         '/missing-page-for-404.html']:
            self.assertIn(required, self.paths)
        for path in self.paths:
            headers = response_headers(self.rules, path)
            for name, value in expected.items():
                self.assertEqual(headers.get(name), value, f'{path}: {name}')

    def test_receipt_stays_uncached_and_nothing_else_gets_cache_control(self):
        for path in self.paths:
            cache = response_headers(self.rules, path).get('cache-control')
            self.assertEqual(cache, 'no-store' if path == '/deployment.json' else None, path)

    def test_header_file_fits_cloudflare_limits(self):
        self.assertLessEqual(len(self.rules), 100)
        self.assertTrue(all(len(line) <= 2000 for line in self.text.splitlines()))
        self.assertTrue(self.text.endswith('\n'))

    def test_header_set_is_exactly_the_reviewed_minimum(self):
        self.assertEqual({name for name, _ in cloudflare.SECURITY_HEADERS}, {
            'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy',
            'X-Frame-Options', 'Content-Security-Policy'})
        # A fuller policy needs its own reviewed change: COEP/CORP would break the
        # admin thumbnails and Facebook/OSM embeds; HSTS is a Cloudflare zone setting.
        text = self.text.lower()
        for deferred in ['cross-origin-embedder-policy', 'cross-origin-resource-policy',
                         'strict-transport-security']:
            self.assertNotIn(deferred, text)
        csp = dict(cloudflare.SECURITY_HEADERS)['Content-Security-Policy']
        self.assertEqual([part.split()[0] for part in csp.split(';')], ['frame-ancestors'])
        self.assertNotIn('unsafe-', csp)

    def test_permissions_policy_denies_only_unused_features(self):
        policy = dict(cloudflare.SECURITY_HEADERS)['Permissions-Policy']
        denied = {part.split('=')[0].strip() for part in policy.split(',')}
        self.assertEqual(denied, FEATURES_DENIED)
        self.assertTrue(all(part.split('=')[1].strip() == '()' for part in policy.split(',')))
        for path in sorted(self.site.rglob('*')):
            if path.suffix == '.js' and 'vendor' not in path.parts:
                self.assertIsNone(FEATURE_API.search(path.read_text(errors='ignore')), path.name)
        for page in self.site.rglob('*.html'):
            for tag in re.findall(r'<iframe\b[^>]*>', page.read_text(errors='ignore')):
                allow = re.search(r'\ballow="([^"]*)"', tag)
                delegated = {token.split()[0] for token in (allow.group(1).split(';') if allow else []) if token.strip()}
                self.assertFalse(delegated & FEATURES_DENIED, (page.name, tag))

    def test_public_pages_embed_no_first_party_page(self):
        for page in self.site.rglob('*.html'):
            for src in re.findall(r'<iframe\b[^>]*\bsrc="([^"]+)"', page.read_text(errors='ignore')):
                self.assertTrue(src.startswith('https://www.facebook.com/plugins/'), (page.name, src))

    def test_admin_preview_stays_on_the_same_origin_proxy(self):
        # frame-ancestors 'none' is only safe because the admin never frames www pages.
        app = (ROOT / 'admin/public/app.js').read_text()
        sources = re.findall(r'frame\.src\s*=\s*([^;]+);', app)
        self.assertTrue(sources)
        for source in sources:
            self.assertTrue(source.lstrip('`"\'').startswith('/api/page-preview'), source)
        page = (ROOT / 'admin/public/index.html').read_text()
        self.assertIsNone(re.search(r'<iframe\b[^>]*\bsrc=', page))


class PostDeployCheckTests(unittest.TestCase):
    def fake(self, mutate=None, status=200):
        def getter(url):
            path = url.split('://', 1)[1].partition('/')[2]
            path = '/' + path
            headers = {name.lower(): value for name, value in cloudflare.SECURITY_HEADERS}
            if path == '/deployment.json':
                headers['cache-control'] = 'no-store'
            code = 404 if path == verifier.NOT_FOUND_PROBE else status
            if mutate:
                code, url, headers = mutate(path, code, url, headers)
            return code, url, headers
        return getter

    def test_passes_when_every_path_carries_the_reviewed_headers(self):
        report = verifier.verify('https://example.test', getter=self.fake())
        self.assertEqual(report['status'], 'PASS')
        self.assertEqual(len(report['results']), len(verifier.PATHS) + 1)
        self.assertEqual(report['results'][-1]['status'], 404)

    def test_fails_on_missing_changed_redirected_or_wrong_status(self):
        def drop_nosniff(path, code, url, headers):
            if path == '/mktexp26/':
                headers = {k: v for k, v in headers.items() if k != 'x-content-type-options'}
            return code, url, headers
        def weaken_frame(path, code, url, headers):
            return code, url, {**headers, 'x-frame-options': 'SAMEORIGIN'} if path == '/' else headers
        def redirect(path, code, url, headers):
            return code, url.replace('/about.html', '/about') if path == '/about.html' else url, headers
        def cache_receipt(path, code, url, headers):
            return code, url, {**headers, 'cache-control': 'public, max-age=60'} if path == '/deployment.json' else headers
        def not_found_as_ok(path, code, url, headers):
            return (200 if path == verifier.NOT_FOUND_PROBE else code), url, headers
        for mutate in (drop_nosniff, weaken_frame, redirect, cache_receipt, not_found_as_ok):
            report = verifier.verify('https://example.test', getter=self.fake(mutate))
            self.assertEqual(report['status'], 'FAIL', mutate.__name__)

    def test_network_error_is_reported_as_failure_not_crash(self):
        def broken(url):
            raise OSError('connection reset')
        report = verifier.verify('https://example.test', getter=broken)
        self.assertEqual(report['status'], 'FAIL')
        self.assertIn('connection reset', report['results'][0]['failures'][0])


if __name__ == '__main__':
    unittest.main()
