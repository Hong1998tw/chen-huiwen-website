"""The late-loaded companion CSS must be verified before snapshot browser QA."""
import importlib.util
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
        self.assertIn("small-q.css?v=", (ROOT / 'small-q.js').read_text())

    def test_existing_static_verification_assets_are_retained(self):
        self.assertIn('assets/vendor/leaflet.css', module.STATIC_FILES)
        self.assertIn('assets/vendor/leaflet.js', module.STATIC_FILES)
        self.assertIn('data/achievements-public.json', module.STATIC_FILES)
