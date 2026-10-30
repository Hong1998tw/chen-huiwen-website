"""Homepage event and portrait variants preserve complete, verified image closures."""
import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build_home import EVENT_VARIANT_MANIFEST, _responsive_event_picture

EVENT_ID = "campaign-headquarters-opening-2026-10-31"
SOURCE = "assets/events/campaign-opening-20261031-landscape.jpg"
ALTERNATE = "assets/metro-green-line-caogong-waterfront.jpg"


def event_source():
    events = json.loads((ROOT / "data/events.json").read_text(encoding="utf-8"))["events"]
    return copy.deepcopy(next(event for event in events if event["id"] == EVENT_ID))


def references(soup):
    paths = set()
    for element in soup.select("[src]"):
        paths.add(element["src"].split("?", 1)[0])
    for element in soup.select("[srcset]"):
        for candidate in element["srcset"].split(","):
            paths.add(candidate.strip().split()[0].split("?", 1)[0])
    return paths


class HomeImageVariantTests(unittest.TestCase):
    def _copy_approved_bundle(self, root, *, source_bytes=None, omit_variant=None, tamper_variant=None):
        source = root / SOURCE
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(source_bytes if source_bytes is not None else (ROOT / SOURCE).read_bytes())
        manifest = root / EVENT_VARIANT_MANIFEST
        manifest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / EVENT_VARIANT_MANIFEST, manifest)
        for width in (480, 800, 1087):
            for fmt in ("avif", "webp"):
                relative = f"assets/events/campaign-opening-20261031-landscape-{width}.{fmt}"
                if relative == omit_variant:
                    continue
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                data = (ROOT / relative).read_bytes()
                if relative == tamper_variant:
                    data += b"tampered"
                target.write_bytes(data)

    def test_current_home_event_srcsets_have_a_complete_existing_reference_closure(self):
        generated = BeautifulSoup(_responsive_event_picture(event_source()["images"][0], ROOT), "html.parser")
        built = BeautifulSoup((ROOT / "index.html").read_text(encoding="utf-8"), "html.parser")
        pictures = (generated.select_one("picture"),
                    built.select_one('[data-latest-id="event-campaign-headquarters-opening-2026-10-31"] picture'))
        closures = [references(BeautifulSoup(str(picture), "html.parser")) for picture in pictures]
        for picture in pictures:
            self.assertEqual([source["type"] for source in picture.select("source")], ["image/avif", "image/webp"])
        self.assertEqual(closures[0], closures[1], "built homepage must use the current generated event image references")
        self.assertIn(SOURCE, closures[1])
        self.assertEqual(len(closures[1]), 7)
        for path in closures[1]:
            with self.subTest(path=path):
                self.assertTrue((ROOT / path).is_file())

    def test_new_legal_original_without_manifest_uses_original_without_srcset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            replacement = "assets/events/replacement.jpg"
            target = root / replacement
            target.parent.mkdir(parents=True)
            shutil.copyfile(ROOT / ALTERNATE, target)
            image = {"src": replacement, "width": 1087, "height": 769, "alt": "替換活動原圖"}
            soup = BeautifulSoup(_responsive_event_picture(image, root), "html.parser")
            self.assertEqual(references(soup), {replacement})
            self.assertEqual(soup.select_one("img")["src"], replacement)
            self.assertFalse(soup.select("source, img[srcset]"))

    def test_same_filename_with_replaced_original_bytes_rejects_stale_variants(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            replacement = (ROOT / ALTERNATE).read_bytes()
            self._copy_approved_bundle(root, source_bytes=replacement)
            soup = BeautifulSoup(_responsive_event_picture(event_source()["images"][0], root), "html.parser")
            self.assertEqual(references(soup), {SOURCE})
            self.assertFalse(soup.select("source, img[srcset]"))

    def test_missing_or_tampered_variant_rejects_the_entire_srcset(self):
        cases = (
            ("missing", "assets/events/campaign-opening-20261031-landscape-800.avif", None),
            ("tampered", None, "assets/events/campaign-opening-20261031-landscape-480.webp"),
        )
        for label, missing, tampered in cases:
            with self.subTest(variant=label), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self._copy_approved_bundle(root, omit_variant=missing, tamper_variant=tampered)
                soup = BeautifulSoup(_responsive_event_picture(event_source()["images"][0], root), "html.parser")
                self.assertEqual(references(soup), {SOURCE})
                self.assertFalse(soup.select("source, img[srcset]"))

    def test_homepage_has_no_large_portrait_hero_and_keeps_the_portrait_assets(self):
        template = BeautifulSoup((ROOT / "templates/home-main.html").read_text(encoding="utf-8"), "html.parser")
        built = BeautifulSoup((ROOT / "index.html").read_text(encoding="utf-8"), "html.parser")
        for document in (template, built):
            self.assertFalse(document.select(".hero-portrait, .hero"))
        self.assertNotIn("home-portrait-", str(built.select_one("main")))
        # Existing public portrait assets stay available for other pages and rollback.
        for path in ("assets/home-portrait-384.webp", "assets/home-portrait-480.webp",
                     "assets/home-portrait-640.webp", "assets/legal/portrait.webp"):
            with self.subTest(path=path):
                self.assertTrue((ROOT / path).is_file())

    def test_home_portrait_webp_riff_headers_advertise_alpha_channels(self):
        paths = (
            "assets/home-portrait-384.webp",
            "assets/home-portrait-480.webp",
            "assets/home-portrait-640.webp",
            "assets/legal/portrait.webp",
        )
        for relative in paths:
            with self.subTest(path=relative):
                data = (ROOT / relative).read_bytes()
                self.assertEqual(data[:4], b"RIFF")
                self.assertEqual(data[8:12], b"WEBP")
                position = 12
                alpha_flags = []
                while position + 8 <= len(data):
                    chunk_type = data[position:position + 4]
                    chunk_size = int.from_bytes(data[position + 4:position + 8], "little")
                    chunk_start = position + 8
                    chunk_end = chunk_start + chunk_size
                    self.assertLessEqual(chunk_end, len(data))
                    if chunk_type == b"VP8X":
                        alpha_flags.append(data[chunk_start] & 0x10)
                    position = chunk_end + (chunk_size & 1)
                self.assertTrue(alpha_flags and any(alpha_flags), "WebP container must advertise its alpha channel")


if __name__ == "__main__":
    unittest.main()
