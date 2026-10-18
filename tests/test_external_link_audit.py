"""Offline tests for the bounded external-link audit report."""
import json
import contextlib
import io
import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from scripts import audit_external_links as audit

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATHS = {'index.html', 'nested/public.html', 'data/election-2026.json'}


def checkout_sha():
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


def write_public_artifact(root, files, *, source_sha=None, manifest_files=None,
                          public_record_count=0):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    payloads = {}
    for relative, content in files.items():
        payload = content.encode('utf-8') if isinstance(content, str) else content
        payloads[relative] = payload
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    rows = manifest_files or {
        relative: hashlib.sha256(payload).hexdigest()
        for relative, payload in payloads.items()
    }
    manifest = {'version': 1, 'publicRecordCount': public_record_count, 'files': rows}
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    (root / 'publication-manifest.json').write_bytes(manifest_bytes)
    source_sha = source_sha or checkout_sha()
    receipt = {
        'schemaVersion': 1,
        'provider': 'cloudflare-static-assets',
        'sourceCommit': source_sha,
        'publicArtifactDigest': hashlib.sha256(manifest_bytes).hexdigest(),
        'publicFileCount': len(rows),
        'publicRecordCount': public_record_count,
    }
    (root / 'deployment.json').write_text(
        json.dumps(receipt, sort_keys=True, separators=(',', ':')) + '\n', encoding='utf-8'
    )
    for relative, content in audit._cloudflare_wrapper_bytes(root, manifest).items():
        (root / relative).write_bytes(content)
    return receipt


class FingerprintAndInventoryTests(unittest.TestCase):
    def test_canonical_url_deduplicates_fragment_host_case_and_default_port(self):
        left = audit.canonical_url('HTTPS://Example.COM:443/source#section-a')
        right = audit.canonical_url('https://example.com/source#section-b')
        self.assertEqual(left, 'https://example.com/source')
        self.assertEqual(left, right)
        self.assertEqual(audit.url_fingerprint(left), audit.url_fingerprint(right))

    def test_query_values_are_not_collapsed_and_credentials_are_not_probed(self):
        first = audit.canonical_url('https://example.com/item?id=1')
        second = audit.canonical_url('https://example.com/item?id=2')
        self.assertNotEqual(audit.url_fingerprint(first), audit.url_fingerprint(second))
        self.assertIsNone(audit.canonical_url('https://user:pass@example.com/private'))

    def test_inventory_merges_same_url_sources_without_network_access(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            (root / 'one.html').write_text(
                '<a href="https://Example.com:443/a#one">one</a>', encoding='utf-8'
            )
            (root / 'two.html').write_text(
                '<iframe src="https://example.com/a#two"></iframe>', encoding='utf-8'
            )
            (root / 'data' / 'refs.json').write_text(
                json.dumps({'sourceUrl': 'https://example.com/a#json'}), encoding='utf-8'
            )
            self.assertEqual(
                audit.inventory(root),
                {'https://example.com/a': {'one.html', 'two.html', 'data/refs.json'}},
            )


class PublicArtifactScopeTests(unittest.TestCase):
    def setUp(self):
        # Small legacy fixtures exercise the A07 scope checks independently from the
        # full G02 contract. The real source-derived G02 artifact is verified separately.
        self.font_contract_patch = patch.object(audit, '_validated_page_font_paths', return_value=set())
        self.wrapper_patch = patch.object(audit, '_cloudflare_wrapper_bytes', side_effect=self.fixture_wrappers)
        self.font_contract_patch.start()
        self.wrapper_patch.start()
        self.addCleanup(self.font_contract_patch.stop)
        self.addCleanup(self.wrapper_patch.stop)
        self.source_sha = checkout_sha()
        self.files = {
            'index.html': '<a href="https://public.example/root">root</a>',
            'nested/public.html': '<iframe src="https://public.example/nested"></iframe>',
            'data/election-2026.json': json.dumps({
                **{key: 'fixture' for key in (
                    'election', 'area', 'voteDate', 'pollsOpen', 'pollsClose',
                    'numberDrawDate', 'numberDrawTime', 'numberDrawPlace',
                    'candidateListAnnouncementDate', 'councilPlatformPeriodStart',
                    'councilPlatformPeriodEnd',
                )},
                'sources': [{'title': 'source', 'url': 'https://public.example/json'}],
                'publicNote': 'fixture',
            }),
        }

    @staticmethod
    def fixture_wrappers(_artifact_root, _publication):
        return {
            '_headers': b'/*\n  X-Content-Type-Options: nosniff\n',
            '_redirects': b'/ /index.html 200\n',
        }

    def test_public_roster_adds_only_exact_validated_font_paths(self):
        manifest = 'page-font-manifest.json'
        font = ('assets/fonts/huiwen-site-sans/page-core/'
                + 'a' * 64 + '.woff2')
        roster = audit._public_path_roster(
            Path('/fixture/source'), {'index.html'}, {manifest, font},
        )
        self.assertEqual(roster, {'index.html', manifest, font})
        self.assertNotIn('assets/fonts/huiwen-site-sans/page-core/private.json', roster)

    def create_artifact(self, directory, files=None, manifest_files=None,
                        public_record_count=0):
        return write_public_artifact(
            Path(directory) / 'artifact', files or self.files,
            source_sha=self.source_sha, manifest_files=manifest_files,
            public_record_count=public_record_count,
        )

    def test_inventory_reads_only_manifest_listed_public_html_json_including_nested(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / 'source'
            private = source / 'data/achievements.json'
            context = source / 'data/case-context.json'
            private.parent.mkdir(parents=True)
            private.write_text('PRIVATE RAW ACHIEVEMENTS SENTINEL', encoding='utf-8')
            context.write_text('PRIVATE CASE CONTEXT SENTINEL', encoding='utf-8')
            self.create_artifact(base / 'public', self.files)
            artifact = base / 'public/artifact'
            original_read_text = Path.read_text
            touched = []

            def guarded_read_text(path, *args, **kwargs):
                if path in (private, context):
                    touched.append(path)
                    raise AssertionError('private source sentinel was read')
                return original_read_text(path, *args, **kwargs)

            with patch.object(audit.subprocess, 'check_output', return_value=self.source_sha), \
                    patch.object(Path, 'read_text', new=guarded_read_text), \
                    patch.object(audit, 'inventory', side_effect=AssertionError('source inventory used')):
                urls, receipt = audit.inventory_public_artifact(
                    artifact, self.source_sha, source_root=source,
                    expected_public_paths=FIXTURE_PATHS,
                )
            self.assertEqual(touched, [])
            self.assertEqual(set(urls), {
                'https://public.example/root',
                'https://public.example/nested',
                'https://public.example/json',
            })
            self.assertEqual(urls['https://public.example/nested'], {'nested/public.html'})
            self.assertEqual(receipt['sourceCommit'], self.source_sha)
            self.assertRegex(receipt['publicArtifactDigest'], r'^[a-f0-9]{64}$')
            self.assertEqual(receipt['publicFileCount'], 3)

    def run_invalid_artifact_cli(self, artifact, expected_paths=FIXTURE_PATHS,
                                 expected_error=None):
        source_sha = self.source_sha
        stderr = io.StringIO()
        with patch.object(sys, 'argv', [
            'audit_external_links.py', 'report.json', '--public-artifact', str(artifact),
            '--source-sha', source_sha,
        ]), patch.object(audit, '_source_public_paths', return_value=set(expected_paths)), \
                patch.object(audit, 'probe') as probe, contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as raised:
                audit.main()
        self.assertEqual(raised.exception.code, 2)
        probe.assert_not_called()
        if expected_error:
            self.assertIn(expected_error, stderr.getvalue())

    def test_fake_private_paths_fail_before_the_first_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            files = dict(self.files)
            files['data/case-context.json'] = '{"sourceUrl":"https://private.example/"}'
            self.create_artifact(directory, files)
            self.run_invalid_artifact_cli(Path(directory) / 'artifact')

    def test_fake_manifest_private_claims_fail_before_the_first_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            self.create_artifact(directory)
            artifact = Path(directory) / 'artifact'
            manifest_path = artifact / 'publication-manifest.json'
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            manifest['isPublic'] = True
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            deployment = json.loads((artifact / 'deployment.json').read_text(encoding='utf-8'))
            deployment['publicArtifactDigest'] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
            (artifact / 'deployment.json').write_text(json.dumps(deployment), encoding='utf-8')
            self.run_invalid_artifact_cli(artifact)

    def test_wrong_deployment_source_or_manifest_digest_fails_before_the_first_probe(self):
        for field, value in (('sourceCommit', 'c' * 40), ('publicArtifactDigest', 'd' * 64)):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                self.create_artifact(directory)
                artifact = Path(directory) / 'artifact'
                deployment_path = artifact / 'deployment.json'
                deployment = json.loads(deployment_path.read_text(encoding='utf-8'))
                deployment[field] = value
                deployment_path.write_text(json.dumps(deployment), encoding='utf-8')
                self.run_invalid_artifact_cli(artifact)

    def test_missing_file_and_wrong_hash_fail_before_the_first_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            missing_rows = {
                **{key: hashlib.sha256(value.encode()).hexdigest() for key, value in self.files.items()},
                'data/missing.json': hashlib.sha256(b'{}').hexdigest(),
            }
            self.create_artifact(directory, self.files, missing_rows)
            self.run_invalid_artifact_cli(Path(directory) / 'artifact', FIXTURE_PATHS | {'data/missing.json'})

        with tempfile.TemporaryDirectory() as directory:
            bad_hashes = {key: hashlib.sha256(value.encode()).hexdigest() for key, value in self.files.items()}
            bad_hashes['nested/public.html'] = '0' * 64
            self.create_artifact(directory, self.files, bad_hashes)
            self.run_invalid_artifact_cli(Path(directory) / 'artifact')

    def test_raw_achievements_cannot_be_claimed_as_the_public_projection(self):
        with tempfile.TemporaryDirectory() as directory:
            editor = Path(ROOT / 'cms-page-editor.js')
            editor_name = 'cms-page-editor.' + hashlib.sha256(editor.read_bytes()).hexdigest()[:12] + '.js'
            files = {
                'index.html': '<a href="https://public.example/">public</a>',
                'data/achievements-public.json': '[]\n',
                'data/achievements.json': '{"privateNote":"RAW ACHIEVEMENTS SENTINEL"}',
                editor_name: editor.read_bytes(),
            }
            self.create_artifact(directory, files)
            self.run_invalid_artifact_cli(
                Path(directory) / 'artifact', {'index.html', 'data/achievements-public.json'},
            )

    def test_same_schema_valid_raw_array_without_producer_date_fails_before_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            editor = Path(ROOT / 'cms-page-editor.js')
            editor_name = 'cms-page-editor.' + hashlib.sha256(editor.read_bytes()).hexdigest()[:12] + '.js'
            # This row satisfies the public JSON Schema, but it is not a possible
            # build_public.public_records() result because lastRecordDate is absent.
            raw_rows = [{
                'id': 'fixture-case', 'title': '公開測試', 'summary': '公開摘要',
                'status': '持續追蹤', 'categories': [], 'updated': '2026-10-19',
                'sources': [{'title': '公開來源', 'url': 'https://public.example/source'}],
                'history': [],
            }]
            payload = json.dumps(raw_rows, ensure_ascii=False, separators=(',', ':')) + '\n'
            files = {
                'index.html': '<a href="https://public.example/">public</a>',
                'data/achievements-public.json': payload,
                'data/achievements.json': payload,
                editor_name: editor.read_bytes(),
            }
            self.create_artifact(directory, files, public_record_count=1)
            self.run_invalid_artifact_cli(
                Path(directory) / 'artifact',
                {'index.html', 'data/achievements-public.json'},
            )

    def test_b10_projection_private_fields_fail_before_probe(self):
        editor_fields = {
            'election': ('election', 'area', 'voteDate', 'pollsOpen', 'pollsClose',
                         'numberDrawDate', 'numberDrawTime', 'numberDrawPlace',
                         'candidateListAnnouncementDate', 'councilPlatformPeriodStart',
                         'councilPlatformPeriodEnd'),
        }
        fixtures = {
            'data/election-2026.json': {
                **{key: 'fixture' for key in editor_fields['election']},
                'sources': [], 'publicNote': '', 'reviewOnlyUrl': 'https://private.example/election',
            },
            'data/platforms.json': {
                'updated': '2026-10-19', 'publicNote': 'fixture',
                'elections': [{
                    'year': '2026', 'election': 'fixture', 'sections': [{
                        'heading': 'fixture',
                        'items': [{'privateUrl': 'https://private.example/platform'}],
                    }],
                }],
                'coverageNotes': [],
            },
            'data/site-profile.json': {
                'person': {
                    'name': 'fixture', 'displayRole': 'fixture', 'district': 'fixture',
                    'reviewOnlyUrl': 'https://private.example/profile',
                },
                'identity': {
                    'recordAsOf': '2026-10-19', 'confirmedRole': 'fixture',
                    'sourceUrl': 'https://public.example/source',
                },
                'publicNote': 'fixture',
            },
        }
        for relative, value in fixtures.items():
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                files = dict(self.files)
                files[relative] = json.dumps(value, ensure_ascii=False)
                self.create_artifact(directory, files)
                self.run_invalid_artifact_cli(
                    Path(directory) / 'artifact', FIXTURE_PATHS | {relative},
                )

    def test_map_nested_private_url_fails_before_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            editor = Path(ROOT / 'cms-page-editor.js')
            editor_name = 'cms-page-editor.' + hashlib.sha256(editor.read_bytes()).hexdigest()[:12] + '.js'
            records = [{
                'id': 'fixture-case', 'title': '公開測試', 'summary': '公開摘要',
                'status': '持續追蹤', 'categories': [], 'updated': '2026-10-19',
                'sources': [], 'history': [], 'lastRecordDate': '',
            }]
            public_records = json.dumps(records, ensure_ascii=False, separators=(',', ':')) + '\n'
            map_rows = [{
                'id': 'fixture-case', 'status': '持續追蹤', 'lastRecordDate': '',
                'title': {'privateUrl': 'https://private.example/map'},
            }]
            files = {
                'index.html': '<a href="https://public.example/">public</a>',
                'data/achievements-public.json': public_records,
                'data/achievements.json': public_records,
                'data/achievement-map.json': json.dumps(map_rows, ensure_ascii=False),
                editor_name: editor.read_bytes(),
            }
            self.create_artifact(directory, files, public_record_count=1)
            self.run_invalid_artifact_cli(
                Path(directory) / 'artifact',
                {'index.html', 'data/achievements-public.json', 'data/achievement-map.json'},
                expected_error="'title', 'privateUrl'",
            )

    def test_public_map_funding_source_url_is_a_reviewed_inventory_field(self):
        with tempfile.TemporaryDirectory() as directory:
            editor = Path(ROOT / 'cms-page-editor.js')
            editor_name = 'cms-page-editor.' + hashlib.sha256(editor.read_bytes()).hexdigest()[:12] + '.js'
            funding = {
                'basis': '核定總經費', 'currency': 'TWD', 'total': 1, 'centralGrant': 0,
                'approvedOn': '2026-10-01', 'approvalReference': 'fixture',
                'collaboration': 'fixture', 'sourceTitle': 'fixture',
                'sourceUrl': 'https://public.example/funding',
            }
            records = [{
                'id': 'fixture-case', 'title': '公開測試', 'summary': '公開摘要',
                'status': '持續追蹤', 'categories': [], 'updated': '2026-10-19',
                'sources': [], 'history': [], 'lastRecordDate': '', 'funding': funding,
            }]
            public_records = json.dumps(records, ensure_ascii=False, separators=(',', ':')) + '\n'
            map_rows = [{
                'id': 'fixture-case', 'status': '持續追蹤', 'lastRecordDate': '',
                'funding': funding,
            }]
            files = {
                'index.html': '<a href="https://public.example/">public</a>',
                'data/achievements-public.json': public_records,
                'data/achievements.json': public_records,
                'data/achievement-map.json': json.dumps(map_rows, ensure_ascii=False),
                editor_name: editor.read_bytes(),
            }
            self.create_artifact(directory, files, public_record_count=1)
            urls, _receipt = audit.inventory_public_artifact(
                Path(directory) / 'artifact', self.source_sha,
                expected_public_paths={
                    'index.html', 'data/achievements-public.json', 'data/achievement-map.json',
                },
            )
            self.assertIn('https://public.example/funding', urls)

    def test_unreviewed_nested_or_unknown_json_urls_fail_before_probe(self):
        fixtures = {
            'data/election-2026.json': {
                **{key: 'fixture' for key in (
                    'election', 'area', 'voteDate', 'pollsOpen', 'pollsClose',
                    'numberDrawDate', 'numberDrawTime', 'numberDrawPlace',
                    'candidateListAnnouncementDate', 'councilPlatformPeriodStart',
                    'councilPlatformPeriodEnd',
                )},
                'sources': [{'title': {'privateUrl': 'https://private.example/nested'},
                             'url': 'https://public.example/json'}],
                'publicNote': 'fixture',
            },
            'data/events.json': {
                'schemaVersion': 2, 'events': [],
                'reviewOnlyUrl': 'https://private.example/events',
            },
            'data/search-index.json': {
                'version': 1, 'count': 0, 'items': [],
                'reviewOnlyUrl': 'https://private.example/search',
            },
            'data/service-search.json': [{
                'title': 'fixture', 'url': 'public.html', 'description': 'fixture',
                'reviewOnlyUrl': 'https://private.example/service-search',
            }],
            'data/legal-schedule.json': {
                'schemaVersion': 2, 'month': '2026-10', 'observedAt': '2026-10-01',
                'sourceUrl': 'https://www.huiwen.tw/service.html#monthly-heading',
                'sourceTitle': 'fixture',
                'sessions': [{'date': '2026-10-01', 'start': '19:30', 'end': '21:00'}],
                'reviewOnlyUrl': 'https://private.example/schedule',
            },
        }
        for relative, value in fixtures.items():
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                files = dict(self.files)
                files[relative] = json.dumps(value, ensure_ascii=False)
                self.create_artifact(directory, files)
                self.run_invalid_artifact_cli(
                    Path(directory) / 'artifact', FIXTURE_PATHS | {relative},
                )

    def test_search_index_allows_the_producer_intents_string_list(self):
        payload = {
            'version': 1, 'count': 1,
            'items': [{
                'title': 'fixture', 'url': 'fixture.html', 'description': 'fixture',
                'summary': 'fixture', 'type': '頁面', 'keywords': 'fixture',
                'priority': 40, 'intents': ['fixture-intent'],
            }],
        }
        self.assertEqual(audit._public_json_urls('data/search-index.json', payload), ['fixture.html'])

    def test_cms_index_private_field_rows_fail_before_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            editor = Path(ROOT / 'cms-page-editor.js')
            editor_name = 'cms-page-editor.' + hashlib.sha256(editor.read_bytes()).hexdigest()[:12] + '.js'
            index = {
                'schemaVersion': 1, 'path': 'index.html',
                'fields': [{
                    'id': 'main>p:nth-of-type(1)', 'sourceHash': 'a' * 64,
                    'valueHash': 'b' * 64, 'sourceUrl': 'https://private.example/editorial',
                }],
            }
            index_bytes = (json.dumps(index, separators=(',', ':')) + '\n').encode()
            index_name = 'cms-editor-manifests/index.html.' + hashlib.sha256(index_bytes).hexdigest()[:12] + '.json'
            html = (
                '<script data-cms-editor-loader '
                f'data-cms-manifest="/{index_name}" '
                f'data-cms-editor-src="/{editor_name}"></script>'
            )
            files = {
                **self.files,
                'index.html': html,
                editor_name: editor.read_bytes(),
                index_name: index_bytes,
            }
            self.create_artifact(directory, files)
            self.run_invalid_artifact_cli(
                Path(directory) / 'artifact', FIXTURE_PATHS | {editor_name},
            )

    def test_normal_probe_requires_a_verified_public_artifact(self):
        with patch.object(sys, 'argv', ['audit_external_links.py', 'report.json']), \
                patch.object(audit, 'inventory') as source_inventory, \
                patch.object(audit, 'inventory_public_artifact') as public_inventory, \
                patch.object(audit, 'probe') as probe, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                audit.main()
        self.assertEqual(raised.exception.code, 2)
        source_inventory.assert_not_called()
        public_inventory.assert_not_called()
        probe.assert_not_called()

    def test_inventory_only_keeps_the_readonly_source_compatibility_path(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'report.json'
            with patch.object(sys, 'argv', [
                'audit_external_links.py', str(output), '--root', directory, '--inventory-only',
            ]), patch.object(audit, 'inventory', return_value={
                'https://example.com/read-only': {'source.html'},
            }) as source_inventory, patch.object(audit, 'probe') as probe, \
                    contextlib.redirect_stdout(io.StringIO()):
                audit.main()
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(report['state'], 'complete')
            self.assertEqual(report['probeMode'], 'inventory_only')
            self.assertEqual(report['links'][0]['status'], 'NOT_RUN')
            source_inventory.assert_called_once_with(Path(directory))
            probe.assert_not_called()


class ReportPersistenceTests(unittest.TestCase):
    url = 'https://example.com/source'
    inventory = {url: {'fixture.html'}}
    artifact_receipt = {
        'sourceCommit': 'a' * 40,
        'publicArtifactDigest': 'b' * 64,
        'publicFileCount': 3,
        'publicRecordCount': 0,
        'provider': 'cloudflare-static-assets',
    }

    def report_argv(self, output):
        return ['audit_external_links.py', str(output), '--public-artifact', 'fixture-public',
                '--source-sha', 'a' * 40]

    def run_with_first_probe_interrupted(self, output_exists):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as directory:
            output = Path(directory) / 'external-links.json'
            if output_exists:
                output.write_text(json.dumps({
                    'reportVersion': 1, 'state': 'complete', 'checkedAt': 'stale',
                    'finishedAt': 'stale', 'summary': {'PASS': 1}, 'links': [],
                }), encoding='utf-8')
            with patch.object(sys, 'argv', self.report_argv(output)), \
                    patch.object(audit, 'inventory_public_artifact',
                                 return_value=(self.inventory, self.artifact_receipt)), \
                    patch.object(audit, 'probe', side_effect=KeyboardInterrupt) as probe, \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(KeyboardInterrupt):
                    audit.main()
            probe.assert_called_once_with(self.url, {'fixture.html'}, 10, 2, 0.5)
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(report['state'], 'running')
            self.assertEqual(report['links'], [])
            self.assertNotIn('finishedAt', report)
            self.assertNotIn('summary', report)
            self.assertNotEqual(report['checkedAt'], 'stale')

    def test_old_complete_report_is_replaced_before_first_probe(self):
        self.run_with_first_probe_interrupted(output_exists=True)

    def test_missing_output_gets_running_report_before_first_probe(self):
        self.run_with_first_probe_interrupted(output_exists=False)

    def test_failed_initial_report_write_prevents_probe(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as directory:
            output = Path(directory) / 'external-links.json'
            with patch.object(sys, 'argv', self.report_argv(output)), \
                    patch.object(audit, 'inventory_public_artifact',
                                 return_value=(self.inventory, self.artifact_receipt)), \
                    patch.object(audit, '_write_report', side_effect=OSError('fixture write failure')) as write, \
                    patch.object(audit, 'probe') as probe, \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(OSError):
                    audit.main()
            write.assert_called_once()
            probe.assert_not_called()

    def test_later_probe_interrupt_keeps_partial_report_running(self):
        first_result = {
            'url': self.url, 'fingerprint': audit.url_fingerprint(self.url),
            'files': ['fixture.html'], 'status': 'PASS', 'httpStatus': 200,
            'final_url': self.url, 'reason': 'reachable_not_fact_verified',
            'retryClass': 'not_retryable', 'attempts': [],
        }
        urls = {
            'https://example.com/one': {'one.html'},
            'https://example.com/two': {'two.html'},
        }
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as directory:
            output = Path(directory) / 'external-links.json'
            with patch.object(sys, 'argv', self.report_argv(output)), \
                    patch.object(audit, 'inventory_public_artifact',
                                 return_value=(urls, self.artifact_receipt)), \
                    patch.object(audit, 'probe', side_effect=[first_result, KeyboardInterrupt]), \
                    patch.object(audit.time, 'sleep'), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(KeyboardInterrupt):
                    audit.main()
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(report['state'], 'running')
            self.assertEqual(report['links'], [first_result])
            self.assertNotIn('finishedAt', report)
            self.assertNotIn('summary', report)

    def test_successful_run_marks_report_complete(self):
        result = {
            'url': self.url, 'fingerprint': audit.url_fingerprint(self.url),
            'files': ['fixture.html'], 'status': 'PASS', 'httpStatus': 200,
            'final_url': self.url, 'reason': 'reachable_not_fact_verified',
            'retryClass': 'not_retryable', 'attempts': [],
        }
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as directory:
            output = Path(directory) / 'external-links.json'
            with patch.object(sys, 'argv', self.report_argv(output)), \
                    patch.object(audit, 'inventory_public_artifact',
                                 return_value=(self.inventory, self.artifact_receipt)), \
                    patch.object(audit, 'probe', return_value=result), \
                    patch.object(audit.time, 'sleep'), \
                    contextlib.redirect_stdout(io.StringIO()):
                audit.main()
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(report['state'], 'complete')
            self.assertEqual(report['links'], [result])
            self.assertEqual(report['publicArtifact'], self.artifact_receipt)
            self.assertEqual(report['summary'], {'PASS': 1})
            self.assertIn('finishedAt', report)


class ClassificationAndRetryTests(unittest.TestCase):
    def test_only_not_found_responses_are_fail(self):
        self.assertEqual(audit.classify(404), ('FAIL', 'not_found'))
        self.assertEqual(audit.classify(410), ('FAIL', 'not_found'))
        for code, reason in ((401, 'authentication'), (403, 'access_denied'), (429, 'rate_limited')):
            self.assertEqual(audit.classify(code), ('BLOCKED', reason))
        self.assertEqual(audit.classify(None, 'network_error'), ('BLOCKED', 'network_error'))
        self.assertEqual(audit.classify(503), ('BLOCKED', 'server_error'))
        self.assertEqual(audit.classify(None, 'tls_error'), ('BLOCKED', 'tls_error'))
        self.assertFalse(audit.retryable(None, 'tls_error'))
        self.assertTrue(audit.retryable(408, None))

    def test_cli_rejects_unbounded_timeout_before_inventory(self):
        with patch.object(sys, 'argv', ['audit_external_links.py', 'unused.json', '--timeout', '31']), \
                patch.object(audit, 'inventory') as inventory, \
                patch.object(audit, 'inventory_public_artifact') as public_inventory, \
                patch.object(audit, 'probe') as probe, \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                audit.main()
        self.assertEqual(raised.exception.code, 2)
        inventory.assert_not_called()
        public_inventory.assert_not_called()
        probe.assert_not_called()

    def test_403_429_and_auth_are_not_retried(self):
        for code in (401, 403, 407, 429):
            with self.subTest(code=code):
                error = HTTPError('https://example.com/', code, 'fixture', {}, None)
                with patch.object(audit, 'urlopen', side_effect=error) as open_url:
                    result = audit.probe('https://example.com/', [], 1, 2, 0.25)
                self.assertEqual(open_url.call_count, 1)
                self.assertEqual(result['status'], 'BLOCKED')
                self.assertFalse(result['attempts'][0]['retry_scheduled'])

    def test_transient_503_retries_once_and_unknown_stays_blocked(self):
        class Response:
            status = 204
            url = 'https://example.com/'
            def __enter__(self): return self
            def __exit__(self, *args): return False

        temporary = HTTPError('https://example.com/', 503, 'fixture', {}, None)
        with patch.object(audit, 'urlopen', side_effect=[temporary, Response()]) as open_url, \
                patch.object(audit.time, 'sleep') as sleep:
            result = audit.probe('https://example.com/', [], 1, 2, 0.25)
        self.assertEqual(open_url.call_count, 2)
        sleep.assert_called_once_with(0.25)
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['retryClass'], 'recovered_after_retry')
        self.assertTrue(result['attempts'][0]['retry_scheduled'])

        missing = HTTPError('https://example.com/', 404, 'fixture', {}, None)
        with patch.object(audit, 'urlopen', side_effect=[temporary, missing]):
            result = audit.probe('https://example.com/', [], 1, 2, 0.25)
        self.assertEqual(result['status'], 'FAIL')
        self.assertEqual(result['retryClass'], 'terminal_not_found_after_retry')

        with patch.object(audit, 'urlopen', side_effect=OSError('fixture transport failure')):
            result = audit.probe('https://example.com/', [], 1, 2, 0.25)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['reason'], 'network_error')
        self.assertEqual(result['retryClass'], 'bounded_retry_exhausted')


if __name__ == '__main__':
    unittest.main()
