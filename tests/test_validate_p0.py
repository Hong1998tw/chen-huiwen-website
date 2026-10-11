import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from validate_p0 import expected_public_achievement_urls, expected_social_metadata


class ValidateP0Tests(unittest.TestCase):
    def test_search_expectation_respects_page_lifecycle_and_noindex(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'achievement-live.html').write_text('<main><h1>公開</h1></main>')
            (root / 'achievement-hidden.html').write_text('<main><h1>下架</h1></main>')
            (root / 'achievement-noindex.html').write_text('<meta name="robots" content="noindex"><main><h1>不索引</h1></main>')
            public = [
                {'id': 'live'}, {'id': 'hidden'}, {'id': 'noindex'},
            ]
            states = {'achievement-hidden.html': {'status': 'deleted'}}

            self.assertEqual(
                expected_public_achievement_urls(public, root, states),
                {'achievement-live.html'},
            )

    def test_social_image_expectation_uses_validated_page_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / 'assets' / 'shares' / 'custom.webp'
            image.parent.mkdir(parents=True)
            image.write_bytes(b'image fixture')
            seo = {
                'title': '測試頁面',
                'description': '測試描述',
                'image': 'https://www.huiwen.tw/assets/shares/custom.webp',
                'imageAlt': '自訂分享圖替代文字',
            }

            self.assertEqual(
                expected_social_metadata(root, 'achievement-live', {
                    'achievement-live.html': {'seo': seo},
                }),
                (seo['image'], seo['imageAlt']),
            )

    def test_social_image_expectation_keeps_generated_png_default(self):
        root = Path(tempfile.gettempdir())
        self.assertEqual(
            expected_social_metadata(root, 'achievement-live', {}),
            ('https://www.huiwen.tw/assets/og/achievement-live.png', None),
        )


if __name__ == '__main__':
    unittest.main()
