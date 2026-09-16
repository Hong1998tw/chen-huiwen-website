"""Mutation tests exercise the real CLI gates in an isolated disposable repository."""
import importlib.util, json, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('links', ROOT/'scripts/audit_external_links.py')
links=importlib.util.module_from_spec(spec);spec.loader.exec_module(links)

class LinkAuditTests(unittest.TestCase):
    def test_provider_failure_is_not_a_missing_page(self):
        for code in (None,401,403,429,500):self.assertEqual(links.classify(code)[0],'BLOCKED')
        for code in (404,410):self.assertEqual(links.classify(code)[0],'FAIL')
        self.assertEqual(links.classify(200)[0],'PASS')
    def test_structured_inventory_not_regex_fragments(self):
        with tempfile.TemporaryDirectory() as d:
            r=Path(d);(r/'data').mkdir()
            (r/'index.html').write_text('<a href="https://example.org/a?b=1&amp;c=2#x">source</a>')
            (r/'data/records.json').write_text(json.dumps({'sourceUrl':'https://example.org/a?b=1&c=2'}))
            self.assertEqual(set(links.inventory(r)),{'https://example.org/a?b=1&c=2'})

class QualityMutationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name)
        files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],cwd=ROOT,text=True).splitlines()
        for name in files:
            p=ROOT/name
            if p.is_file():
                dest=cls.root/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dest)
        for args in (['init','-q'],['add','.'],['-c','user.name=Quality fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic baseline']):
            subprocess.run(['git',*args],cwd=cls.root,check=True,stdout=subprocess.DEVNULL)
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()
    def setUp(self):
        subprocess.run(['git','restore','.'],cwd=self.root,check=True)
        # Only this isolated fixture's generated additions are removed.
        for p in self.root.glob('fixture-*'):p.unlink()
    def gate(self,script,*args):
        return subprocess.run([sys.executable,'scripts/'+script,*args],cwd=self.root,capture_output=True,text=True)
    def edit(self,name,old,new):
        p=self.root/name;s=p.read_text();self.assertIn(old,s);p.write_text(s.replace(old,new,1))
    def reject(self,script,expected,*args):
        result=self.gate(script,*args);self.assertNotEqual(result.returncode,0,result.stdout[-1000:]);self.assertIn(expected,result.stdout+result.stderr)
    def test_broken_link(self):
        self.edit('index.html','</main>','<a href="fixture-missing.html">fixture</a></main>')
        self.reject('validate_site.py','missing fixture-missing.html')
    def test_missing_metadata(self):
        self.edit('index.html','name="description"','name="fixture-description"')
        self.reject('validate_seo.py','description')
    def test_invalid_schema(self):
        p=self.root/'data/achievements.json';rows=json.loads(p.read_text());rows[0]['coordinates']=[200,300];p.write_text(json.dumps(rows))
        self.reject('validate_achievements.py','coordinate')
    def test_stable_id_disappears(self):
        p=self.root/'data/achievements.json';rows=json.loads(p.read_text());rows.pop(0);p.write_text(json.dumps(rows))
        self.reject('validate_achievements.py','ID','--baseline-ref','HEAD')
    def test_private_url_leak(self):
        domain='notion'+'.so';self.edit('index.html','</main>',f'<a href="https://{domain}/fixture-private">fixture</a></main>')
        self.reject('validate_site.py','non-allowlisted')
    def test_stale_generated_output(self):
        p=self.root/'data/achievements.json';rows=json.loads(p.read_text());rows[0]['title']='Fixture changed title';p.write_text(json.dumps(rows))
        self.reject('quality.py','GENERATED_STALE','--generated-only')
    def test_change_propagates_to_list_detail_search(self):
        p=self.root/'data/achievements.json';rows=json.loads(p.read_text());rows[0]['title']='Fixture synchronized title';p.write_text(json.dumps(rows))
        for builder in ('build_cases.py','build_search.py'):self.assertEqual(self.gate(builder).returncode,0)
        for name in ('achievements.html','achievement-'+rows[0]['id']+'.html','data/search-index.json'):
            self.assertIn('Fixture synchronized title',(self.root/name).read_text())
    def test_media_news_text_propagates_to_search(self):
        self.edit('news.html','</main>','<article><h2>Fixture uniquely searchable media event</h2></article></main>')
        self.assertEqual(self.gate('build_search.py').returncode,0)
        rows=json.loads((self.root/'data/search-index.json').read_text())['items']
        item=next(r for r in rows if r['url']=='news.html')
        self.assertIn('Fixture uniquely searchable media event',item['keywords'])
    def test_invalid_event_end(self):
        p=self.root/'data/events.json';d=json.loads(p.read_text());d['events'][0]['end']='2000-01-01T00:00:00+08:00';p.write_text(json.dumps(d))
        self.reject('build_events.py','end')
if __name__=='__main__':unittest.main()
