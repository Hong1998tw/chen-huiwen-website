"""llms.txt is generated from site data and only points at reviewed public pages."""
import json
from pathlib import Path
import re
import sys
import unittest
import xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import build_llms
import build_public

class LlmsTxtTests(unittest.TestCase):
    def test_committed_file_matches_the_generator(self):
        self.assertEqual((ROOT/'llms.txt').read_text(encoding='utf-8'),build_llms.render())
    def test_is_published_and_links_only_to_public_pages(self):
        self.assertIn('llms.txt',build_public.ROOT_FILES)
        sitemap={loc.text for loc in ET.parse(ROOT/'sitemap.xml').iter('{http://www.sitemaps.org/schemas/sitemap/0.9}loc')}
        links=re.findall(r'\]\((https://www\.huiwen\.tw/[^)]*)\)',build_llms.render())
        self.assertGreater(len(links),10)
        for link in links:
            name=link.removeprefix(build_llms.BASE)
            self.assertTrue(link in sitemap or name in build_public.ROOT_FILES,link)
    def test_identity_carries_the_recorded_cutoff(self):
        profile=json.loads((ROOT/'data/site-profile.json').read_text(encoding='utf-8'))
        text=build_llms.render()
        self.assertIn('資料截至 '+profile['identity']['recordAsOf'],text)
        self.assertIn(profile['identity']['sourceUrl'],text)

if __name__=='__main__':
    unittest.main()
