"""The late-loaded companion CSS must be verified before snapshot browser QA."""
import importlib.util
import hashlib
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('small_q_production_verifier', ROOT / 'scripts/verify_production.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SmallQVerificationTests(unittest.TestCase):
    def test_deferred_stylesheet_is_in_verified_static_snapshot(self):
        self.assertIn('small-q.css', module.STATIC_FILES)
        self.assertTrue((ROOT / 'small-q.css').is_file())
        style_hash = hashlib.sha256((ROOT / 'small-q.css').read_bytes()).hexdigest()[:12]
        self.assertIn(f"small-q.css?v={style_hash}", (ROOT / 'small-q.js').read_text())

    def test_homepage_generated_image_assets_are_in_verified_static_snapshot(self):
        expected = (
            'assets/fengshan-home-map.svg',
            'assets/legal/portrait.webp',
            'assets/home-portrait-384.avif', 'assets/home-portrait-480.avif',
            'assets/home-portrait-640.avif', 'assets/home-portrait-1004.avif',
            'assets/home-portrait-384.webp', 'assets/home-portrait-480.webp',
            'assets/home-portrait-640.webp',
            'assets/events/campaign-opening-20261031-landscape-480.avif',
            'assets/events/campaign-opening-20261031-landscape-800.avif',
            'assets/events/campaign-opening-20261031-landscape-1087.avif',
            'assets/events/campaign-opening-20261031-landscape-480.webp',
            'assets/events/campaign-opening-20261031-landscape-800.webp',
            'assets/events/campaign-opening-20261031-landscape-1087.webp',
            'assets/events/campaign-opening-20261031-landscape.jpg',
        )
        for path in expected:
            with self.subTest(path=path):
                self.assertIn(path, module.STATIC_FILES)
                self.assertTrue((ROOT / path).is_file())

    def test_existing_static_verification_assets_are_retained(self):
        self.assertIn('assets/vendor/leaflet.css', module.STATIC_FILES)
        self.assertIn('assets/vendor/leaflet.js', module.STATIC_FILES)
        self.assertIn('data/achievements-public.json', module.STATIC_FILES)
