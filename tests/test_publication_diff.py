import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from report_publication_diff import report

NOW = datetime(2026, 10, 2, 16, 0, tzinfo=timezone.utc)
SHA = 'a' * 40


def fixture():
    case = {'id': 'example-case', 'title': '示例地方需求', 'summary': '已核對摘要',
            'paragraphs': ['提出需求與市府辦理角色分開呈現。'], 'status': '持續追蹤'}
    page = {'path': 'achievement-example-case.html', 'title': '示例地方需求',
            'source': 'data/achievements.json', 'kind': 'generated', 'editorScope': 'partial'}
    release = {'schemaVersion': 1, 'provider': 'cloudflare-static-assets', 'sourceCommit': SHA,
               'publicArtifactDigest': 'b' * 64, 'publicRecordCount': 1, 'publicFileCount': 1}
    stamp = {'observedAt': NOW.isoformat(), 'complete': True}
    return {'schemaVersion': 1,
            'notion': {**stamp, 'rows': []},
            'cms': {**stamp, 'pages': [{'path': page['path'], 'title': page['title'],
                                      'source_path': page['source'], 'source_kind': page['kind'],
                                      'editor_scope': page['editorScope'], 'commit_sha': 'c' * 40}],
                    'sources': [], 'publications': [], 'pagePublications': []},
            'github': {**stamp, 'repository': 'Hong1998tw/chen-huiwen-website', 'ref': 'refs/heads/main',
                       'commitSha': SHA, 'records': [case], 'publicRecords': [copy.deepcopy(case)],
                       'pages': [page], 'sources': [], 'release': copy.deepcopy(release)},
            'live': {**stamp, 'baseUrl': 'https://www.huiwen.tw/', 'httpStatus': 200,
                     'release': copy.deepcopy(release), 'records': [copy.deepcopy(case)]}}


def intent(data, **changes):
    row = {'網站 ID': 'example-case', '要求發布': '__YES__', '政績標題': '示例地方需求',
           '摘要': '已核對摘要', '公開敘事': '提出需求與市府辦理角色分開呈現。',
           '敘事狀態': '已審定', '證據狀態': '已確認', '發佈疑慮判讀': '低'}
    row.update(changes)
    data['notion']['rows'] = [row]
    return row


class PublicationDiffTests(unittest.TestCase):
    def test_same_content_older_cms_receipt_is_not_an_unpublished_record(self):
        result = report(fixture(), now=NOW)
        self.assertEqual(result['status'], 'OK')
        self.assertEqual(result['differences'], [])
        self.assertEqual(result['publicationActions'], 0)

    def test_ready_but_not_requested_does_not_enter_publish_list(self):
        data = fixture()
        intent(data, **{'要求發布': '__NO__', '發布狀態': '可發布', '公開敘事': ''})
        result = report(data, now=NOW)
        self.assertEqual(result['status'], 'OK')
        self.assertEqual(result['counts']['notionRequested'], 0)

    def test_requested_new_reviewed_record_requires_engineering(self):
        data = fixture()
        intent(data, **{'網站 ID': 'new-example'})
        result = report(data, now=NOW)
        self.assertEqual(result['status'], 'DIFFERENCES')
        self.assertEqual(result['differences'][0]['kind'], 'NOTION_NOT_IN_CANONICAL')
        self.assertTrue(result['differences'][0]['needsCodex'])
        self.assertNotIn('已核對摘要', json.dumps(result, ensure_ascii=False))

    def test_unreviewed_request_remains_review_work_without_auto_publish(self):
        data = fixture()
        intent(data, **{'網站 ID': 'new-example', '敘事狀態': '草稿完成'})
        item = report(data, now=NOW)['differences'][0]
        self.assertFalse(item['needsCodex'])
        self.assertIn('不可自動公開', item['action'])

    def test_changed_public_narrative_is_a_real_source_difference(self):
        data = fixture()
        intent(data, **{'摘要': '經審定的新摘要'})
        item = report(data, now=NOW)['differences'][0]
        self.assertEqual(item['kind'], 'NOTION_CONTENT_DIFF')
        self.assertEqual(item['fields'], ['summary'])

    def test_existing_unpublished_record_is_not_treated_as_a_receipt(self):
        data = fixture()
        data['github']['records'][0]['status'] = '待核驗'
        data['github']['publicRecords'] = []
        data['github']['release']['publicRecordCount'] = 0
        intent(data)
        result = report(data, now=NOW)
        self.assertIn('NOTION_CONTENT_DIFF', [item['kind'] for item in result['differences']])

    def test_live_matching_request_needs_native_receipt_only(self):
        data = fixture()
        intent(data)
        item = report(data, now=NOW)['differences'][0]
        self.assertEqual(item['kind'], 'NOTION_RECEIPT_PENDING')
        self.assertFalse(item['needsCodex'])

    def test_missing_cms_page_is_native_catalog_alignment(self):
        data = fixture()
        data['cms']['pages'] = []
        item = report(data, now=NOW)['differences'][0]
        self.assertEqual(item['kind'], 'CMS_CATALOG_DIFF')
        self.assertFalse(item['needsCodex'])

    def test_cms_source_hash_comparison_ignores_timestamp_and_commit_labels(self):
        data = fixture()
        data['github']['sources'] = [{'domain': 'events', 'record_key': 'event-example', 'hash': 'sha256:one'}]
        data['cms']['sources'] = [{'domain': 'events', 'record_key': 'event-example', 'source_hash': 'sha256:one', 'commit_sha': 'c' * 40}]
        self.assertEqual(report(data, now=NOW)['status'], 'OK')
        data['cms']['sources'][0]['source_hash'] = 'sha256:old'
        self.assertEqual(report(data, now=NOW)['differences'][0]['kind'], 'CMS_SOURCE_CACHE_DIFF')

    def test_four_historical_failed_requests_are_not_requeued_or_listed(self):
        data = fixture()
        data['cms']['pagePublications'] = [
            {'path': 'achievement-example-case.html', 'version': n, 'status': 'failed'} for n in (1, 2, 3)
        ] + [{'path': 'achievement-example-case.html', 'version': 4, 'status': 'deployed', 'message': 'PENDING'},
             {'path': 'index.html', 'version': 1, 'status': 'failed'},
             {'path': 'index.html', 'version': 2, 'status': 'deployed', 'message': 'PENDING'}]
        result = report(data, now=NOW)
        self.assertEqual(result['status'], 'OK')
        self.assertEqual(result['counts']['historicalFailedIgnored'], 4)
        self.assertEqual(result['counts']['activeCmsRequests'], 0)

    def test_pending_request_without_content_proof_is_unknown_not_a_fake_diff(self):
        data = fixture()
        data['cms']['pagePublications'] = [{'path': 'index.html', 'version': 3, 'status': 'queued'}]
        result = report(data, now=NOW)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['differences'], [])
        self.assertEqual(result['blockers'][0]['kind'], 'CMS_REQUEST_COMPARISON_REQUIRED')

    def test_latest_failed_request_is_a_blocker_not_ignored_history(self):
        data = fixture()
        data['cms']['pagePublications'] = [{'path': 'index.html', 'version': 1, 'status': 'failed'}]
        result = report(data, now=NOW)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['counts']['historicalFailedIgnored'], 0)
        self.assertTrue(result['blockers'][0]['needsCodex'])

    def test_already_present_pending_payload_is_not_a_difference(self):
        data = fixture()
        data['cms']['pagePublications'] = [{'path': 'index.html', 'version': 3, 'status': 'queued',
                                            'desiredHash': 'same', 'canonicalHash': 'same'}]
        self.assertEqual(report(data, now=NOW)['status'], 'OK')
        data['cms']['pagePublications'][0]['desiredHash'] = 'changed'
        self.assertEqual(report(data, now=NOW)['differences'][0]['kind'], 'CMS_REQUEST_CONTENT_DIFF')

    def test_live_old_release_requires_exact_version_verification(self):
        data = fixture()
        data['live']['release']['sourceCommit'] = 'd' * 40
        item = report(data, now=NOW)['differences'][0]
        self.assertEqual(item['kind'], 'LIVE_RELEASE_DIFF')
        self.assertTrue(item['needsCodex'])

    def test_missing_live_record_is_confirmed_but_receipt_wait_is_not_claimed_done(self):
        data = fixture()
        intent(data)
        data['live']['records'] = []
        data['live']['release']['publicRecordCount'] = 0
        kinds = [item['kind'] for item in report(data, now=NOW)['differences']]
        self.assertIn('LIVE_PUBLIC_RECORD_DIFF', kinds)
        self.assertNotIn('NOTION_RECEIPT_PENDING', kinds)

    def test_http_or_provider_blocked_is_separate_from_real_unsynced_content(self):
        for status, provider in [(403, 'cloudflare-static-assets'), (200, 'other')]:
            with self.subTest(status=status, provider=provider):
                data = fixture()
                data['live']['httpStatus'] = status
                data['live']['release']['provider'] = provider
                result = report(data, now=NOW)
                self.assertEqual(result['status'], 'BLOCKED')
                self.assertEqual(result['differences'], [])
                self.assertEqual(result['blockers'][0]['kind'], 'LIVE_READBACK_BLOCKED')

    def test_freshness_completeness_and_duplicate_identity_fail_closed(self):
        changes = [lambda d: d['notion'].update(complete=False),
                   lambda d: d['cms'].update(observedAt=(NOW-timedelta(hours=5)).isoformat()),
                   lambda d: d['github'].update(observedAt=(NOW+timedelta(hours=1)).isoformat()),
                   lambda d: d['github'].update(ref='refs/heads/candidate'),
                   lambda d: d['live']['records'].append(copy.deepcopy(d['live']['records'][0])),
                   lambda d: d['cms']['pages'].append('--- TRUNCATED ---'),
                   lambda d: d['github'].update(publicRecords=[]),
                   lambda d: d['live']['release'].update(publicRecordCount=2)]
        for change in changes:
            data = fixture()
            change(data)
            result = report(data, now=NOW)
            self.assertEqual(result['status'], 'BLOCKED')
            self.assertEqual(result['differences'], [])

    def test_notifications_deduplicate_by_content_without_contacting_any_recipient(self):
        data = fixture()
        intent(data, **{'摘要': '新版摘要'})
        first = report(data, now=NOW)
        self.assertEqual(len(first['newDifferences']), 1)
        second = report(data, now=NOW+timedelta(minutes=30), previous=first)
        self.assertEqual(second['newDifferences'], [])
        self.assertEqual(second['differences'], first['differences'])
        data['notion']['rows'][0]['摘要'] = '下一個審定摘要'
        self.assertEqual(len(report(data, now=NOW, previous=second)['newDifferences']), 1)

    def test_cli_returns_distinct_statuses_and_only_writes_the_requested_report(self):
        script = Path(__file__).resolve().parents[1] / 'scripts/report_publication_diff.py'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, output = root/'snapshot.json', root/'report.json'
            for expected_code, data in [(0, fixture()), (1, fixture()), (2, fixture())]:
                if expected_code == 1:
                    intent(data)
                elif expected_code == 2:
                    data['cms']['complete'] = False
                path.write_text(json.dumps(data))
                run = subprocess.run([sys.executable, str(script), '--snapshot', str(path), '--output', str(output),
                                      '--at', NOW.isoformat()], capture_output=True, text=True)
                self.assertEqual(run.returncode, expected_code)
                self.assertEqual(json.loads(output.read_text()), json.loads(run.stdout))
                self.assertEqual(json.loads(output.read_text())['publicationActions'], 0)
            self.assertEqual(sorted(p.name for p in root.iterdir()), ['report.json', 'snapshot.json'])


if __name__ == '__main__':
    unittest.main()
