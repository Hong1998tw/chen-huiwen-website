import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from build_search import build
from page_copy import digest


class SearchIndexTests(unittest.TestCase):
    def test_indexes_published_copy_edits_and_skips_unpublished_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / 'data'
            data.mkdir()
            (data / 'achievements.json').write_text('[]')
            (data / 'service-search.json').write_text(json.dumps([
                {'title': '公開頁面捷徑', 'url': 'published.html#contact', 'description': '可用服務'},
                {'title': '下架服務捷徑', 'url': 'service.html#contact', 'description': '不得搜尋'},
            ], ensure_ascii=False))
            (data / 'page-content.json').write_text(json.dumps({
                'schemaVersion': 1,
                'pages': {
                    'published.html': {
                        'edits': {
                            'main>h1:nth-of-type(1)': {'sourceHash': digest('原始標題'), 'value': '更新後的正式標題'},
                            'main>p:nth-of-type(1)': {'sourceHash': digest('原始公開說明'), 'value': '可搜尋的正式內容更新'},
                        }
                    },
                    'unpublished.html': {'status': 'unpublished'},
                    'deleted.html': {'status': 'deleted'},
                    'service.html': {'status': 'unpublished'},
                },
            }, ensure_ascii=False))
            template = '<!doctype html><html><head><title>測試</title><meta name="description" content="描述"></head><body><main><h1>原始標題</h1><p>原始公開說明</p></main></body></html>'
            (root / 'published.html').write_text(template)
            (root / 'unpublished.html').write_text(template.replace('原始標題', '下架頁面不得搜尋'))
            (root / 'deleted.html').write_text(template.replace('原始標題', '刪除頁面不得搜尋'))
            (root / 'service.html').write_text(template.replace('原始標題', '下架服務頁不得搜尋'))

            result = build(root)

            entry = next(item for item in result['items'] if item['url'] == 'published.html')
            self.assertEqual(entry['title'], '更新後的正式標題')
            self.assertIn('可搜尋的正式內容更新', entry['keywords'])
            self.assertNotIn('unpublished.html', {item['url'] for item in result['items']})
            self.assertNotIn('deleted.html', {item['url'] for item in result['items']})
            service_titles = {item['title'] for item in result['items']}
            self.assertIn('公開頁面捷徑', service_titles)
            self.assertNotIn('下架服務捷徑', service_titles)


if __name__ == '__main__':
    unittest.main()
