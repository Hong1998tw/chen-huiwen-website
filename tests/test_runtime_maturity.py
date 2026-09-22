"""Published election index must retain useful content without client-side requests."""
import json,sys,unittest,hashlib,tempfile,shutil,re
from pathlib import Path
from bs4 import BeautifulSoup
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import build_election_page as build
import build_shared
class RuntimeMaturityTests(unittest.TestCase):
    def test_public_scope_and_static_search_index(self):
        public=json.loads((ROOT/'data/achievements-public.json').read_text())
        page=BeautifulSoup((ROOT/'election.html').read_text(),'html.parser')
        expected=build.tracking_items(public)
        cards=page.select('#campaign-tracking .campaign-tracking-card')
        self.assertEqual(len(cards),len(expected))
        self.assertGreater(len(cards),8)
        links={card.select_one('h3 a')['href'] for card in cards}
        self.assertEqual(links,{f'achievement-{item["id"]}.html' for item in expected})
        self.assertIn('文德國小',page.select_one('#campaign-tracking').get_text())
        self.assertNotIn('data/achievements.json',(ROOT/'election.js').read_text())
    def test_event_order_uses_events_not_edit_dates(self):
        data=[{'id':'old','status':'持續追蹤','sources':[{}],'history':[{'date':'2001-01-01'}],'updated':'2099-01-01'}, {'id':'new','status':'持續追蹤','sources':[{}],'history':[{'date':'2026-01-01'}],'updated':'2000-01-01'}]
        self.assertEqual([i['id'] for i in build.tracking_items(data)],['new','old'])
    def test_static_platform_and_schedule_not_empty(self):
        page=BeautifulSoup((ROOT/'election.html').read_text(),'html.parser')
        self.assertEqual(len(page.select('#campaign-platforms li')),13)
        self.assertGreater(len(page.select('#campaign-events article')),0)
        self.assertIsNone(page.select_one('.campaign-hero-side'))
    def test_dynamic_assets_and_enclosing_site_hash_follow_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for folder in ('data','templates'):(root/folder).mkdir()
            for name in ('site.js','digital.js','digital.css','civic.js','civic.css','index.html','election.html','data/navigation.json','templates/site-header.html','templates/site-footer.html'):
                shutil.copyfile(ROOT/name,root/name)
            for asset in ('digital.js','digital.css'):
                with (root/asset).open('a') as file:file.write('\n/* changed dependency fixture */\n')
            build_shared.build(root)
            site=(root/'site.js').read_text()
            for constant,asset in [('DIGITAL_SCRIPT_VERSION','digital.js'),('DIGITAL_STYLE_VERSION','digital.css')]:
                expected=hashlib.sha256((root/asset).read_bytes()).hexdigest()[:12]
                self.assertIn(f"const {constant} = '{expected}'",site)
                self.assertIn(f'{asset}?v={expected}',(root/'index.html').read_text())
            site_hash=hashlib.sha256((root/'site.js').read_bytes()).hexdigest()[:12]
            for page in ('index.html','election.html'):
                self.assertIn('site.js?v='+site_hash,(root/page).read_text())
            first={name:(root/name).read_bytes() for name in ('site.js','index.html','election.html')}
            build_shared.build(root)
            self.assertEqual(first,{name:(root/name).read_bytes() for name in first})
    def test_offline_response_is_its_own_document(self):
        page=BeautifulSoup((ROOT/'offline.html').read_text(),'html.parser')
        self.assertIn('這一頁尚未儲存',page.h1.get_text())
        self.assertEqual(page.select_one('meta[name=robots]')['content'],'noindex')
        self.assertFalse(page.select('script[src],link[rel=stylesheet]'))
if __name__=='__main__':unittest.main()
