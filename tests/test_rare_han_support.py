"""The two original Han letters need pinned, licensed outlines, never system fallback."""
from hashlib import sha256
from bs4 import BeautifulSoup
import json
import re
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import rare_han_support as rare
import build_font_subsets as fonts
import build_artifact_page_fonts as artifact


def rare_css():
    return ('@font-face{font-family:"' + rare.FAMILY + '";src:url("/' + rare.FONT_REL
            + '") format("woff2");font-style:normal;font-weight:400;font-display:swap;'
            'unicode-range:U+5754,U+6DB3}')


class RareHanSupportTests(unittest.TestCase):
    def copy_inputs(self, root):
        for relative in rare.PUBLIC_FILES:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)

    def test_pinned_two_real_static_glyphs_and_complete_ofl_provenance(self):
        self.assertEqual(set(rare.verified_cmap(ROOT)), {0x5754, 0x6DB3})
        source = json.loads((ROOT / rare.PROVENANCE_REL).read_text())
        self.assertEqual(source['source']['sha256'], rare.SOURCE_SHA256)
        self.assertEqual(source['subset']['codepoints'], ['U+5754', 'U+6DB3'])
        self.assertEqual(source['subset']['weight'], 400)
        self.assertFalse(source['subset']['variable'])
        license_text = (ROOT / rare.LICENSE_REL).read_text()
        for phrase in ('SIL OPEN FONT LICENSE Version 1.1', 'PREAMBLE', 'DEFINITIONS',
                       'PERMISSION & CONDITIONS', 'TERMINATION', 'DISCLAIMER', 'Adobe'):
            self.assertIn(phrase, license_text)
        self.assertGreater(len(license_text), 4000)

    def test_original_source_hashes_are_unchanged(self):
        for path, digest in [(fonts.TC_SOURCE, '04b42051aaae0a7927a00fbf125b67c29f9c2eacc5f54e2c53073c0a59b8960f'),
                             (fonts.JP_SOURCE, 'd512874e3a52366928e3e0cdfac84201e26995a3dfd2b29aa46376bc65bb86b1')]:
            self.assertEqual(sha256(path.read_bytes()).hexdigest(), digest)

    def test_original_negative_api_remains_strict_and_jp_collection_stays_jp_only(self):
        with self.assertRaisesRegex(ValueError, 'FONT_MISSING_GLYPHS'):
            fonts.validate_corpus({0x5754}, {}, {})
        supplemental = rare.verified_cmap(ROOT)
        self.assertEqual(fonts.validate_corpus({0x5754, 0x6DB3, 0x3042}, {}, {0x3042: 'JP'}, supplemental), [0x3042])
        with self.assertRaisesRegex(ValueError, 'FONT_MISSING_GLYPHS'):
            fonts.validate_corpus({0x5754, 0x31350}, {}, {}, supplemental)

    def test_css_requires_exact_range_single_face_and_static_weight(self):
        self.assertEqual(rare.parse_face(ROOT, rare_css())[0], {0x5754, 0x6DB3})
        for css in [rare_css() + rare_css(), rare_css().replace('U+5754,U+6DB3', 'U+0000-FFFF'),
                    rare_css().replace('U+6DB3', 'U+4E2D'), rare_css().replace('font-weight:400', 'font-weight:250 900')]:
            with self.assertRaisesRegex(ValueError, 'FONT_RARE_SUPPORT'):
                rare.parse_face(ROOT, css)

    def test_css_cannot_claim_missing_unlicensed_or_tampered_source(self):
        for damaged in rare.PUBLIC_FILES:
            with self.subTest(damaged=damaged), tempfile.TemporaryDirectory() as name:
                root = Path(name); self.copy_inputs(root)
                (root / damaged).unlink()
                with self.assertRaisesRegex(ValueError, 'FONT_RARE_SUPPORT'):
                    rare.parse_face(root, rare_css())
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); self.copy_inputs(root)
            (root / rare.FONT_REL).write_bytes((root / rare.FONT_REL).read_bytes() + b'changed')
            with self.assertRaisesRegex(ValueError, 'HASH_MISMATCH'):
                rare.verified_cmap(root)

    def test_artifact_tracks_supplement_separately_and_absence_still_fails(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); self.copy_inputs(root)
            jp_path = root / artifact.JP_REL
            jp_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / artifact.JP_REL, jp_path)
            jp_css = '@font-face{font-family:"Huiwen Sans JP Support";src:url("/' + artifact.JP_REL + '");unicode-range:U+3042}'
            (root / 'styles.css').write_text(jp_css + rare_css())
            (root / 'record.html').write_text('<html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body><main>公開紀錄坔涳</main></body></html>')
            tc = fonts.cmap(ROOT / artifact.TC_REL)
            allowed, jp = artifact.parse_jp_face(root, jp_css + rare_css())
            self.assertNotIn(0x5754, jp)
            spec = artifact.extract_page_spec(root, 'record.html', tc, allowed, jp)
            self.assertEqual(spec['supplementFallback'], [0x5754, 0x6DB3])
            self.assertEqual(spec['jpFallback'], [])
            (root / 'styles.css').write_text(jp_css)
            with self.assertRaisesRegex(ValueError, 'UNCOVERED_REQUIRED_CHARACTERS'):
                artifact.extract_page_spec(root, 'record.html', tc, allowed, jp)
            with self.assertRaisesRegex(ValueError, 'JP_SUPPORT_FACE_MISSING_OR_AMBIGUOUS'):
                artifact.parse_jp_face(root, jp_css + jp_css)


    def test_public_record_dynamic_copy_and_fingerprinted_runtime_are_covered(self):
        source = b"window.publicRecordRuntime = true;"
        digest = sha256(source).hexdigest()
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); script = f'public-records.{digest}.js'
            (root / script).write_bytes(source)
            soup = BeautifulSoup(f'<article id="record-a"></article><script src="/{script}"></script>', 'html5lib')
            text = artifact.dynamic_ui_text('public-records.html', soup, root)
            for expected in ('顯示全部工作紀錄', '目前顯示', '可供查閱', '找不到這筆工作紀錄', '0123456789'):
                self.assertIn(expected, text)
            actual_runtime = (ROOT / 'public-records.js').read_text()
            messages = re.findall(r"['`]([^'`\n]*[\u4e00-\u9fff][^'`\n]*)['`]", actual_runtime)
            self.assertGreaterEqual(len(messages), 4)
            for message in messages:
                message = re.sub(r'\$\{[^}]*\}', '0123456789', message)
                self.assertTrue({ord(char) for char in message if fonts.required_font_character(ord(char))}.issubset({ord(char) for char in text}))
            self.assertNotIn('找不到這筆工作紀錄', artifact.dynamic_ui_text('other.html', BeautifulSoup(f'<script src="/{script}"></script>', 'html5lib'), root))
            (root / script).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'FILENAME_HASH_MISMATCH'):
                artifact.dynamic_ui_text('public-records.html', soup, root)


if __name__ == '__main__':
    unittest.main()
