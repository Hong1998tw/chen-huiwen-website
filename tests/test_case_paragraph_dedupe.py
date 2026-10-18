"""Contract for long duplicate paragraphs on the visible case page."""
from collections import defaultdict
import json
from pathlib import Path
import re
import sys
import unittest

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from case_paragraph_dedupe import ParagraphDeduper, normalize_paragraph


class CaseParagraphDedupeTests(unittest.TestCase):
    def test_repeated_long_paragraph_keeps_its_first_occurrence(self):
        text = '這是一段超過四十字、應保留首次出現的完整案件說明， 包含日期與辦理情形，並保留可核對的資料來源與辦理進度。'
        deduper = ParagraphDeduper()
        self.assertTrue(deduper.keep(text))
        self.assertFalse(deduper.keep('  這是一段超過四十字、應保留首次出現的完整案件說明，   \n包含日期與辦理情形，並保留可核對的資料來源與辦理進度。  '))

    def test_short_text_and_changed_qualifiers_are_preserved(self):
        short = '短段落維持原樣。'
        long_text = '這是一段超過四十字的案件說明，明確保留原始日期、辦理狀態與資料來源，並依主管機關公告核對實際執行期程。'
        deduper = ParagraphDeduper()
        self.assertTrue(deduper.keep(short))
        self.assertTrue(deduper.keep(short))
        self.assertTrue(deduper.keep(long_text))
        self.assertTrue(deduper.keep(long_text + '實際期程仍以主管機關正式公告為準。'))

    def test_normalization_only_collapses_unicode_and_whitespace(self):
        self.assertEqual(normalize_paragraph('Ａ  B\n C'), 'Ａ B C')
        deduper = ParagraphDeduper()
        self.assertTrue(deduper.keep('此段內容超過四十字，應檢查全形標點與後續限制條件是否完整保留，並保留來源及法律限制後才能對外說明。'))
        self.assertTrue(deduper.keep('此段內容超過四十字，應檢查全形標點與後續限制條件是否完整保留，並保留來源及法律限制後才能對外說明！'))

    def test_all_generated_case_pages_have_no_visible_long_duplicates(self):
        records = json.loads((ROOT / 'data/achievements-public.json').read_text())
        paths = [ROOT / f'achievement-{record["id"]}.html' for record in records]
        self.assertEqual(len(paths), len(records))
        duplicates = []
        for path in paths:
            soup = BeautifulSoup(path.read_text(), 'html.parser')
            groups = defaultdict(list)
            for paragraph in soup.select('main p'):
                # The print sheet is a separate, self-contained print artifact.
                if paragraph.find_parent(class_='case-print-sheet'):
                    continue
                text = re.sub(r'\s+', ' ', paragraph.get_text(' ', strip=True)).strip()
                if len(text) > 40:
                    groups[text].append(paragraph)
            duplicates.extend((path.name, text) for text, nodes in groups.items() if len(nodes) > 1)
            self.assertTrue(all(details.select('p') for details in soup.select('details.case-background')))
        self.assertEqual(duplicates, [], '\n'.join(f'{name}: {text[:120]}' for name, text in duplicates[:10]))

    def test_generated_page_keeps_first_copy_and_its_source_links(self):
        soup = BeautifulSoup((ROOT / 'achievement-after-school-care.html').read_text(), 'html.parser')
        text = '照顧名額、開課週數與每日結束時間能否配合家庭需要，是 2023 年議會紀錄提出的問題。即使有開班，假期中仍可能有照顧空窗。'
        self.assertIn(text, soup.select_one('#case-overview-summary').get_text(' ', strip=True))
        first_context_point = soup.select_one('#case-context .case-context-point')
        self.assertIsNone(first_context_point.find('p', string=text))
        self.assertTrue(first_context_point.select('.case-context-sources a'))
        latest = soup.select_one('.case-latest')
        self.assertIn('陳慧文於預算審查期間督促教育局落實特教課後照顧專案補助', latest.get_text(' ', strip=True))
        latest_event = next(node for node in soup.select('#case-history li') if '持續追蹤特教專班預算編列' in node.get_text(' ', strip=True))
        self.assertIsNone(latest_event.find('p'))


if __name__ == '__main__':
    unittest.main()
