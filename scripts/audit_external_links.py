#!/usr/bin/env python3
"""Bounded, read-only external link audit. Availability is not fact verification."""
from pathlib import Path
from urllib.parse import urlsplit, urldefrag, quote, urlunsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from datetime import datetime, timezone
from bs4 import BeautifulSoup
from collections import Counter
from pathlib import PurePosixPath
import argparse, hashlib, json, os, re, socket, ssl, stat, tempfile, time
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
MAX_TIMEOUT_SECONDS = 30

def canonical_url(raw):
    """Normalize URL identity conservatively; query order and values stay intact."""
    try:
        parsed = urlsplit(urldefrag(raw.strip())[0])
        if parsed.scheme.lower() not in ('http', 'https') or not parsed.hostname:
            return None
        # Never send or persist credentials embedded in a link.
        if parsed.username is not None or parsed.password is not None:
            return None
        scheme = parsed.scheme.lower()
        hostname = parsed.hostname.rstrip('.').encode('idna').decode('ascii').lower()
        port = parsed.port
    except (UnicodeError, ValueError):
        return None
    if ':' in hostname:  # IPv6 literals require brackets in the authority.
        hostname = f'[{hostname}]'
    netloc = hostname
    if port is not None and not ((scheme == 'http' and port == 80) or (scheme == 'https' and port == 443)):
        netloc += f':{port}'
    return urlunsplit((scheme, netloc, parsed.path or '/', parsed.query, ''))

def url_fingerprint(url):
    return 'sha256:' + hashlib.sha256(url.encode('utf-8')).hexdigest()

FORBIDDEN_IMAGE_SOURCE_DOMAINS = (
    'fbcdn.net', 'instagram.com', 'cdninstagram.com', 'googleusercontent.com',
)

def forbidden_image_source_host(raw):
    """Return a disallowed remote image host, without restricting ordinary source links."""
    try:
        parsed = urlsplit(raw)
        host = (parsed.hostname or '').lower().rstrip('.')
    except (TypeError, ValueError):
        return None
    is_remote = parsed.scheme in ('http', 'https') or (not parsed.scheme and bool(parsed.netloc))
    if not is_remote or not host:
        return None
    return next((domain for domain in FORBIDDEN_IMAGE_SOURCE_DOMAINS
                 if host == domain or host.endswith('.' + domain)), None)

def inventory(root):
    urls = {}
    def add(raw, source):
        raw = canonical_url(raw)
        if not raw:
            return
        u = urlsplit(raw)
        if u.hostname in ('www.huiwen.tw', 'huiwen.tw', 'schema.org', 'www.w3.org', 'hong1998tw.github.io'):
            return
        # Calendar links prepare a new event; map tiles are resources, not pages to crawl.
        if u.hostname in ('calendar.google.com', 'tile.openstreetmap.org') or '{' in raw:
            return
        urls.setdefault(raw, set()).add(source)
    for p in sorted(root.glob('*.html')):
        doc = BeautifulSoup(p.read_text(), 'html.parser')
        for node in doc.select('a[href], iframe[src], [data-embed-src]'):
            add(node.get('href') or node.get('src') or node['data-embed-src'], p.name)
    def walk(value, source):
        if isinstance(value, dict):
            for k, v in value.items():
                if isinstance(v, str) and (k.lower().endswith('url') or k == 'url'):
                    add(v, source)
                else: walk(v, source)
        elif isinstance(value, list):
            for v in value: walk(v, source)
    for p in sorted((root/'data').glob('*.json')):
        if p.name != 'search-index.json': walk(json.loads(p.read_text()), str(p.relative_to(root)))
    return urls

_SOURCE_SHA = re.compile(r'^[a-f0-9]{40}$')
_SHA256 = re.compile(r'^[a-f0-9]{64}$')
_CMS_MANIFEST = re.compile(r'^cms-editor-manifests/(.+\.html)\.([a-f0-9]{12})\.json$')
_PUBLIC_JSON_URL_PATHS = {
    'data/achievements-public.json': {
        ('*', 'sources', '*', 'url'), ('*', 'media', '*', 'url'),
        ('*', 'funding', 'sourceUrl'), ('*', 'imageMetadata', '*', 'sourceUrl'),
        ('*', 'villageHeadPartners', '*', 'source', 'url'),
    },
    'data/achievements.json': {
        ('*', 'sources', '*', 'url'), ('*', 'media', '*', 'url'),
        ('*', 'funding', 'sourceUrl'), ('*', 'imageMetadata', '*', 'sourceUrl'),
        ('*', 'villageHeadPartners', '*', 'source', 'url'),
    },
    'data/achievement-map.json': {('*', 'funding', 'sourceUrl')},
    'data/election-2026.json': {('sources', '*', 'url')},
    'data/platforms.json': {
        ('elections', '*', 'sourceUrl'), ('coverageNotes', '*', 'sourceUrl'),
    },
    'data/site-profile.json': {('identity', 'sourceUrl')},
    'data/events.json': {
        ('events', '*', 'sourceUrl'), ('events', '*', 'registrationUrl'),
    },
    'data/search-index.json': {('items', '*', 'url')},
    'data/legal-schedule.json': {('sourceUrl',), ('history', '*', 'sourceUrl')},
    'data/service-search.json': {('*', 'url')},
}


def _path_matches(pattern, actual):
    return len(pattern) == len(actual) and all(
        expected == '*' or expected == part for expected, part in zip(pattern, actual)
    )


def _public_json_urls(relative, payload):
    """Validate URL-bearing field locations before inventorying any public JSON."""
    import build_events

    try:
        if relative == 'data/events.json':
            build_events.public_events(payload)
        elif relative == 'data/legal-schedule.json':
            from build_service import validate_schedule
            validate_schedule(payload)
        elif relative == 'data/service-search.json':
            import build_search
            if not isinstance(payload, list):
                raise ValueError('service-search must be an array')
            for row in payload:
                if not isinstance(row, dict) or not isinstance(row.get('url'), str):
                    raise ValueError('service-search rows need a local URL')
                if not build_search.route_key(row['url']):
                    raise ValueError('service-search URL must be a local public route')
        elif relative == 'data/search-index.json':
            import build_search
            if (not isinstance(payload, dict) or set(payload) != {'version', 'count', 'items'}
                    or type(payload.get('version')) is not int or payload['version'] != 1
                    or type(payload.get('count')) is not int
                    or not isinstance(payload.get('items'), list)
                    or payload['count'] != len(payload['items'])):
                raise ValueError('search-index has an invalid producer schema')
            required = {'title', 'url', 'description', 'summary', 'type', 'keywords', 'priority'}
            optional = {'primaryRegion', 'recordStage', 'lastRecordDate', 'categories'}
            for row in payload['items']:
                if (not isinstance(row, dict) or required - row.keys()
                        or row.keys() - (required | optional)
                        or any(not isinstance(row.get(key), str)
                               for key in ('title', 'url', 'description', 'summary', 'type', 'keywords'))
                        or type(row.get('priority')) is not int
                        or ('categories' in row and (not isinstance(row['categories'], list)
                                                     or any(not isinstance(item, str) for item in row['categories'])))
                        or not build_search.route_key(row['url'])):
                    raise ValueError('search-index item has an invalid producer schema')
    except (KeyError, TypeError, IndexError) as error:
        raise ValueError(f'{relative} does not match its public producer contract') from error

    allowed = _PUBLIC_JSON_URL_PATHS.get(relative, set())
    found = []

    def walk(value, path=()):
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = path + (key,)
                if isinstance(key, str) and key.lower().endswith('url'):
                    if not any(_path_matches(pattern, child_path) for pattern in allowed):
                        raise ValueError(f'{relative} has an unreviewed URL field at {child_path!r}')
                    if child is not None and not isinstance(child, str):
                        raise ValueError(f'{relative} has a non-text URL field at {child_path!r}')
                    if isinstance(child, str):
                        found.append(child)
                walk(child, child_path)
        elif isinstance(value, list):
            for child in value:
                walk(child, path + ('*',))

    walk(payload)
    return found


def _load_json_no_duplicate_keys(path, label):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f'{label}: duplicate JSON key {key!r}')
            result[key] = value
        return result

    try:
        return json.loads(Path(path).read_text(encoding='utf-8'), object_pairs_hook=unique_object)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f'{label}: unreadable JSON') from error


def _source_public_paths(source_root):
    import build_public
    return set(build_public.public_paths(Path(source_root)))


def _public_path_roster(source_root, source_paths):
    """Return the build_public allowlist plus its documented generated outputs."""
    roster = set(source_paths)
    if 'data/achievements-public.json' in source_paths:
        roster.add('data/achievements.json')  # Safe compatibility projection emitted by build_public.
        editor = Path(source_root) / 'cms-page-editor.js'
        if not editor.is_file() or editor.is_symlink():
            raise ValueError('public source is missing its reviewed CMS editor asset')
        editor_name = 'cms-page-editor.' + hashlib.sha256(editor.read_bytes()).hexdigest()[:12] + '.js'
        roster.add(editor_name)
    return roster


def _cloudflare_wrapper_bytes():
    import build_cloudflare_public
    import build_public
    redirects = ['/ /index.html 200']
    redirects.extend('/' + path.removesuffix('index.html') + ' /' + path + ' 200'
                     for path in build_public.LEGACY_PAGES)
    return {
        '_headers': build_cloudflare_public.render_headers().encode('utf-8'),
        '_redirects': ('\n'.join(redirects) + '\n').encode('utf-8'),
    }


def _safe_manifest_path(value):
    if not isinstance(value, str) or not value or '\\' in value or any(ord(char) < 32 for char in value):
        return False
    path = PurePosixPath(value)
    return (not path.is_absolute() and path.as_posix() == value
            and all(part not in ('', '.', '..') for part in value.split('/')))


def _cms_page_from_manifest_path(relative):
    match = _CMS_MANIFEST.fullmatch(relative)
    return match.group(1) if match else None


def _validate_cms_index(editor_index, relative):
    if (not isinstance(editor_index, dict)
            or set(editor_index) != {'schemaVersion', 'path', 'fields'}
            or type(editor_index.get('schemaVersion')) is not int
            or editor_index.get('schemaVersion') != 1
            or editor_index.get('path') != relative
            or not isinstance(editor_index.get('fields'), list)
            or not editor_index['fields']):
        raise ValueError('public CMS index does not match its route and content hash: ' + relative)
    seen = set()
    for field in editor_index['fields']:
        if (not isinstance(field, dict)
                or set(field) != {'id', 'sourceHash', 'valueHash'}
                or not isinstance(field.get('id'), str)
                or not field['id']
                or not isinstance(field.get('sourceHash'), str)
                or not _SHA256.fullmatch(field['sourceHash'])
                or not isinstance(field.get('valueHash'), str)
                or not _SHA256.fullmatch(field['valueHash'])
                or field['id'] in seen):
            raise ValueError('public CMS index contains an invalid editable field: ' + relative)
        seen.add(field['id'])


def validate_public_artifact(artifact_root, expected_source_sha, *, source_root=None,
                             expected_public_paths=None):
    """Validate the canonical public package and its deployment receipt before any probe."""
    if not isinstance(expected_source_sha, str) or not _SOURCE_SHA.fullmatch(expected_source_sha):
        raise ValueError('a full lowercase source SHA is required for public artifact probing')
    artifact_arg = Path(artifact_root)
    if artifact_arg.is_symlink() or not artifact_arg.is_dir():
        raise ValueError('public artifact root must be an existing regular directory')
    root = artifact_arg.resolve(strict=True)
    source_root = Path(source_root or ROOT).resolve()
    try:
        checkout_sha = subprocess.check_output(
            ['git', 'rev-parse', 'HEAD'], cwd=source_root, text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError('could not verify the checked-out source commit') from error
    if checkout_sha != expected_source_sha:
        raise ValueError('requested source SHA does not match the checked-out source commit')
    source_paths = (set(expected_public_paths) if expected_public_paths is not None
                    else _source_public_paths(source_root))
    allowed_paths = _public_path_roster(source_root, source_paths)

    manifest_path = root / 'publication-manifest.json'
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError('public artifact is missing publication-manifest.json')
    manifest = _load_json_no_duplicate_keys(manifest_path, 'publication-manifest.json')
    if (not isinstance(manifest, dict)
            or set(manifest) != {'version', 'publicRecordCount', 'files'}
            or type(manifest.get('version')) is not int
            or manifest.get('version') != 1
            or isinstance(manifest.get('publicRecordCount'), bool)
            or not isinstance(manifest.get('publicRecordCount'), int)
            or manifest['publicRecordCount'] < 0
            or not isinstance(manifest.get('files'), dict)
            or not manifest['files']):
        raise ValueError('publication-manifest.json: unsupported or incomplete public manifest')

    files = manifest['files']
    for relative, digest in files.items():
        if not _safe_manifest_path(relative):
            raise ValueError('publication manifest contains an unsafe path')
        if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
            raise ValueError('publication manifest contains an invalid SHA-256')
        if relative not in allowed_paths and not _cms_page_from_manifest_path(relative):
            raise ValueError('publication manifest path is outside the reviewed public path closure: ' + relative)
        cms_page = _cms_page_from_manifest_path(relative)
        if cms_page and cms_page not in source_paths:
            raise ValueError('publication manifest CMS index points outside a reviewed public HTML route')

    required = set(source_paths)
    required.update(allowed_paths - set(source_paths))
    missing = sorted(required - set(files))
    if missing:
        raise ValueError('publication manifest omits a required public path: ' + missing[0])

    deployment_path = root / 'deployment.json'
    if deployment_path.is_symlink() or not deployment_path.is_file():
        raise ValueError('public artifact is missing deployment.json')
    deployment = _load_json_no_duplicate_keys(deployment_path, 'deployment.json')
    manifest_bytes = manifest_path.read_bytes()
    manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()
    expected_deployment = {
        'schemaVersion': 1,
        'provider': 'cloudflare-static-assets',
        'sourceCommit': expected_source_sha,
        'publicArtifactDigest': manifest_digest,
        'publicFileCount': len(files),
        'publicRecordCount': manifest['publicRecordCount'],
    }
    if (not isinstance(deployment, dict)
            or type(deployment.get('schemaVersion')) is not int
            or type(deployment.get('publicFileCount')) is not int
            or type(deployment.get('publicRecordCount')) is not int
            or deployment != expected_deployment):
        raise ValueError('deployment.json does not identify this source SHA and publication manifest digest')

    wrappers = _cloudflare_wrapper_bytes()
    expected_files = set(files) | {'publication-manifest.json', 'deployment.json', *wrappers}
    actual_files = set()
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('public artifact contains a symlink: ' + path.relative_to(root).as_posix())
        if path.is_file():
            actual_files.add(path.relative_to(root).as_posix())
    if actual_files != expected_files:
        unexpected = sorted(actual_files - expected_files)
        missing_files = sorted(expected_files - actual_files)
        if unexpected:
            raise ValueError('public artifact contains an unmanifested file: ' + unexpected[0])
        raise ValueError('public artifact is missing a manifest-listed file: ' + missing_files[0])

    for relative, expected in files.items():
        path = root.joinpath(*PurePosixPath(relative).parts)
        if path.is_symlink() or not path.is_file():
            raise ValueError('publication manifest references a missing or unsafe file: ' + relative)
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('publication manifest SHA-256 mismatch: ' + relative)
    for relative, expected in wrappers.items():
        if (root / relative).read_bytes() != expected:
            raise ValueError('public deployment wrapper differs from the reviewed builder: ' + relative)

    cms_manifest_paths = {relative for relative in files if _cms_page_from_manifest_path(relative)}
    referenced_manifests = set()
    for relative in sorted(files):
        if PurePosixPath(relative).suffix.lower() != '.html':
            continue
        html_path = root.joinpath(*PurePosixPath(relative).parts)
        page = BeautifulSoup(html_path.read_text(encoding='utf-8'), 'html.parser')
        for loader in page.select('script[data-cms-editor-loader]'):
            manifest_uri = loader.get('data-cms-manifest', '')
            if not manifest_uri.startswith('/cms-editor-manifests/'):
                raise ValueError('public HTML has an invalid CMS manifest reference: ' + relative)
            manifest_relative = manifest_uri.lstrip('/')
            if manifest_relative not in cms_manifest_paths:
                raise ValueError('public HTML references an unmanifested CMS index: ' + relative)
            if _cms_page_from_manifest_path(manifest_relative) != relative:
                raise ValueError('public HTML references a CMS index for another route: ' + relative)
            editor_uri = loader.get('data-cms-editor-src', '')
            if not editor_uri.startswith('/cms-page-editor.') or editor_uri.lstrip('/') not in files:
                raise ValueError('public HTML references an unmanifested CMS editor asset: ' + relative)
            editor_index_path = root / manifest_relative
            editor_index = _load_json_no_duplicate_keys(editor_index_path, manifest_relative)
            filename_hash = _CMS_MANIFEST.fullmatch(manifest_relative).group(2)
            if hashlib.sha256(editor_index_path.read_bytes()).hexdigest()[:12] != filename_hash:
                raise ValueError('public CMS index does not match its route and content hash: ' + relative)
            _validate_cms_index(editor_index, relative)
            referenced_manifests.add(manifest_relative)
    if referenced_manifests != cms_manifest_paths:
        raise ValueError('publication manifest contains an unreferenced CMS index')

    import build_public
    for relative in sorted(build_public.PUBLIC_DATA_PROJECTIONS & files.keys()):
        try:
            projection = _load_json_no_duplicate_keys(root / relative, relative)
            build_public.validate_public_projection(relative, projection)
        except (ValueError, TypeError, KeyError, IndexError) as error:
            raise ValueError(f'{relative} does not match its reviewed public projection: {error}') from error

    if 'data/achievements-public.json' in files:
        public_projection = (root / 'data/achievements-public.json').read_bytes()
        legacy_projection = (root / 'data/achievements.json').read_bytes()
        if legacy_projection != public_projection:
            raise ValueError('data/achievements.json is not byte-identical to the public achievements projection')
        schema_path = source_root / 'schema/public-achievement.schema.json'
        schema = _load_json_no_duplicate_keys(schema_path, 'public achievement schema')
        try:
            records = _load_json_no_duplicate_keys(root / 'data/achievements-public.json',
                                                   'data/achievements-public.json')
            build_public.validate_schema(records, schema)
            if not isinstance(records, list) or len(records) != manifest['publicRecordCount']:
                raise ValueError('publicRecordCount differs from the public achievements array')
            from achievement_metadata import is_public, latest_history_event
            ids = []
            for record in records:
                if not is_public(record):
                    raise ValueError('public achievements contains a non-public status')
                ids.append(record['id'])
                latest = latest_history_event(record['history'])
                expected_date = latest.get('date', '') if latest else ''
                if record.get('lastRecordDate') != expected_date:
                    raise ValueError('lastRecordDate differs from canonical latest history ordering')
            if len(set(ids)) != len(ids):
                raise ValueError('public achievements contains duplicate record IDs')
        except (ValueError, json.JSONDecodeError, TypeError, KeyError) as error:
            raise ValueError('public achievements projection does not match its reviewed schema') from error

    if 'data/achievement-map.json' in files:
        if 'data/achievements-public.json' not in files:
            raise ValueError('public achievement map has no reviewed achievements projection')
        try:
            map_rows = _load_json_no_duplicate_keys(root / 'data/achievement-map.json',
                                                    'data/achievement-map.json')
            records = _load_json_no_duplicate_keys(root / 'data/achievements-public.json',
                                                   'data/achievements-public.json')
            if not isinstance(map_rows, list) or len(map_rows) != len(records):
                raise ValueError('public achievement map row count differs from its projection')
            by_id = {record['id']: record for record in records}
            if len(by_id) != len(records) or {row.get('id') for row in map_rows} != set(by_id):
                raise ValueError('public achievement map IDs differ from its projection')
            from achievement_metadata import is_public
            for row in map_rows:
                if not isinstance(row, dict):
                    raise ValueError('public achievement map row must be an object')
                record = by_id[row['id']]
                if (row.keys() - build_public.MAP_FIELDS or not is_public(row)
                        or row.get('funding') != record.get('funding')
                        or row.get('lastRecordDate') != record.get('lastRecordDate')):
                    raise ValueError('public achievement map contains a non-public or mismatched field')
                history = row.get('history', [])
                if not isinstance(history, list):
                    raise ValueError('public achievement map history must be an array')
                for event in history:
                    if not isinstance(event, dict) or event.keys() - {'date', 'title', 'text'}:
                        raise ValueError('public achievement map history contains a review-only field')
        except (ValueError, TypeError, KeyError) as error:
            raise ValueError('public achievement map does not match its reviewed public projection') from error

    return {
        'root': root,
        'manifest': manifest,
        'files': files,
        'sourceCommit': expected_source_sha,
        'publicArtifactDigest': manifest_digest,
        'publicFileCount': len(files),
        'publicRecordCount': manifest['publicRecordCount'],
        'provider': deployment['provider'],
    }


def inventory_public_artifact(artifact_root, expected_source_sha, *, source_root=None,
                              expected_public_paths=None):
    """Inventory only manifest-listed public HTML/JSON, including nested routes."""
    package = validate_public_artifact(
        artifact_root, expected_source_sha, source_root=source_root,
        expected_public_paths=expected_public_paths,
    )
    root = package['root']
    urls = {}

    def add(raw, source):
        raw = canonical_url(raw)
        if not raw:
            return
        parsed = urlsplit(raw)
        if parsed.hostname in ('www.huiwen.tw', 'huiwen.tw', 'schema.org', 'www.w3.org', 'hong1998tw.github.io'):
            return
        if parsed.hostname in ('calendar.google.com', 'tile.openstreetmap.org') or '{' in raw:
            return
        urls.setdefault(raw, set()).add(source)

    for relative in sorted(package['files']):
        suffix = PurePosixPath(relative).suffix.lower()
        path = root.joinpath(*PurePosixPath(relative).parts)
        if suffix == '.html':
            doc = BeautifulSoup(path.read_text(encoding='utf-8'), 'html.parser')
            for node in doc.select('a[href], iframe[src], [data-embed-src]'):
                add(node.get('href') or node.get('src') or node['data-embed-src'], relative)
        elif suffix == '.json':
            payload = _load_json_no_duplicate_keys(path, relative)
            for raw in _public_json_urls(relative, payload):
                add(raw, relative)
    receipt = {key: package[key] for key in (
        'sourceCommit', 'publicArtifactDigest', 'publicFileCount',
        'publicRecordCount', 'provider',
    )}
    return urls, receipt

def classify(code, error_class=None):
    if code in (404, 410): return 'FAIL', 'not_found'
    if code is not None and 200 <= code < 400: return 'PASS', 'reachable_not_fact_verified'
    if code is None:
        return 'BLOCKED', error_class or 'unknown_result'
    reasons = {
        401: 'authentication', 403: 'access_denied', 407: 'proxy_authentication',
        408: 'request_timeout', 429: 'rate_limited',
    }
    if code in reasons: return 'BLOCKED', reasons[code]
    if 500 <= code < 600: return 'BLOCKED', 'server_error'
    return 'BLOCKED', 'unexpected_http_status'

def classify_error(exc):
    reason = exc.reason if isinstance(exc, URLError) else exc
    if isinstance(reason, ssl.SSLError): return 'tls_error'
    if isinstance(reason, (TimeoutError, socket.timeout)): return 'timeout'
    if isinstance(exc, ValueError): return 'invalid_request'
    if isinstance(exc, (URLError, OSError)): return 'network_error'
    return 'unknown_transport_error'

def retryable(code, error_class):
    if code in (401, 403, 404, 407, 410, 429) or (code is not None and 200 <= code < 400):
        return False
    if code == 408 or (code is not None and 500 <= code < 600):
        return True
    return code is None and error_class in ('timeout', 'network_error')

def retry_class(attempts, status):
    if len(attempts) > 1:
        if status == 'PASS': return 'recovered_after_retry'
        if status == 'FAIL': return 'terminal_not_found_after_retry'
        return 'bounded_retry_exhausted'
    if attempts and attempts[-1]['retryable']:
        return 'retryable_but_single_attempt'
    return 'not_retryable'

def probe(url, files, timeout, attempts, interval):
    receipt = []
    for attempt in range(attempts):
        code, final, error = None, None, None
        try:
            target = quote(url, safe=':/%?=&+#,;@!()+')
            with urlopen(Request(target, headers={'User-Agent':'Mozilla/5.0 (public website maintenance; link availability)'}), timeout=timeout) as response:
                code, final = response.status, response.url
        except HTTPError as exc:
            code = exc.code
        except (URLError, TimeoutError, ValueError, OSError) as exc:
            error = classify_error(exc)
        can_retry = retryable(code, error)
        will_retry = can_retry and attempt + 1 < attempts
        receipt.append({
            'attempt':attempt+1,'http_status':code,'error_class':error,
            'retryable':can_retry,'retry_scheduled':will_retry,
            'observed_at':datetime.now(timezone.utc).isoformat(),
        })
        if not will_retry:
            break  # In particular, do not retry authentication or rate-limit responses.
        time.sleep(interval)
    status, reason = classify(code, error)
    return {
        'url':url,'fingerprint':url_fingerprint(url),'files':sorted(files),
        'status':status,'httpStatus':code,'final_url':final,'reason':reason,
        'retryClass':retry_class(receipt, status),'attempts':receipt,
    }

def _write_report(output, report):
    payload = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='w', encoding='utf-8', dir=output.parent,
            prefix=f'.{output.name}.', suffix='.tmp', delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if output.exists():
            os.chmod(temporary, stat.S_IMODE(output.stat().st_mode))
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('output',type=Path,nargs='?',default=Path('external-links.json'))
    source_mode=p.add_mutually_exclusive_group()
    source_mode.add_argument('--root',type=Path,help='source tree; inventory-only compatibility path')
    source_mode.add_argument('--public-artifact',type=Path,
                             help='verified publication artifact used for HTTP probing')
    p.add_argument('--source-sha',help='full checkout SHA bound to deployment.json')
    p.add_argument('--timeout',type=float,default=10)
    p.add_argument('--attempts',type=int,choices=(1,2),default=2)
    p.add_argument('--interval',type=float,default=0.5)
    p.add_argument('--inventory-only',action='store_true')
    a=p.parse_args()
    if a.timeout <= 0 or a.timeout > MAX_TIMEOUT_SECONDS or a.interval < 0.25:
        p.error('timeout must be greater than 0 and at most 30 seconds; interval must be at least 0.25 seconds')
    if a.source_sha and not a.public_artifact:
        p.error('--source-sha can only be used with --public-artifact')
    if not a.inventory_only and not a.public_artifact:
        p.error('HTTP probing requires --public-artifact PATH and --source-sha; use --inventory-only for source inventory')
    artifact_receipt = None
    if a.public_artifact:
        if not a.source_sha:
            p.error('--public-artifact requires --source-sha')
        try:
            urls, artifact_receipt = inventory_public_artifact(a.public_artifact, a.source_sha)
        except (OSError, ValueError) as error:
            p.error(f'public artifact validation failed before probing: {error}')
    else:
        urls=inventory(a.root or ROOT)
    start=datetime.now(timezone.utc).isoformat()
    report={
        'reportVersion':1,'state':'running','checkedAt':start,
        'probeMode':'inventory_only' if a.inventory_only else 'public_artifact_http_get',
        'limits':{'timeoutSeconds':a.timeout,'maximumTimeoutSeconds':MAX_TIMEOUT_SECONDS,'maxAttempts':a.attempts,'intervalSeconds':a.interval,'minimumIntervalSeconds':0.25},
        'method':'Sequential GET response headers only; no response bodies, submissions, tile downloads or authentication bypass. HTTP PASS is not evidence of article accuracy.',
        'links':[],
    }
    if artifact_receipt is not None:
        report['publicArtifact']=artifact_receipt
    a.output.parent.mkdir(parents=True,exist_ok=True)
    _write_report(a.output, report)
    for url, files in sorted(urls.items()):
        row={
            'url':url,'fingerprint':url_fingerprint(url),'files':sorted(files),
            'status':'NOT_RUN','reason':'inventory_only','retryClass':'not_run','attempts':[],
        } if a.inventory_only else probe(url,files,a.timeout,a.attempts,a.interval)
        report['links'].append(row)
        _write_report(a.output, report)
        if not a.inventory_only: time.sleep(a.interval)
    report['state']='complete';report['finishedAt']=datetime.now(timezone.utc).isoformat();report['summary']=dict(Counter(r['status'] for r in report['links']))
    _write_report(a.output, report);print(json.dumps({'total':len(urls),**report['summary']}))
if __name__=='__main__': main()
