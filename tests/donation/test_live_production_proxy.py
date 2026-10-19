import hashlib
import tempfile
import unittest
from pathlib import Path

from live_production_proxy import resolve_snapshot_asset


class LiveProductionProxyAssetTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temp_dir.name)
        self.root = self.temp_root / "snapshot"
        self.root.mkdir()
        self.body = (Path(__file__).resolve().parents[2] / "small-q.css").read_bytes()
        (self.root / "small-q.css").write_bytes(self.body)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_fingerprinted_request_maps_to_verified_alias_with_matching_bytes(self):
        digest = hashlib.sha256(self.body).hexdigest()
        candidate, served = resolve_snapshot_asset(
            self.root,
            f"small-q.{digest}.css",
            {"small-q.css"},
        )

        self.assertEqual(candidate, (self.root / "small-q.css").resolve())
        self.assertEqual(served, self.body)

    def test_rejects_wrong_hash_missing_alias_and_unverified_path(self):
        wrong_digest = hashlib.sha256(b"different bytes").hexdigest()

        self.assertIsNone(resolve_snapshot_asset(
            self.root, f"small-q.{wrong_digest}.css", {"small-q.css"}
        ))
        self.assertIsNone(resolve_snapshot_asset(
            self.root, f"missing.{wrong_digest}.css", {"small-q.css"}
        ))
        self.assertIsNone(resolve_snapshot_asset(
            self.root, "small-q.css", set()
        ))

    def test_rejects_path_traversal_and_symlink_escape(self):
        with self.assertRaises(ValueError):
            resolve_snapshot_asset(self.root, "../outside.css", {"../outside.css"})

        outside = self.temp_root / "outside.css"
        outside.write_bytes(b"outside snapshot")
        try:
            (self.root / "linked.css").symlink_to(outside)
        except (NotImplementedError, OSError):
            return
        self.assertIsNone(resolve_snapshot_asset(self.root, "linked.css", {"linked.css"}))


if __name__ == "__main__":
    unittest.main()
