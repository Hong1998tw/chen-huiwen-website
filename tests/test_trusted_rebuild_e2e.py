"""End-to-end trusted rebuilds: real publisher candidates, real base rebuild, exact comparison.

A throw-away Git repository holds a copy of the current checkout (including uncommitted
candidate code). Publisher candidates are materialized and committed there; the path guard's
verify_source_rebuild then rebuilds each source file with the base revision's own code.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import publish_from_cms as cms  # noqa: E402
import publish_from_notion as P  # noqa: E402
import publication_path_guard as G  # noqa: E402

DAILY = 'page-daily-trusted-fixture.html'


def git(repo, *args):
    return subprocess.run(['git', *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def daily_page():
    block = {'type': 'paragraph', 'title': '', 'text': '早上到市場和攤商聊天。', 'date': '', 'url': '', 'alt': '',
             'credit': '', 'address': '', 'publicAccessConfirmed': False}
    source = {**block, 'type': 'source', 'title': '陳慧文 Facebook', 'text': '', 'date': '2026-10-29',
              'url': 'https://www.facebook.com/hwcfs/posts/123'}
    return {'section': 'daily', 'title': '早市走一走', 'summary': '和攤商聊聊生意與環境。', 'updated': '2026-10-29',
            'eventStart': '', 'eventEnd': '',
            'seo': {'title': '早市走一走｜陳慧文', 'description': '和攤商聊聊生意與環境。',
                    'image': 'https://www.huiwen.tw/assets/site-share-20260909.png', 'imageAlt': '陳慧文・高雄市議員・鳳山區'},
            'blocks': [block, source]}


class TrustedRebuildEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.repo = Path(cls.tmp.name) / 'repo'
        files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'],
                                        cwd=ROOT, text=True).splitlines()
        for name in files:
            src = ROOT / name
            if src.is_file():
                dest = cls.repo / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dest)
        git(cls.repo, 'init', '-q')
        git(cls.repo, 'add', '.')
        git(cls.repo, '-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'base')
        cls.base = git(cls.repo, 'rev-parse', 'HEAD')
        # The fixture must exercise this checkout's candidate code, not an older commit.
        for path in ('scripts/latest_info.py', 'scripts/publication_path_guard.py', 'scripts/build_home.py'):
            assert (cls.repo / path).read_bytes() == (ROOT / path).read_bytes(), path

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def commit(self, parent, candidate, message):
        git(self.repo, 'checkout', '-q', '-f', parent)
        files = P.materialize(candidate, self.repo, quality=False)
        git(self.repo, 'add', '-A')
        git(self.repo, '-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', message)
        return git(self.repo, 'rev-parse', 'HEAD'), files

    def changed(self, base, head):
        return [line for line in git(self.repo, 'diff', '--name-only', '--no-renames', base, head).splitlines() if line]

    def tamper(self, head, path, data):
        git(self.repo, 'checkout', '-q', '-f', head)
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data(target.read_bytes() if target.exists() else b''))
        git(self.repo, 'add', '-A')
        git(self.repo, '-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'tamper ' + path)
        return git(self.repo, 'rev-parse', 'HEAD')

    def assert_rejected(self, domain, base, head):
        with self.assertRaises(ValueError):
            G.verify_source_rebuild(domain, base, head, self.changed(base, head), repo=self.repo, python=sys.executable)

    def test_event_publication_rebuilds_exactly_and_rejects_tampering(self):
        events = P.main_text(self.repo, 'events')
        row = {'pageId': 'trusted-event', 'fields': {
            'name': '鳳山里民座談會', 'start': '2026-12-05T10:00:00+08:00', 'end': '2026-12-05T11:30:00+08:00',
            'location': '高雄市鳳山區光復路二段132號', 'content': '公開座談說明', 'registration': '請電話報名',
            'sourceUrl': 'https://www.kcc.gov.tw/', 'verifiedAt': '2026-11-01', 'status': '排定', 'changeNote': '',
            'updatedAt': '', 'reviewDueAt': ''},
            'system': {'siteId': None, 'syncedHash': None, 'requestPublish': True, 'publishedAt': '2026-11-01T02:00:00Z'}}
        candidate = P.prepare_event(row, events)
        self.assertEqual(candidate.errors, [])
        head, files = self.commit(self.base, candidate, 'event')
        changed = self.changed(self.base, head)
        self.assertIn('data/latest-info.json', changed)
        self.assertIn('index.html', changed)
        generated = G.verify_source_rebuild('events', self.base, head, changed, repo=self.repo, python=sys.executable)
        ok, reason = G.evaluate(candidate.branch, 'publisher[bot]', 'Bot', 'publisher[bot]', changed, generated)
        self.assertTrue(ok, reason)
        # Tampered generated outputs never match the trusted rebuild.
        self.assert_rejected('events', self.base, self.tamper(head, 'index.html', lambda b: b.replace(b'</main>', b'<p>x</p></main>', 1)))
        self.assert_rejected('events', self.base, self.tamper(head, 'data/latest-info.json', lambda b: b.replace(b'"pinned": []', b'"pinned": ["x"]', 1)))
        self.assert_rejected('events', self.base, self.tamper(
            head, 'assets/fonts/huiwen-site-sans/generated/huiwen-index-core-000000000000.woff2', lambda b: b'wOF2fixture'))
        # The source file itself is required.
        with self.assertRaises(ValueError):
            G.verify_source_rebuild('events', self.base, head, [p for p in changed if p != 'data/events.json'], repo=self.repo, python=sys.executable)

    def test_daily_page_publish_unpublish_and_restore_follow_the_trusted_build(self):
        item = {'id': 'trusted-daily', 'path': DAILY, 'version': 1, 'base_commit': self.base}
        git(self.repo, 'checkout', '-q', '-f', self.base)
        publish = cms.editorial_candidate(item, self.repo, {'fields': {}, 'editorial': daily_page(), 'editorialBase': None})
        published, _ = self.commit(self.base, publish, 'daily publish')
        changed = self.changed(self.base, published)
        self.assertTrue({DAILY, 'index.html', 'data/latest-info.json', 'data/editorial-pages.json'} <= set(changed))
        generated = G.verify_source_rebuild('editorial-page', self.base, published, changed, repo=self.repo, python=sys.executable)
        branch = f'notion-publish/editorial-page/{DAILY}-1234abcd'
        self.assertTrue(G.evaluate(branch, 'publisher[bot]', 'Bot', 'publisher[bot]', changed, generated)[0])
        feed = json.loads((self.repo / 'data/latest-info.json').read_text(encoding='utf-8'))
        self.assertEqual(feed['counts']['daily'], 1)

        # A pinned daily item is not unpublished by page-copy: two steps, clear message, nothing written.
        git(self.repo, 'checkout', '-q', '-f', published)
        config_path = self.repo / 'data/civic-home.json'
        original = config_path.read_text(encoding='utf-8')
        config_path.write_text(json.dumps({**json.loads(original), 'latestPinned': [DAILY[:-5]]}, ensure_ascii=False), encoding='utf-8')
        unpublish_item = {'id': 'trusted-unpublish', 'path': DAILY, 'operation': 'unpublish', 'version': 2,
                          'base_commit': published, 'payload': json.dumps({'fields': {}})}
        with self.assertRaises(P.PublishError) as error:
            cms.page_candidate(unpublish_item, self.repo)
        self.assertEqual(error.exception.code, 'VALIDATION')
        self.assertIn('取消置頂', error.exception.plain())
        config_path.write_text(original, encoding='utf-8')

        unpublish = cms.page_candidate(unpublish_item, self.repo)
        self.assertEqual(unpublish.domain, 'page-copy')
        unpublished, _ = self.commit(published, unpublish, 'daily unpublish')
        changed = self.changed(published, unpublished)
        self.assertTrue({'data/page-content.json', 'index.html', 'data/latest-info.json'} <= set(changed))
        generated = G.verify_source_rebuild('page-copy', published, unpublished, changed, repo=self.repo, python=sys.executable)
        page_branch = f'notion-publish/page-copy/{DAILY}-1234abcd'
        self.assertTrue(G.evaluate(page_branch, 'publisher[bot]', 'Bot', 'publisher[bot]', changed, generated)[0])
        self.assertEqual(json.loads((self.repo / 'data/latest-info.json').read_text(encoding='utf-8'))['counts']['daily'], 0)
        self.assert_rejected('page-copy', published, self.tamper(
            unpublished, 'data/latest-info.json', lambda b: b.replace(b'"daily": 0', b'"daily": 1', 1)))
        self.assert_rejected('page-copy', published, self.tamper(
            unpublished, 'data/civic-home.json', lambda b: b.replace(b'"reading"', b'"latestPinned": [], "reading"', 1)))

        # Restore is accepted by the same allowlist (dry-run materialize includes the path check).
        git(self.repo, 'checkout', '-q', '-f', unpublished)
        restore = cms.page_candidate({**unpublish_item, 'id': 'trusted-restore', 'operation': 'restore', 'version': 3,
                                      'base_commit': unpublished}, self.repo)
        restored, files = self.commit(unpublished, restore, 'daily restore')
        self.assertIn('data/latest-info.json', files)
        self.assertEqual(json.loads((self.repo / 'data/latest-info.json').read_text(encoding='utf-8'))['counts']['daily'], 1)


if __name__ == '__main__':
    unittest.main()
