"""Production snapshots hash binary assets byte for byte and text canonically."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("production_verifier", ROOT / "scripts/verify_production.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProductionBinaryDigestTests(unittest.TestCase):
    def test_homepage_binary_assets_use_exact_sha256_for_parity_and_cache_keys(self):
        for relative in (
            "assets/legal/portrait.webp",
            "assets/home-portrait-384.avif",
            "assets/events/campaign-opening-20261031-landscape.jpg",
        ):
            with self.subTest(path=relative):
                data = (ROOT / relative).read_bytes()
                expected = hashlib.sha256(data).hexdigest()
                self.assertTrue(module.is_binary_path(relative))
                self.assertEqual(module.digest(data, binary=True), expected)
                self.assertEqual(
                    module.verification_cache_key(data, "run", 1, binary=True),
                    f"{expected[:16]}-run-1",
                )

    def test_binary_tampering_and_valid_utf8_whitespace_are_compared_exactly(self):
        original = b"legal image bytes\n"
        whitespace_variant = b"legal image bytes "
        self.assertEqual(whitespace_variant.decode("utf-8"), "legal image bytes ")
        self.assertTrue(module.is_binary_path("assets/events/fixture.webp"))
        self.assertNotEqual(module.digest(original, binary=True), module.digest(whitespace_variant, binary=True))
        self.assertNotEqual(
            module.verification_cache_key(original, "run", 1, binary=True),
            module.verification_cache_key(whitespace_variant, "run", 1, binary=True),
        )
        self.assertNotEqual(module.digest(original, binary=True), module.digest(original + b"\x00", binary=True))

    def test_text_whitespace_normalization_is_preserved_for_comparisons_and_cache_keys(self):
        canonical = b"title\r\nbody\r\n"
        equivalent = b"title\nbody   "
        self.assertFalse(module.is_binary_path("index.html"))
        self.assertEqual(module.digest(canonical), module.digest(equivalent))
        self.assertEqual(
            module.verification_cache_key(canonical, "run", 1),
            module.verification_cache_key(equivalent, "run", 1),
        )


if __name__ == "__main__":
    unittest.main()
