"""Pilot publisher contract tests. No network, no Notion, no GitHub: fakes only; data read from current main."""
import contextlib, copy, io, json, os, re, shutil, subprocess, sys, tempfile, unittest, unittest.mock, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_events  # noqa: E402
import build_service  # noqa: E402
import publish_from_notion as P  # noqa: E402
from publication_path_guard import evaluate as guard  # noqa: E402

EVENTS_TEXT = (ROOT / 'data/events.json').read_text(encoding='utf-8')
LEGAL_TEXT = (ROOT / 'data/legal-schedule.json').read_text(encoding='utf-8')
GOLDEN_TEXT = (ROOT / 'tests/fixtures/pilot/events-golden.json').read_text(encoding='utf-8')
CANARY_CONTENT = 'CANARY-CONTENT-7f3a 私密草稿內文'
CANARY_SECRET = 'gh' + 's_' + 'CANARYSECRET' + '0' * 28  # assembled at runtime so secret scanners stay quiet


def new_event_row(page_id='page-new', **overrides):
    fields = {'name': '里民健康講座', 'start': '2026-10-20T19:00:00+08:00', 'end': '2026-10-20T20:30:00+08:00',
              'content': '第一段說明\n第二段說明', 'registration': '請電話報名', 'sourceUrl': 'https://www.kcg.gov.tw/news/1',
              'verifiedAt': '2026-09-23', 'status': '排定', 'changeNote': '', 'updatedAt': '2026-09-23',
              'reviewDueAt': '2026-10-15'}
    fields.update(overrides)
    return {'pageId': page_id, 'fields': fields, 'system': {}}


def rows_from(text):
    """Rows as imported from a given events file (same mapping as export-rows)."""
    zh = {'scheduled': '排定', 'rescheduled': '改期', 'cancelled': '取消'}
    out = []
    for e in json.loads(text)['events']:
        fields = {k: e.get(k) for k in P.EVENT_FIELDS}
        fields['status'] = zh[e.get('status', 'scheduled')]
        out.append({'pageId': 'p-' + e['id'], 'fields': fields,
                    'system': {'siteId': e['id'], 'syncedHash': P.sha(e), 'baseHash': P.sha(e)}})
    return out


def legal_row(text=LEGAL_TEXT, **overrides):
    d = json.loads(text)
    fields = {k: d.get(k) for k in P.LEGAL_PROPS}
    fields.update(overrides)
    return {'pageId': 'legal-page', 'fields': fields, 'sessions': copy.deepcopy(d['sessions']), 'system': {}}


def approve(row, cand):
    row = copy.deepcopy(row)
    row['system'].update(candidateDigest=cand.digest, baseHash=cand.base_hash, requestPublish=True)
    if cand.domain == 'events':
        row['system']['siteId'] = cand.record_key
    return row


class Fake:
    """Scripted GitHub transport: list of (method, regex, response|callable|exception)."""

    def __init__(self, routes):
        self.routes, self.calls = list(routes), []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append((method, url))
        for i, (m, pattern, resp) in enumerate(self.routes):
            if m == method and re.search(pattern, url):
                if isinstance(resp, list):  # sequential responses
                    resp = resp.pop(0) if len(resp) > 1 else resp[0]
                if isinstance(resp, Exception):
                    raise resp
                if callable(resp):
                    resp = resp()
                status, hdrs, obj = resp
                return status, hdrs, (obj if isinstance(obj, bytes) else json.dumps(obj).encode() if obj is not None else b'')
        return 404, {}, b'{}'

    def count(self, method, pattern):
        return sum(1 for m, u in self.calls if m == method and re.search(pattern, u))


FULL_RULES = [
    {'type': 'pull_request', 'parameters': {'required_approving_review_count': 1, 'dismiss_stale_reviews_on_push': True,
                                            'require_last_push_approval': True}},
    {'type': 'required_status_checks', 'parameters': {'required_status_checks': [{'context': c} for c in P.REQUIRED_CHECKS]}},
    {'type': 'non_fast_forward'}, {'type': 'deletion'}]

SINGLE_MAINTAINER_RULES = [
    {'type': 'pull_request', 'parameters': {'required_approving_review_count': 0, 'dismiss_stale_reviews_on_push': True,
                                            'require_last_push_approval': False}},
    {'type': 'required_status_checks', 'parameters': {'required_status_checks': [{'context': c} for c in P.REQUIRED_CHECKS]}},
    {'type': 'non_fast_forward'}, {'type': 'deletion'}]


class UnitTests(unittest.TestCase):
    def test_canonicalization_nfc_crlf_and_digest(self):
        a, e1 = P.normalize_event(new_event_row(content='Cafe\u0301\r\n第二段  ')['fields'])
        b, e2 = P.normalize_event(new_event_row(content='Caf\u00e9\n第二段')['fields'])
        self.assertEqual((e1, e2), ([], []))
        self.assertEqual(a, b)
        self.assertEqual(P.candidate_digest('events', 'x', 2, 'absent', a), P.candidate_digest('events', 'x', 2, 'absent', b))
        c, _ = P.normalize_event(new_event_row(content='Café\n第二段。')['fields'])
        self.assertNotEqual(P.candidate_digest('events', 'x', 2, 'absent', a), P.candidate_digest('events', 'x', 2, 'absent', c))

    def test_timezone_normalized_to_taipei_and_time_required(self):
        m, errors = P.normalize_event(new_event_row(start='2026-10-20T11:00:00.000Z', end='2026-10-20T12:30:00Z')['fields'])
        self.assertEqual(errors, [])
        self.assertEqual((m['start'], m['end']), ('2026-10-20T19:00:00+08:00', '2026-10-20T20:30:00+08:00'))
        _, errors = P.normalize_event(new_event_row(start='2026-10-20')['fields'])
        self.assertTrue(any('需包含時刻' in e for e in errors))
        _, errors = P.normalize_event(new_event_row(end='2026-10-20T18:00:00+08:00')['fields'])
        self.assertTrue(any('晚於開始' in e for e in errors))

    def test_stable_id_patch_keeps_other_records_byte_identical(self):
        rows = rows_from(GOLDEN_TEXT)
        row = rows[1]
        row['fields']['name'] = '改期測試活動（更新）'
        cand = P.prepare_event(row, GOLDEN_TEXT)
        self.assertEqual(cand.errors, [])
        old, new = json.loads(GOLDEN_TEXT)['events'], json.loads(cand.new_text)['events']
        self.assertEqual([e['id'] for e in old], [e['id'] for e in new])
        self.assertEqual((old[0], old[2]), (new[0], new[2]))
        self.assertEqual(list(old[1]), list(new[1]))  # key order preserved

    def test_unknown_fields_preserved_round_trip(self):
        row = rows_from(GOLDEN_TEXT)[2]
        row['fields']['registration'] = '改為線上報名'
        cand = P.prepare_event(row, GOLDEN_TEXT)
        rec = json.loads(cand.new_text)['events'][2]
        self.assertEqual(rec['location'], '鳳山區公所 3 樓')
        self.assertEqual(rec['registrationUrl'], 'https://example.gov.tw/register')
        self.assertEqual(rec['x-editorNote'], '未知但合法的欄位必須原樣保留')
        self.assertIn('location', cand.preview)
        self.assertEqual(json.loads(cand.new_text)['x-fixtureOrigin'], json.loads(GOLDEN_TEXT)['x-fixtureOrigin'])

    def test_unknown_schema_version_fails_closed(self):
        for version in (3, None, '2'):
            text = P.dump_events({**json.loads(EVENTS_TEXT), 'schemaVersion': version})
            with self.assertRaises(P.PublishError) as ctx:
                P.prepare_event(new_event_row(), text)
            self.assertEqual(ctx.exception.code, 'UNKNOWN_SCHEMA')
        with self.assertRaises(P.PublishError) as ctx:
            P.prepare_legal(legal_row(), json.dumps({**json.loads(LEGAL_TEXT), 'schemaVersion': 9}))
        self.assertEqual(ctx.exception.code, 'UNKNOWN_SCHEMA')

    def test_reformatted_file_fails_closed_instead_of_rewriting(self):
        with self.assertRaises(P.PublishError) as ctx:
            P.prepare_event(new_event_row(), json.dumps(json.loads(EVENTS_TEXT), ensure_ascii=False, indent=4))
        self.assertEqual(ctx.exception.code, 'FORMAT_DRIFT')

    def test_idempotent_candidate_and_branch(self):
        a, b = P.prepare_event(new_event_row(), EVENTS_TEXT), P.prepare_event(new_event_row(), EVENTS_TEXT)
        self.assertEqual((a.digest, a.new_text, a.branch), (b.digest, b.new_text, b.branch))
        self.assertTrue(a.branch.startswith('notion-publish/events/event-20261020-'))


class GoldenFixtureTests(unittest.TestCase):
    def test_current_main_round_trips_byte_identically(self):
        report = P.shadow_compare(ROOT, P.export_rows(ROOT))
        self.assertTrue(report and all(r['identical'] for r in report), report)

    def test_golden_fixture_is_valid_for_current_builder_and_lossless(self):
        build_events.render_events(json.loads(GOLDEN_TEXT)['events'])
        for row in rows_from(GOLDEN_TEXT):
            cand = P.prepare_event(row, GOLDEN_TEXT)
            self.assertEqual((cand.errors, cand.changed), ([], False), row['pageId'])

    def test_builder_supported_optional_fields_survive_and_render(self):
        row = rows_from(GOLDEN_TEXT)[2]
        row['fields']['name'] = '含地點與報名連結的活動（修正）'
        html = build_events.render_events(json.loads(P.prepare_event(row, GOLDEN_TEXT).new_text)['events'])
        self.assertIn('鳳山區公所 3 樓', html)
        self.assertIn('https://example.gov.tw/register', html)

    def test_new_event_matches_current_key_convention(self):
        cand = P.prepare_event(new_event_row(), EVENTS_TEXT)
        new = json.loads(cand.new_text)['events'][-1]
        self.assertEqual(list(new), list(json.loads(EVENTS_TEXT)['events'][0]) if json.loads(EVENTS_TEXT)['events'] else list(P.NEW_EVENT_ORDER))
        self.assertIsNone(new['previousSchedule'])

    def test_reschedule_carries_previous_time_and_cancel_hides_calls_to_action(self):
        row = rows_from(GOLDEN_TEXT)[0]
        row['fields'].update(status='改期', changeNote='主辦單位公告改期', start='2026-10-09T16:00:00+08:00',
                             end='2026-10-09T16:50:00+08:00')
        rec = json.loads(P.prepare_event(row, GOLDEN_TEXT).new_text)['events'][0]
        self.assertEqual(rec['previousSchedule'], {'start': '2026-10-08T16:00:00+08:00', 'end': '2026-10-08T16:50:00+08:00'})
        row = rows_from(GOLDEN_TEXT)[0]
        row['fields'].update(status='取消', changeNote='活動取消')
        html = build_events.render_events([json.loads(P.prepare_event(row, GOLDEN_TEXT).new_text)['events'][0]])
        self.assertNotIn('calendar.google', html)
        self.assertIn('本活動已取消', html)
        new_rescheduled = new_event_row(status='改期', changeNote='x')
        self.assertTrue(any('改期只能用於' in e for e in P.prepare_event(new_rescheduled, EVENTS_TEXT).errors))

    def test_legal_schedule_round_trip_and_month_rules(self):
        self.assertFalse(P.prepare_legal(legal_row(), LEGAL_TEXT).changed)
        row = legal_row(month='2026-10', observedAt='2026-09-26', nextReviewAt='2026-10-25', sourceTitle='10月圖卡')
        row['sessions'] = [{'date': '2026-10-02', 'start': '19:30', 'end': '21:00'},
                           {'date': '2026-10-01', 'start': '16:30', 'end': '18:00'}]
        cand = P.prepare_legal(row, LEGAL_TEXT)
        self.assertEqual(cand.errors, [])
        data = json.loads(cand.new_text)
        self.assertEqual((data['validThrough'], [s['date'] for s in data['sessions']]), ('2026-10-31', ['2026-10-01', '2026-10-02']))
        self.assertIn('將取代網站目前 2026-09', cand.preview)
        self.assertEqual(P.dump_legal(data), cand.new_text)
        bad = legal_row(month='2026-10', observedAt='2026-09-26', nextReviewAt='2026-10-25')
        bad['sessions'] = [{'date': '2026-11-01', 'start': '19:30', 'end': '21:00'},
                           {'date': '2026-10-03', 'start': '21:00', 'end': '19:00'},
                           {'date': '2026-10-04', 'start': '10:00', 'end': '11:00'},
                           {'date': '2026-10-04', 'start': '14:00', 'end': '15:00'}]
        errors = P.prepare_legal(bad, LEGAL_TEXT).errors
        for needle in ('不在 2026-10 月內', '開始時間必須早於結束時間', '同一天只能有一個時段'):
            self.assertTrue(any(needle in e for e in errors), (needle, errors))


class ApprovalBindingTests(unittest.TestCase):
    def test_one_click_snapshot_matches_when_unchanged(self):
        row = new_event_row()
        row['system']['requestPublish'] = True
        cand = P.prepare_event(row, EVENTS_TEXT)
        self.assertTrue(P.verify_publish_snapshot(cand, row, EVENTS_TEXT))

    def test_one_character_edit_during_publish_is_rejected(self):
        row = new_event_row()
        row['system']['requestPublish'] = True
        cand = P.prepare_event(row, EVENTS_TEXT)
        changed = copy.deepcopy(row)
        changed['fields']['content'] += '。'
        with self.assertRaises(P.PublishError) as ctx:
            P.verify_publish_snapshot(cand, changed, EVENTS_TEXT)
        self.assertEqual(ctx.exception.code, 'PUBLISH_CHANGED_DURING_RUN')

    def test_cancelled_publish_is_rejected(self):
        row = new_event_row()
        row['system']['requestPublish'] = True
        cand = P.prepare_event(row, EVENTS_TEXT)
        row['system']['requestPublish'] = False
        with self.assertRaises(P.PublishError) as ctx:
            P.verify_publish_snapshot(cand, row, EVENTS_TEXT)
        self.assertEqual(ctx.exception.code, 'PUBLISH_CHANGED_DURING_RUN')

    def test_git_newer_still_fails_closed(self):
        rows = rows_from(EVENTS_TEXT)
        if rows:
            data = json.loads(EVENTS_TEXT)
            data['events'][0]['content'] += '（工程直接修改）'
            with self.assertRaises(P.PublishError) as ctx:
                P.prepare_event(rows[0], P.dump_events(data))
            self.assertEqual(ctx.exception.code, 'GITHUB_NEWER')

    def test_status_writeback_does_not_change_digest(self):
        source = P.FileSource.__new__(P.FileSource)
        row = new_event_row()
        source.data, source.writes = {'events': [copy.deepcopy(row)]}, []
        before = P.prepare_event(row, EVENTS_TEXT).digest
        source.write('page-new', state='發布中', result='處理中', lastRun='2026-09-23T10:00:00+08:00', layers='x', prUrl=None)
        after_row = source.fresh('events', 'page-new')
        self.assertEqual(P.prepare_event({**after_row, 'system': {**after_row['system'], 'siteId': None}}, EVENTS_TEXT).digest, before)


class GitHubBehaviourTests(unittest.TestCase):
    def gh(self, routes):
        fake = Fake(routes)
        return P.GitHub('token', 'Hong1998tw/chen-huiwen-website', transport=fake, sleep=lambda s: None), fake

    def cand(self):
        return P.prepare_event(new_event_row(), EVENTS_TEXT)

    def test_duplicate_trigger_creates_one_pr(self):
        state = {'pr': None}
        def created():
            state['pr'] = {'number': 90, 'state': 'open', 'merged_at': None, 'html_url': 'https://github.com/x/pull/90'}
            return 201, {}, state['pr']
        gh, fake = self.gh([('GET', r'/pulls\?', lambda: (200, {}, [state['pr']] if state['pr'] else [])),
                            ('GET', r'/git/ref/heads/', (404, {}, {})), ('POST', r'/pulls$', created)])
        pushes = []
        first = P.ensure_pull_request(gh, self.cand(), lambda: pushes.append(1), 't', 'b')
        second = P.ensure_pull_request(gh, self.cand(), lambda: pushes.append(1), 't', 'b')
        self.assertEqual((first[0], second[0], len(pushes), fake.count('POST', r'/pulls$')), ('CREATED', 'ALREADY_OPEN', 1, 1))

    def test_timeout_after_remote_success_reconciles_without_resend(self):
        pr = {'number': 91, 'state': 'open', 'merged_at': None}
        gh, fake = self.gh([('GET', r'/pulls\?', [(200, {}, []), (200, {}, [pr])]), ('GET', r'/git/ref/heads/', (404, {}, {})),
                            ('POST', r'/pulls$', TimeoutError('read timeout'))])
        outcome, got = P.ensure_pull_request(gh, self.cand(), lambda: None, 't', 'b')
        self.assertEqual((outcome, got['number'], fake.count('POST', r'/pulls$')), ('RECONCILED', 91, 1))

    def test_pr_already_exists_422_returns_existing(self):
        pr = {'number': 92, 'state': 'open', 'merged_at': None}
        gh, _ = self.gh([('GET', r'/pulls\?', [(200, {}, []), (200, {}, [pr])]), ('GET', r'/git/ref/heads/', (404, {}, {})),
                         ('POST', r'/pulls$', (422, {}, {'message': 'A pull request already exists'}))])
        self.assertEqual(P.ensure_pull_request(gh, self.cand(), lambda: None, 't', 'b')[1]['number'], 92)

    def test_existing_branch_with_other_content_fails_closed(self):
        import base64
        other = base64.b64encode(EVENTS_TEXT.encode()).decode()
        gh, _ = self.gh([('GET', r'/pulls\?', (200, {}, [])), ('GET', r'/git/ref/heads/', (200, {}, {'object': {'sha': 'abc'}})),
                         ('GET', r'/contents/', (200, {}, {'content': other}))])
        with self.assertRaises(P.PublishError) as ctx:
            P.ensure_pull_request(gh, self.cand(), lambda: None, 't', 'b')
        self.assertEqual(ctx.exception.code, 'BRANCH_DIVERGED')

    def test_closed_pr_requires_reapproval(self):
        gh, _ = self.gh([('GET', r'/pulls\?', (200, {}, [{'number': 5, 'state': 'closed', 'merged_at': None}]))])
        with self.assertRaises(P.PublishError) as ctx:
            P.ensure_pull_request(gh, self.cand(), lambda: None, 't', 'b')
        self.assertEqual(ctx.exception.code, 'PR_CLOSED')

    def test_rate_limit_backs_off_then_reports_busy(self):
        limited = (403, {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '0'}, {'message': 'rate limit'})
        gh, fake = self.gh([('GET', r'/git/ref/heads/main', [limited, (200, {}, {'object': {'sha': 'x'}})])])
        self.assertEqual(gh.branch_sha('main'), 'x')
        gh, _ = self.gh([('GET', r'/git/ref/', (429, {'Retry-After': '1'}, {}))])
        with self.assertRaises(P.PublishError) as ctx:
            gh.branch_sha('main')
        self.assertEqual((ctx.exception.code, ctx.exception.retryable), ('GITHUB_BUSY', True))

    def test_direct_merge_endpoints_are_refused(self):
        gh, fake = self.gh([])
        for method, path, body in (('PUT', '/pulls/7/merge', None), ('POST', '/merges', {'base': 'main'}),
                                   ('POST', 'https://api.github.com/graphql', {'query': 'mutation{mergePullRequest}'})):
            with self.assertRaises(P.PublishError) as ctx:
                gh.request(method, path, body)
            self.assertEqual(ctx.exception.code, 'MERGE_FORBIDDEN')
        self.assertEqual(fake.calls, [])

    def test_auto_merge_only_for_publisher_branch_and_expected_sha(self):
        pr = {'number': 7, 'node_id': 'PR_node', 'merged_at': None, 'auto_merge': None,
              'head': {'ref': 'notion-publish/events/x-1234', 'sha': 'h' * 40},
              'base': {'ref': 'main'}}
        gh, fake = self.gh([
            ('GET', r'/pulls/7$', (200, {}, pr)),
            ('POST', r'api.github.com/graphql', (200, {}, {'data': {'enablePullRequestAutoMerge': {'pullRequest': {'number': 7}}}}))
        ])
        self.assertEqual(gh.enable_auto_merge(7, expected_head_sha='h' * 40), 'ENABLED')
        self.assertEqual(fake.count('POST', r'graphql'), 1)
        bad = copy.deepcopy(pr)
        bad['head']['ref'] = 'feature/not-publisher'
        gh, _ = self.gh([('GET', r'/pulls/7$', (200, {}, bad))])
        with self.assertRaises(P.PublishError) as ctx:
            gh.enable_auto_merge(7)
        self.assertEqual(ctx.exception.code, 'AUTO_MERGE_FAILED')

    def test_auto_publish_workflow_uses_scoped_app_and_has_no_direct_merge(self):
        code = (ROOT / 'scripts/publish_from_notion.py').read_text(encoding='utf-8')
        workflow = (ROOT / '.github/workflows/publish-executor.yml').read_text(encoding='utf-8')
        runtime = re.sub(r'FORBIDDEN_GITHUB = .*', '', code)
        for pattern in (r"request\('PUT'.*/merge", r'gh pr merge', r'mergePullRequest'):
            self.assertIsNone(re.search(pattern, runtime), pattern)
        for forbidden in ('permission-administration', 'permission-workflows', 'gh pr merge'):
            self.assertNotIn(forbidden, workflow)
        self.assertIn('actions/create-github-app-token@', workflow)
        self.assertIn('HUIWEN_PUBLISH_APP_ID', workflow)
        self.assertIn('HUIWEN_PUBLISH_APP_KEY', workflow)
        self.assertIn('GH_TOKEN: ${{ steps.app-token.outputs.token }}', workflow)
        self.assertIn('PUBLISHER_AUTO_PUBLISH: ${{ vars.PUBLISHER_AUTO_PUBLISH }}', workflow)

    def test_gate_supports_auto_publish_without_bypassing_checks(self):
        self.assertEqual(P.evaluate_gate(SINGLE_MAINTAINER_RULES, {'allow_auto_merge': True},
                                         single_maintainer=True, auto_publish=True), (True, []))
        self.assertFalse(P.evaluate_gate(SINGLE_MAINTAINER_RULES, {'allow_auto_merge': False},
                                         single_maintainer=True, auto_publish=True)[0])
        no_guard = copy.deepcopy(SINGLE_MAINTAINER_RULES)
        no_guard[1]['parameters']['required_status_checks'] = [{'context': 'validate'}]
        self.assertTrue(any('publication-path-guard' in p for p in
                            P.evaluate_gate(no_guard, {'allow_auto_merge': True},
                                            single_maintainer=True, auto_publish=True)[1]))
        ok, problems = P.evaluate_gate([], {'allow_auto_merge': True},
                                       single_maintainer=True, auto_publish=True)
        self.assertFalse(ok)
        self.assertGreaterEqual(len(problems), 3)


class DisposableRepo(unittest.TestCase):
    """Copies tracked files into a throw-away Git repo; the real checkout is never modified."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.repo = Path(cls.tmp.name) / 'repo'
        files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=ROOT, text=True).splitlines()
        for name in files:
            src = ROOT / name
            if src.is_file():
                dest = cls.repo / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dest)
        for args in (['init', '-q'], ['add', '.'], ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'base']):
            subprocess.run(['git', *args], cwd=cls.repo, check=True, stdout=subprocess.DEVNULL)
        cls.head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=cls.repo, text=True).strip()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def source(self, rows):
        s = P.FileSource.__new__(P.FileSource)
        s.data, s.writes = rows, []
        return s

    def gh(self, main_sha, rules=SINGLE_MAINTAINER_RULES, created=None, allow_auto_merge=True):
        created = created if created is not None else []
        head_sha = 'c' * 40
        pr_full = {'number': 100, 'node_id': 'PR_100', 'state': 'open', 'merged_at': None,
                   'auto_merge': None, 'html_url': 'https://github.com/x/pull/100',
                   'head': {'ref': 'notion-publish/events/test-digest', 'sha': head_sha},
                   'base': {'ref': 'main'}, 'user': {'login': 'huiwen-publisher[bot]', 'type': 'Bot'}}
        def create():
            created.append(1)
            return 201, {}, {'number': 100, 'node_id': 'PR_100', 'state': 'open', 'merged_at': None,
                             'html_url': 'https://github.com/x/pull/100'}
        fake = Fake([
            ('GET', r'/rules/branches/main', (200, {}, rules)),
            ('GET', r'chen-huiwen-website$', (200, {}, {'allow_auto_merge': allow_auto_merge})),
            ('GET', r'/git/ref/heads/main', (200, {}, {'object': {'sha': main_sha}})),
            ('GET', r'/pulls\?', (200, {}, [])),
            ('GET', r'/git/ref/heads/notion', [(404, {}, {}), (200, {}, {'object': {'sha': head_sha}})]),
            ('POST', r'/pulls$', create),
            ('GET', r'/pulls/100$', (200, {}, pr_full)),
            ('POST', r'api.github.com/graphql',
             (200, {}, {'data': {'enablePullRequestAutoMerge': {'pullRequest': {'number': 100}}}}))
        ])
        return P.GitHub('t', 'Hong1998tw/chen-huiwen-website', transport=fake, sleep=lambda s: None), fake

    def assert_clean(self):
        self.assertEqual(P.changed_files(self.repo), [])
        self.assertEqual(subprocess.check_output(['git', 'worktree', 'list'], cwd=self.repo, text=True).count('\n'), 1)


class DryRunAndPublishTests(DisposableRepo):
    def test_dry_run_builds_in_worktree_without_push_pr_or_artifact(self):
        src = self.source({'events': [new_event_row()]})
        # quality=False: the full quality gate runs this suite itself (no recursion); build_all + allowlist still run.
        result = P.dry_run(src, self.repo, 'events', src.data['events'][0], build=True, quality=False)
        self.assertEqual(result['outcome'], 'PREVIEWED')
        self.assertTrue(set(result['files']) <= P.ALLOWED_PATHS['events'])
        self.assertIn('data/events.json', result['files'])
        write = src.writes[-1]
        self.assertEqual((write['state'], write['candidateDigest'], write['requestPreview']), ('可核准', result['digest'], False))
        self.assertIn('【活動｜新增】里民健康講座', write['preview'])
        self.assert_clean()

    def test_validation_errors_are_plain_language_and_block(self):
        src = self.source({'events': [new_event_row(name='<script>alert(1)</script>', sourceUrl='javascript:alert(1)')]})
        result = P.dry_run(src, self.repo, 'events', src.data['events'][0], build=False)
        self.assertEqual(result['outcome'], 'VALIDATION')
        self.assertIn('內容檢查未通過', src.writes[-1]['result'])
        self.assertIn('不可包含 HTML', src.writes[-1]['result'])
        self.assertNotRegex(src.writes[-1]['result'], r'\b\d{8,}\b')  # never only a run number

    def test_one_click_publish_enables_auto_merge_without_preview(self):
        row = new_event_row()
        row['system']['requestPublish'] = True
        src = self.source({'events': [row]})
        gh, fake = self.gh(self.head)
        pushed = []
        result = P.publish(src, self.repo, 'events', row, gh,
                           lambda wt, c, t: pushed.append(c.branch), build=False,
                           single_maintainer=True, auto_publish=True)
        self.assertEqual((result['outcome'], result['autoMerge'], len(pushed)), ('CREATED', 'ENABLED', 1))
        self.assertEqual(src.writes[-1]['state'], '自動發布中')
        self.assertFalse(src.writes[-1]['requestPublish'])
        self.assertIn('自動合併', src.writes[-1]['result'])
        self.assertEqual(fake.count('POST', r'graphql'), 1)
        self.assertEqual(fake.count('PUT', r'/merge'), 0)
        self.assert_clean()

    def test_no_change_publish_points_to_redeploy(self):
        row = rows_from(EVENTS_TEXT)[0]
        row['system']['requestPublish'] = True
        src = self.source({'events': [row]})
        gh, _ = self.gh(self.head)
        result = P.publish(src, self.repo, 'events', row, gh, lambda *a: self.fail('must not push'),
                           build=False, single_maintainer=True, auto_publish=True)
        self.assertEqual(result['outcome'], 'NO_CHANGE')
        self.assertIn('重新部署正式站', src.writes[-1]['result'])
        self.assertFalse(src.writes[-1]['requestPublish'])

    def test_publish_refused_when_gate_not_enforced(self):
        row = new_event_row()
        row['system']['requestPublish'] = True
        src = self.source({'events': [row]})
        created = []
        gh, _ = self.gh(self.head, rules=[], created=created)
        result = P.publish(src, self.repo, 'events', row, gh, lambda *a: created.append('push'),
                           build=False, single_maintainer=True, auto_publish=True)
        self.assertEqual((result['outcome'], created), ('GATE_NOT_ENFORCED', []))
        self.assertIn('尚未生效', src.writes[-1]['result'])
        self.assertTrue(src.data['events'][0]['system']['requestPublish'])

    def test_edit_during_publish_clears_request_and_does_not_push(self):
        row = new_event_row()
        row['system']['requestPublish'] = True
        src = self.source({'events': [row]})
        original_fresh = src.fresh
        calls = {'n': 0}
        def fresh(domain, page_id):
            calls['n'] += 1
            got = original_fresh(domain, page_id)
            if calls['n'] >= 2:
                got['fields']['name'] += '！'
            return got
        src.fresh = fresh
        gh, _ = self.gh(self.head)
        result = P.publish(src, self.repo, 'events', row, gh, lambda *a: self.fail('must not push'),
                           build=False, single_maintainer=True, auto_publish=True)
        self.assertEqual(result['outcome'], 'PUBLISH_CHANGED_DURING_RUN')
        self.assertEqual((src.writes[-1]['state'], src.writes[-1]['requestPublish']), ('需重新發布', False))

    def test_stale_checkout_blocks_pr(self):
        row = new_event_row()
        row['system']['requestPublish'] = True
        src = self.source({'events': [row]})
        gh, _ = self.gh('f' * 40)
        result = P.publish(src, self.repo, 'events', row, gh, lambda *a: self.fail('must not push'),
                           build=False, single_maintainer=True, auto_publish=True)
        self.assertEqual((result['outcome'], result['retryable']), ('STALE_CHECKOUT', True))


class RedeployTests(unittest.TestCase):
    def setUp(self):
        patcher = unittest.mock.patch.object(P, 'deployment_provider', return_value='github-pages')
        patcher.start()
        self.addCleanup(patcher.stop)

    def source(self):
        s = P.FileSource.__new__(P.FileSource)
        s.data = {'deployControls': [{
            'pageId': 'deploy-page', 'requestRedeploy': True, 'state': '待命',
            'result': '', 'runId': '', 'lastRun': None
        }]}
        s.writes = []
        return s

    def gh(self, routes):
        fake = Fake(routes)
        return P.GitHub('actions-token', 'Hong1998tw/chen-huiwen-website',
                        transport=fake, sleep=lambda s: None), fake

    def test_redeploy_dispatches_pages_without_content_mutation(self):
        src = self.source()
        created = P.datetime.now(P.timezone.utc).isoformat().replace('+00:00', 'Z')
        gh, fake = self.gh([
            ('POST', r'/actions/workflows/pages.yml/dispatches$', (204, {}, None)),
            ('GET', r'/actions/workflows/pages.yml/runs', (200, {}, {'workflow_runs': [
                {'id': 123, 'status': 'queued', 'conclusion': None, 'created_at': created}
            ]}))
        ])
        with unittest.mock.patch.object(P, 'deployment_provider', return_value='github-pages'):
            result = P.request_redeploy(src, gh, src.data['deployControls'][0])
        self.assertEqual((result['outcome'], result['run']), ('REDEPLOY_DISPATCHED', 123))
        row = src.data['deployControls'][0]
        self.assertFalse(row['requestRedeploy'])
        self.assertEqual((row['state'], row['runId']), ('重新部署中', '123'))
        self.assertEqual(fake.count('POST', r'pages.yml/dispatches'), 1)

    def test_redeploy_verification_writes_success_or_failure(self):
        src = self.source()
        row = src.data['deployControls'][0]
        row.update(requestRedeploy=False, state='重新部署中', runId='123',
                   lastRun='2026-09-24T21:00:00+08:00')
        gh, _ = self.gh([('GET', r'/actions/runs/123$', (200, {}, {
            'id': 123, 'status': 'completed', 'conclusion': 'success'}))])
        result = P.verify_redeploy(src, gh, row)
        self.assertEqual(result['outcome'], 'REDEPLOYED')
        self.assertEqual(src.data['deployControls'][0]['state'], '重新部署完成')

        src.data['deployControls'][0].update(state='重新部署中', runId='124')
        gh, _ = self.gh([('GET', r'/actions/runs/124$', (200, {}, {
            'id': 124, 'status': 'completed', 'conclusion': 'failure'}))])
        result = P.verify_redeploy(src, gh, src.data['deployControls'][0])
        self.assertEqual(result['outcome'], 'REDEPLOY_FAILED')
        self.assertEqual(src.data['deployControls'][0]['state'], '重新部署失敗')


class SecurityTests(unittest.TestCase):
    def errors(self, **overrides):
        return P.normalize_event(new_event_row(**overrides)['fields'])[1]

    def test_markup_and_control_characters_rejected(self):
        for field, value in (('name', '<script>x</script>'), ('content', '說明<iframe src=x>'), ('registration', '<a href=x>報名</a>'),
                             ('name', '活動\x00'), ('content', '行1\u202e反轉'), ('name', '換\n行')):
            self.assertTrue(self.errors(**{field: value}), (field, value))

    def test_urls_must_be_public_https(self):
        for url in ('javascript:alert(1)', 'http://www.kcg.gov.tw/x', 'https://www.' + 'notion' + '.so/private-page',
                    'https://drive.google.com/file/d/x', 'https://docs.google.com/document/d/x', 'https://127.0.0.1/x',
                    'https://[::1]/x', 'https://user:pw@www.kcg.gov.tw/', 'https://localhost/x', 'https://intranet.corp/x',
                    'https://www.kcg.gov.tw:8443/x', 'data:text/html,hi'):
            self.assertTrue(self.errors(sourceUrl=url), url)
        self.assertEqual(self.errors(sourceUrl='https://www.canva.com/design/abc/view'), [])

    def test_builders_escape_preserved_fields_and_reject_unsafe_links(self):
        event = dict(json.loads(GOLDEN_TEXT)['events'][2], location='<script>alert(1)</script>')
        html = build_events.render_events([event])
        self.assertNotIn('<script>', html)
        self.assertIn('&lt;script&gt;', html)
        for bad in ('javascript:alert(1)', 'http://example.com/x', 'https://u:p@example.com/'):
            with self.assertRaises(ValueError):
                build_service.validate_schedule({**json.loads(LEGAL_TEXT), 'sourceUrl': bad})
        with self.assertRaises(ValueError):
            build_service.validate_schedule({**json.loads(LEGAL_TEXT), 'month': '2026-13"><script>'})

    def test_logs_and_pr_body_never_contain_content_or_secrets(self):
        with tempfile.TemporaryDirectory() as d:
            rows = Path(d) / 'rows.json'
            rows.write_text(json.dumps({'events': [dict(new_event_row(content=CANARY_CONTENT), system={'requestPreview': True})]},
                                       ensure_ascii=False), encoding='utf-8')
            out, err = io.StringIO(), io.StringIO()
            env = {'GH_TOKEN': CANARY_SECRET, 'NOTION_TOKEN': CANARY_SECRET}
            with unittest.mock.patch.dict(os.environ, env), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = P.main(['dry-run', '--rows', str(rows), '--domain', 'events', '--skip-build'])
            logs = out.getvalue() + err.getvalue()
            self.assertEqual(code, 0, logs)
            self.assertNotIn('CANARY-CONTENT', logs)
            self.assertNotIn(CANARY_SECRET, logs)
        cand = P.prepare_event(new_event_row(content=CANARY_CONTENT), EVENTS_TEXT)
        body = P.pr_body(cand, 'a' * 40)
        self.assertNotIn('CANARY', body)
        self.assertNotRegex(body, r'notion\.(so|site|com)|drive\.google')


class RecoveryAndVerificationTests(unittest.TestCase):
    def test_restore_returns_byte_identical_original(self):
        rows = rows_from(GOLDEN_TEXT)
        original = copy.deepcopy(rows[0])
        rows[0]['fields']['content'] = '錯誤內容'
        changed = P.prepare_event(rows[0], GOLDEN_TEXT)
        restored_row = copy.deepcopy(original)
        restored_row['system']['syncedHash'] = restored_row['system']['baseHash'] = P.sha(json.loads(changed.new_text)['events'][0])
        restored = P.prepare_event(restored_row, changed.new_text)
        self.assertEqual(restored.new_text, GOLDEN_TEXT)

    def verification_zip(self, native='BLOCKED', snapshot='Passed', failures=()):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            zf.writestr('production-live/http-parity.json', json.dumps({'checked': 51, 'failures': list(failures)}))
            zf.writestr('production-live/report.json', json.dumps({'status': snapshot}))
            zf.writestr('native-edge/report.json', json.dumps({'status': native}))
        return buf.getvalue()

    def fake(self, *, deploy='success', native='BLOCKED', review=True, merged=True, merged_by_type='User'):
        pr = {'number': 7, 'state': 'closed' if merged else 'open', 'head': {'sha': 'h' * 40},
              'merged_at': '2026-09-24T01:00:00Z' if merged else None, 'merge_commit_sha': 'm' * 40,
              'merged_by': {'type': merged_by_type} if merged else None}
        checks = {'check_runs': [{'name': n, 'conclusion': 'success'} for n in P.REQUIRED_CHECKS]}
        reviews = [{'state': 'APPROVED', 'user': {'type': 'User'}, 'commit_id': 'h' * 40}] if review else []
        return Fake([('GET', r'/pulls/7$', (200, {}, pr)), ('GET', r'/check-runs', (200, {}, checks)),
                     ('GET', r'/pulls/7/reviews', (200, {}, reviews)),
                     ('GET', r'pages.yml/runs', (200, {}, {'workflow_runs': [{'id': 11, 'status': 'completed', 'conclusion': deploy, 'head_sha': 'm' * 40}]})),
                     ('GET', r'/runs/11/artifacts', (200, {}, {'artifacts': [{'name': 'github-pages', 'digest': 'sha256:abc'}]})),
                     ('GET', r'production-verification.yml/runs', (200, {}, {'workflow_runs': [{'id': 12, 'status': 'completed', 'head_sha': 'm' * 40}]})),
                     ('GET', r'/runs/12/artifacts', (200, {}, {'artifacts': [{'id': 99, 'name': 'production-live-verification'}]})),
                     ('GET', r'/artifacts/99/zip', (200, {}, self.verification_zip(native)))])

    def status(self, fake, html='<article id="event-x">名稱</article>', *, single_maintainer=False):
        gh = P.GitHub('t', 'o/r', transport=fake, sleep=lambda s: None)
        with unittest.mock.patch.object(P, 'deployment_provider', return_value='github-pages'):
            return P.layered_status(gh, 7, 'events', 'x', '名稱', fetch=lambda url: html,
                                    single_maintainer=single_maintainer)

    def test_native_blocked_is_not_pass_and_revision_is_deployment_not_main(self):
        layers, revision = self.status(self.fake(native='BLOCKED'))
        self.assertEqual(layers['native_verified'], 'BLOCKED')
        self.assertEqual(P.overall(layers), ('DEPLOYED_UNVERIFIED', '已部署待驗證'))
        self.assertEqual(revision, {'deployRunId': 11, 'deployedSha': 'm' * 40, 'artifactDigest': 'sha256:abc', 'verificationRunId': 12})

    def test_all_layers_pass(self):
        layers, _ = self.status(self.fake(native='PASS'))
        self.assertEqual(P.overall(layers)[0], 'PASS')

    def test_ci_pass_but_deploy_fail_and_missing_http(self):
        layers, _ = self.status(self.fake(deploy='failure'))
        self.assertEqual((layers['ci_passed'], layers['deployed'], P.overall(layers)[0]), ('PASS', 'FAIL', 'FAIL'))
        layers, _ = self.status(self.fake(native='PASS'), html='<p>舊版</p>')
        self.assertEqual((layers['http_verified'], P.overall(layers)[0]), ('FAIL', 'FAIL'))

    def test_unreviewed_unmerged_pr_is_pending(self):
        layers, revision = self.status(self.fake(review=False, merged=False), single_maintainer=True)
        self.assertEqual((layers['review_approved'], layers['merged'], P.overall(layers)[0], revision),
                         ('PENDING', 'PENDING', 'PENDING', {}))

    def test_single_maintainer_human_merge_is_authorization_after_ci(self):
        layers, _ = self.status(self.fake(native='PASS', review=False, merged=True, merged_by_type='User'),
                                single_maintainer=True)
        self.assertEqual((layers['ci_passed'], layers['review_approved'], layers['merged']),
                         ('PASS', 'PASS', 'PASS'))

    def test_single_maintainer_bot_merge_is_not_human_authorization(self):
        layers, _ = self.status(self.fake(native='PASS', review=False, merged=True, merged_by_type='Bot'),
                                single_maintainer=True)
        self.assertEqual(layers['review_approved'], 'PENDING')
        self.assertNotEqual(P.overall(layers)[0], 'PASS')


class PathGuardTests(unittest.TestCase):
    def test_executor_prs_limited_to_domain_outputs(self):
        ok = guard('notion-publish/events/event-1-abcd', 'huiwen-publisher[bot]', 'Bot', '', ['data/events.json', 'activities.html'])
        self.assertTrue(ok[0])
        for files in (['data/events.json', 'scripts/quality.py'], ['data/events.json', '.github/workflows/pages.yml'],
                      ['activities.html'], ['data/events.json', 'data/legal-schedule.json'], ['data/events.json', 'CNAME']):
            self.assertFalse(guard('notion-publish/events/e-1', 'x[bot]', 'Bot', '', files)[0], files)
        self.assertFalse(guard('feature/x', 'huiwen-publisher[bot]', 'Bot', '', ['data/events.json'])[0])
        self.assertFalse(guard('notion-publish/achievements/x', 'u', 'User', '', ['data/achievements.json'])[0])
        self.assertTrue(guard('publish/boai-card-rehab-bus-20260922', 'Hong1998tw', 'User', '', ['data/achievements.json'])[0])

    def test_page_copy_executor_is_limited_to_the_page_data_and_public_build(self):
        allowed, _ = guard('notion-publish/page-copy/about.html-abcdef01', 'huiwen-publisher[bot]', 'Bot', '',
                           ['data/page-content.json', 'about.html', 'sitemap.xml', 'data/search-index.json'])
        self.assertTrue(allowed)
        rejected, _ = guard('notion-publish/page-copy/about.html-abcdef01', 'huiwen-publisher[bot]', 'Bot', '',
                            ['data/page-content.json', 'admin/src/index.ts'])
        self.assertFalse(rejected)

    def test_achievement_executor_cannot_modify_code_or_unrelated_data(self):
        branch='notion-publish/achievement-content/achievement-changle-hexing-youbike.html-abcdef01'
        allowed, _ = guard(branch, 'huiwen-publisher[bot]', 'Bot', '',
                           ['data/achievements.json', 'data/achievements-public.json',
                            'achievement-changle-hexing-youbike.html', 'data/achievement-map.json'])
        self.assertTrue(allowed)
        rejected, _ = guard(branch, 'huiwen-publisher[bot]', 'Bot', '',
                            ['data/achievements.json', 'admin/src/index.ts'])
        self.assertFalse(rejected)

    def test_home_order_executor_only_changes_curated_source_and_derived_home(self):
        branch='notion-publish/home-content/index.html-abcdef01'
        allowed, _ = guard(branch, 'huiwen-publisher[bot]', 'Bot', '',
                           ['data/civic-home.json', 'index.html', 'data/search-index.json'])
        self.assertTrue(allowed)
        rejected, _ = guard(branch, 'huiwen-publisher[bot]', 'Bot', '',
                            ['data/civic-home.json', 'admin/src/index.ts'])
        self.assertFalse(rejected)


class DeploymentTargetTests(unittest.TestCase):
    def test_legacy_default_and_only_two_reviewed_providers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(P.deployment_provider(root), 'github-pages')
            (root / 'data').mkdir()
            path = root / 'data/deployment-target.json'
            for provider in ('github-pages', 'cloudflare-static-assets'):
                path.write_text(json.dumps({'schemaVersion': 1, 'provider': provider}))
                self.assertEqual(P.deployment_provider(root), provider)
            for value in ({}, {'schemaVersion': 2, 'provider': 'cloudflare-static-assets'},
                          {'schemaVersion': True, 'provider': 'github-pages'},
                          {'schemaVersion': 1, 'provider': []},
                          {'schemaVersion': 1, 'provider': 'other'},
                          {'schemaVersion': 1, 'provider': 'github-pages', 'workflow': 'unsafe.yml'}, []):
                path.write_text(json.dumps(value))
                with self.assertRaises(P.PublishError) as caught:
                    P.deployment_provider(root)
                self.assertEqual(caught.exception.code, 'CONFIG')
            path.write_text('{broken')
            with self.assertRaises(P.PublishError):
                P.deployment_provider(root)

    def test_read_failure_does_not_fall_back_to_pages(self):
        with unittest.mock.patch.object(P.deployment_target, 'provider', side_effect=PermissionError):
            with self.assertRaises(P.PublishError) as caught:
                P.deployment_provider(ROOT)
        self.assertEqual(caught.exception.code, 'CONFIG')

    def test_deployment_control_path_gate_is_exactly_one_non_public_file(self):
        branch = 'notion-publish/deployment-control/' + 'a' * 32 + '-12345678'
        metadata = 'data/deployment-request.json'
        self.assertEqual(P.ALLOWED_PATHS['deployment-control'], {metadata})
        self.assertTrue(guard(branch, 'huiwen-publisher[bot]', 'Bot', '', [metadata])[0])
        for path in ('scripts/publish_from_notion.py', '.github/workflows/cloudflare-public.yml',
                     'data/deployment-target.json', 'data/events.json', 'index.html', 'wrangler.public.jsonc', 'CNAME'):
            self.assertFalse(guard(branch, 'huiwen-publisher[bot]', 'Bot', '', [metadata, path])[0], path)
        self.assertFalse(guard(branch, 'huiwen-publisher[bot]', 'Bot', '', [])[0])
        self.assertNotIn(metadata, P.public_paths(ROOT))
        self.assertNotIn('data/deployment-target.json', P.public_paths(ROOT))

    def test_candidate_is_stable_private_and_rejects_bad_request_id(self):
        with tempfile.TemporaryDirectory() as directory:
            first = P._deployment_control_candidate('a' * 32, '2026-10-01T12:00:00+08:00', directory)
            again = P._deployment_control_candidate('a' * 32, '2026-10-01T12:00:00+08:00', directory)
            self.assertEqual((first.branch, first.new_text), (again.branch, again.new_text))
            self.assertEqual(set(json.loads(first.new_text)), {'schemaVersion', 'provider', 'requestId', 'requestedAt'})
            self.assertNotIn('deploy-page', first.new_text)
            for request_id in ('', '../unsafe', 'a' * 31):
                with self.assertRaises(P.PublishError):
                    P._deployment_control_candidate(request_id, '2026-10-01T12:00:00+08:00', directory)

    def test_materialize_control_does_not_rebuild_content_and_enforces_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            (root / 'index.html').write_text('unchanged public source')
            candidate = P._deployment_control_candidate('a' * 32, '2026-10-01T12:00:00+08:00', root)
            with unittest.mock.patch.object(P, 'run') as run, \
                    unittest.mock.patch.object(P, 'changed_files', return_value=['data/deployment-request.json']):
                self.assertEqual(P.materialize(candidate, root), ['data/deployment-request.json'])
            run.assert_called_once_with([sys.executable, 'scripts/quality.py'], root)
            self.assertEqual((root / 'index.html').read_text(), 'unchanged public source')
            with unittest.mock.patch.object(P, 'run'), \
                    unittest.mock.patch.object(P, 'changed_files', return_value=['data/deployment-request.json', 'index.html']):
                with self.assertRaises(P.PublishError) as caught:
                    P.materialize(candidate, root)
            self.assertEqual(caught.exception.code, 'PATH_NOT_ALLOWED')

    def test_deployment_metadata_symlink_is_never_read_or_written_through(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            candidate = P._deployment_control_candidate('a' * 32, '2026-10-01T12:00:00+08:00', root)
            target = root / 'must-not-change.txt'
            target.write_text('unchanged')
            (root / 'data/deployment-request.json').symlink_to(target)
            with self.assertRaises(P.PublishError):
                P._deployment_control_candidate('a' * 32, '2026-10-01T12:00:00+08:00', root)
            with unittest.mock.patch.object(P, 'run') as run:
                with self.assertRaises(P.PublishError):
                    P.materialize(candidate, root)
                run.assert_not_called()
            self.assertEqual(target.read_text(), 'unchanged')


class CloudflareReceiptTests(unittest.TestCase):
    merge_sha, head_sha = 'a' * 40, 'b' * 40

    def status(self, *, native='BLOCKED', deploy='success', receipt_sha=None, branch='main', verification_sha=None):
        pr = {'number': 7, 'state': 'closed', 'head': {'sha': self.head_sha},
              'merged_at': '2026-10-01T00:00:00Z', 'merge_commit_sha': self.merge_sha,
              'merged_by': {'type': 'User'}}
        fake = Fake([
            ('GET', r'/pulls/7$', (200, {}, pr)),
            ('GET', r'/check-runs', (200, {}, {'check_runs': [{'name': n, 'conclusion': 'success'} for n in P.REQUIRED_CHECKS]})),
            ('GET', r'/pulls/7/reviews', (200, {}, [{'state': 'APPROVED', 'user': {'type': 'User'}, 'commit_id': self.head_sha}])),
            ('GET', r'cloudflare-public.yml/runs', (200, {}, {'workflow_runs': [{
                'id': 21, 'status': 'completed', 'conclusion': deploy,
                'head_sha': receipt_sha or self.merge_sha, 'head_branch': branch}]})),
            ('GET', r'/runs/21/artifacts', (200, {}, {'artifacts': [{'name': 'cloudflare-public-delivery', 'digest': 'sha256:cf'}]})),
            ('GET', r'production-verification.yml/runs', (200, {}, {'workflow_runs': [{
                'id': 22, 'status': 'completed', 'head_sha': verification_sha or self.merge_sha}]})),
            ('GET', r'/runs/22/artifacts', (200, {}, {'artifacts': [{'id': 99, 'name': 'production-live-verification'}]})),
            ('GET', r'/artifacts/99/zip', (200, {}, RecoveryAndVerificationTests().verification_zip(native)))])
        gh = P.GitHub('t', 'o/r', transport=fake, sleep=lambda _: None)
        with unittest.mock.patch.object(P, 'deployment_provider', return_value='cloudflare-static-assets'):
            layers, revision = P.layered_status(gh, 7, 'events', 'x', '名稱', fetch=lambda _: '<article id="event-x">名稱</article>')
        self.assertEqual(fake.count('GET', r'workflows/pages.yml'), 0)
        return layers, revision, fake

    def test_exact_cloudflare_receipt_preserves_blocked_native(self):
        layers, revision, _ = self.status()
        self.assertEqual(layers['deployed'], 'PASS')
        self.assertEqual(layers['native_verified'], 'BLOCKED')
        self.assertEqual(P.overall(layers)[0], 'DEPLOYED_UNVERIFIED')
        self.assertEqual(revision, {'provider': 'cloudflare-static-assets', 'deployRunId': 21,
            'deployedSha': self.merge_sha, 'artifactDigest': 'sha256:cf', 'verificationRunId': 22})

    def test_all_layers_pass_only_when_all_evidence_passes(self):
        self.assertEqual(P.overall(self.status(native='PASS')[0])[0], 'PASS')

    def test_other_commit_or_preview_branch_cannot_count_as_deployed(self):
        for kwargs in ({'receipt_sha': 'c' * 40}, {'branch': 'preview'}):
            layers, revision, _ = self.status(**kwargs)
            self.assertEqual((layers['deployed'], revision), ('PENDING', {}))
            self.assertEqual(layers['http_verified'], 'PENDING')

    def test_failed_receipt_is_not_success(self):
        layers, _, _ = self.status(deploy='failure')
        self.assertEqual((layers['deployed'], P.overall(layers)[0]), ('FAIL', 'FAIL'))

    def test_other_commit_verification_is_not_adopted(self):
        layers, _, fake = self.status(native='PASS', verification_sha='c' * 40)
        self.assertEqual((layers['snapshot_verified'], layers['native_verified']), ('PENDING', 'PENDING'))
        self.assertEqual(fake.count('GET', r'/runs/22/artifacts'), 0)

    def test_deployment_manifest_requires_provider_and_exact_full_sha(self):
        value = {'schemaVersion': 1, 'provider': 'cloudflare-static-assets', 'sourceCommit': self.merge_sha}
        self.assertEqual(P.http_check('deployment-control', self.merge_sha, fetch=lambda _: json.dumps(value)), 'PASS')
        for changed in ({**value, 'provider': 'github-pages'}, {**value, 'sourceCommit': 'c' * 40},
                        {**value, 'schemaVersion': True}, {}):
            self.assertEqual(P.http_check('deployment-control', self.merge_sha, fetch=lambda _: json.dumps(changed)), 'FAIL')
        self.assertEqual(P.http_check('deployment-control', self.merge_sha[:7], fetch=lambda _: json.dumps(value)), 'FAIL')


class CloudflareRedeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'data').mkdir()
        (self.root / 'data/deployment-target.json').write_text(json.dumps({'schemaVersion': 1, 'provider': 'cloudflare-static-assets'}))
        self.source = RedeployTests().source()
        self.row = self.source.data['deployControls'][0]
        self.gh = unittest.mock.Mock()
        self.gh.find_pull.return_value = None
        self.gh.branch_sha.side_effect = lambda name: 'a' * 40 if name == 'main' else ('b' * 40 if self.push.called else None)
        self.gh.create_pull.return_value = {'number': 100, 'state': 'open', 'merged_at': None}
        self.push = unittest.mock.Mock()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.gate = self.stack.enter_context(unittest.mock.patch.object(P, 'gate_preflight'))
        wt = self.stack.enter_context(unittest.mock.patch.object(P, 'Worktree'))
        wt.return_value.__enter__.return_value = self.root
        self.stack.enter_context(unittest.mock.patch.object(P, 'materialize', return_value=['data/deployment-request.json']))
        self.stack.enter_context(unittest.mock.patch.object(P, 'run', return_value=unittest.mock.Mock(stdout='a' * 40)))

    def request(self):
        return P.request_redeploy(self.source, unittest.mock.Mock(), self.row, repo=self.root,
            publisher_gh=self.gh, push=self.push, single_maintainer=True, auto_publish=True)

    def test_redeploy_uses_guarded_pr_not_a_cloudflare_token_or_dispatch(self):
        result = self.request()
        self.assertEqual((result['outcome'], result['pr']), ('REDEPLOY_DISPATCHED', 100))
        self.gate.assert_called_once_with(self.gh, single_maintainer=True, auto_publish=True)
        self.assertEqual(self.row['runId'], 'cf-pr:100')
        self.assertFalse(self.row['requestRedeploy'])
        candidate = self.push.call_args.args[1]
        self.assertEqual(P.allowed_for(candidate), {'data/deployment-request.json'})
        self.gh.enable_auto_merge.assert_called_once_with(100, expected_head_sha='b' * 40)
        self.gh.dispatch_workflow.assert_not_called()

    def test_missing_gate_or_auto_publish_prevents_any_git_write(self):
        self.gate.side_effect = P.PublishError('GATE_NOT_ENFORCED')
        self.assertEqual(self.request()['outcome'], 'GATE_NOT_ENFORCED')
        self.push.assert_not_called()
        self.gh.create_pull.assert_not_called()

    def test_disabled_auto_publish_prevents_any_git_write(self):
        result = P.request_redeploy(self.source, None, self.row, repo=self.root,
            publisher_gh=self.gh, push=self.push, single_maintainer=True, auto_publish=False)
        self.assertEqual(result['outcome'], 'CONFIG')
        self.gate.assert_not_called()
        self.push.assert_not_called()
        self.gh.create_pull.assert_not_called()

    def test_old_pages_run_is_not_a_cloudflare_redeploy_receipt(self):
        self.row.update(state='重新部署中', runId='123', requestRedeploy=False)
        actions = unittest.mock.Mock()
        result = P.verify_redeploy(self.source, actions, self.row, repo=self.root,
            publisher_gh=self.gh, push=self.push, single_maintainer=True, auto_publish=True)
        self.assertEqual(result['outcome'], 'CONFIG')
        actions.action_run.assert_not_called()

    def test_stale_checkout_prevents_pr(self):
        self.gh.branch_sha.return_value = 'f' * 40
        self.gh.branch_sha.side_effect = None
        self.assertEqual(self.request()['outcome'], 'STALE_CHECKOUT')
        self.push.assert_not_called()

    def test_unknown_auto_merge_result_retains_pr_for_reconciliation(self):
        self.gh.enable_auto_merge.side_effect = P.RemoteUnknown('graphql')
        self.assertEqual(self.request()['outcome'], 'REDEPLOY_PENDING')
        self.assertEqual((self.row['runId'], self.row['state']), ('cf-pr:100', '重新部署中'))
        self.assertEqual(self.request()['outcome'], 'REDEPLOY_PENDING')
        self.assertEqual(self.gh.create_pull.call_count, 1)
        self.assertEqual(self.push.call_count, 1)

    def test_resuming_claim_reuses_same_branch_and_request_timestamp(self):
        self.row.update(state='重新部署中', runId='cf-request:' + 'c' * 32,
                        requestRedeploy=False, lastRun='2026-10-01T12:00:00+08:00')
        expected = P._deployment_control_candidate('c' * 32, self.row['lastRun'], self.root)
        self.request()
        candidate = self.push.call_args.args[1]
        self.assertEqual((candidate.branch, candidate.new_text), (expected.branch, expected.new_text))

    def test_blocked_native_stays_pending_and_provider_rollback_cannot_resume(self):
        self.row.update(state='重新部署中', runId='cf-pr:100', requestRedeploy=False)
        self.gh.request.return_value = (200, {'state': 'closed', 'merged_at': '2026-10-01T00:00:00Z',
            'head': {'ref': 'notion-publish/deployment-control/request'}, 'base': {'ref': 'main'}})
        layers = dict.fromkeys(P.LAYERS, 'PASS')
        layers['native_verified'] = 'BLOCKED'
        with unittest.mock.patch.object(P, 'layered_status', return_value=(layers, {})):
            result = P.verify_redeploy(self.source, None, self.row, repo=self.root, publisher_gh=self.gh,
                push=self.push, single_maintainer=True, auto_publish=True)
        self.assertEqual((result['outcome'], self.row['state']), ('REDEPLOY_PENDING', '重新部署中'))
        (self.root / 'data/deployment-target.json').write_text(json.dumps({'schemaVersion': 1, 'provider': 'github-pages'}))
        result = P.verify_redeploy(self.source, None, self.row, repo=self.root, publisher_gh=self.gh,
            push=self.push, single_maintainer=True, auto_publish=True)
        self.assertEqual(result['outcome'], 'CONFIG')
        self.push.assert_not_called()


if __name__ == '__main__':
    unittest.main()
