"""Derive the public Service Worker from the completed, allowlisted artifact."""
from __future__ import annotations

import hashlib
import json
import posixpath
import re
from html.parser import HTMLParser
from pathlib import Path
from pathlib import PurePosixPath
from urllib.parse import parse_qsl, unquote, urljoin, urlsplit


PUBLIC_ORIGIN = 'https://www.huiwen.tw'
OFFLINE_PATH = 'offline.html'
EXCLUDED_CLOSURE_PATHS = {
    'sw.js', 'publication-manifest.json', '_headers', '_redirects', 'deployment.json',
}
CACHE_RE = re.compile(r"(?m)^const CACHE=['\"][^'\"]*['\"];[ \t]*$")
SHELL_RE = re.compile(r'(?m)^const SHELL=\[[^\r\n]*\];[ \t]*$')
REQUIRED_SHELL_RE = re.compile(r'(?m)^const REQUIRED_SHELL=\[[^\r\n]*\];[ \t]*$')
OFFLINE_RE = re.compile(r"(?m)^const OFFLINE=['\"]\./offline\.html['\"];[ \t]*$")
POLICY_MARKER = '/* {{CACHE_POLICY}} */'
POLICY_START_MARKER = '/* BEGIN HUIWEN SW CACHE POLICY */'
POLICY_END_MARKER = '/* END HUIWEN SW CACHE POLICY */'
CORE_FONT_RE = re.compile(
    r'^/assets/fonts/huiwen-site-sans/generated/huiwen-index-core-[0-9a-f]{12}\.woff2$'
)
PRIVATE_QUERY_RE = re.compile(
    r'^(?:cms[a-z0-9_-]*|draft|private|preview[a-z0-9_-]*|[a-z0-9_-]*(?:token|session)[a-z0-9_-]*)$',
    re.I,
)


class _HTMLShellReferences(HTMLParser):
    """Collect explicit safe resources from one public HTML document."""

    def __init__(self, document_path: str, *, include_legacy_core_font: bool = False) -> None:
        super().__init__(convert_charrefs=True)
        self.document_path = document_path
        self.include_legacy_core_font = include_legacy_core_font
        self.references: list[str] = []
        self.core_fonts = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        values = dict(attrs)
        raw = values.get('href') if tag == 'link' else values.get('src') if tag == 'script' else None
        if not raw:
            return

        rel = set((values.get('rel') or '').lower().split())
        path = _safe_public_path(raw, self.document_path)
        if path is None:
            return

        if tag == 'link' and 'stylesheet' in rel and path.endswith('.css'):
            self.references.append(raw)
        elif tag == 'link' and rel.intersection({'icon', 'apple-touch-icon', 'mask-icon'}):
            self.references.append(raw)
        elif tag == 'link' and 'manifest' in rel and path.endswith('.webmanifest'):
            self.references.append(raw)
        elif (self.include_legacy_core_font and tag == 'link' and values.get('as', '').lower() == 'font'
              and values.get('type', '').lower() == 'font/woff2'
              and CORE_FONT_RE.fullmatch(path)):
            self.references.append(raw)
            self.core_fonts += 1
        elif tag == 'script' and path.endswith('.js'):
            self.references.append(raw)


def _safe_public_path(raw: str, document_path: str = 'index.html') -> str | None:
    """Return a safe root-relative artifact path, excluding private/runtime URLs."""
    try:
        resolved = urlsplit(urljoin(PUBLIC_ORIGIN + '/' + document_path, raw))
        port = resolved.port
    except ValueError:
        return None
    if (resolved.scheme != 'https' or resolved.hostname != 'www.huiwen.tw'
            or port not in (None, 443) or resolved.username or resolved.password):
        return None
    if any(PRIVATE_QUERY_RE.fullmatch(key)
           for key, _ in parse_qsl(resolved.query, keep_blank_values=True)):
        return None

    decoded = unquote(resolved.path)
    if not decoded.startswith('/') or any(part == '..' for part in decoded.split('/')):
        return None
    path = posixpath.normpath(decoded)
    if not path.startswith('/') or path == '/':
        return None

    lowered = path.lower()
    segments = set(lowered.strip('/').split('/'))
    if (segments.intersection({'admin', 'api', 'cms', 'draft', 'drafts', 'preview', 'previews', 'runtime'})
            or any(part.startswith('cms-') for part in lowered.strip('/').split('/'))):
        return None
    if lowered.startswith(('/cms-editor-manifests/', '/cms-page-editor')):
        return None
    if Path(path).name.startswith('cms-page-editor.'):
        return None
    if lowered.endswith(('.json', '.geojson', '.xml')) and not lowered.endswith('.webmanifest'):
        return None
    return path


def _append_references(result: list[str], seen: set[str], parser: _HTMLShellReferences,
                       artifact_dir: Path, document_path: str, html_bytes: bytes | None = None) -> None:
    payload = html_bytes if html_bytes is not None else (artifact_dir / document_path).read_bytes()
    parser.feed(payload.decode('utf-8'))
    for raw in parser.references:
        absolute = urlsplit(urljoin(PUBLIC_ORIGIN + '/' + document_path, raw))
        path = _safe_public_path(raw, document_path)
        if path is None:
            continue
        target = _safe_artifact_file(path, artifact_dir, 'HTML shell reference')
        value = '.' + path + (('?' + absolute.query) if absolute.query else '')
        if value not in seen:
            result.append(value)
            seen.add(value)


def _safe_artifact_file(path: str, artifact_dir: Path, label: str) -> Path:
    relative_path = path[1:] if path.startswith('/') else path
    candidate = PurePosixPath(relative_path)
    if (not relative_path or candidate.as_posix() != relative_path or candidate.is_absolute()
            or '..' in candidate.parts or '\\' in relative_path):
        raise ValueError(f'{label} has an unsafe path: ' + path)
    target = artifact_dir.joinpath(*candidate.parts)
    if (target.is_symlink() or not target.is_file()
            or artifact_dir.resolve() not in target.resolve().parents):
        raise ValueError(f'{label} is missing or unsafe: ' + path)
    return target


def _validated_route_preloads(route: str, routes: dict, fonts: dict, artifact_dir: Path) -> list[str]:
    row = routes.get(route)
    if not isinstance(row, dict):
        raise ValueError('Validated page-font route is missing: ' + route)
    common, delta = row.get('commonFont'), row.get('deltaFont')
    if (not isinstance(common, str) or not isinstance(delta, str)
            or row.get('preloads') != [common, delta]
            or not isinstance(fonts.get(common), dict) or not isinstance(fonts.get(delta), dict)):
        raise ValueError('Validated page-font preload pair is invalid: ' + route)
    for path in (common, delta):
        _safe_artifact_file(path, artifact_dir, 'Validated page-font asset')
    return ['./' + common, './' + delta]


def _shell_plan(index_html: bytes, artifact_dir: Path, routes: dict, fonts: dict) -> tuple[list[str], list[str]]:
    """Return exact optional SHELL URLs and the offline route's required font pair."""
    index = _HTMLShellReferences('index.html', include_legacy_core_font=True)
    result = ['./index.html']
    seen = set(result)
    _append_references(result, seen, index, artifact_dir, 'index.html', index_html)
    if 'index.html' not in routes and index.core_fonts == 0:
        raise ValueError('Public index is missing its generated core font preload')
    if 'index.html' in routes:
        for value in _validated_route_preloads('index.html', routes, fonts, artifact_dir):
            if value not in seen:
                result.append(value)
                seen.add(value)

    _safe_artifact_file(OFFLINE_PATH, artifact_dir, 'Required offline document')
    offline = _HTMLShellReferences(OFFLINE_PATH)
    _append_references(result, seen, offline, artifact_dir, OFFLINE_PATH)
    offline_url = './' + OFFLINE_PATH
    if offline_url not in seen:
        result.append(offline_url)
        seen.add(offline_url)
    required_fonts = _validated_route_preloads(OFFLINE_PATH, routes, fonts, artifact_dir)
    for value in required_fonts:
        if value not in seen:
            result.append(value)
            seen.add(value)
    return result, required_fonts


def shell_urls(index_html: bytes, artifact_dir: Path, routes: dict, fonts: dict) -> list[str]:
    """Derive exact install URLs from public HTML and validated route rows."""
    return _shell_plan(index_html, Path(artifact_dir), routes, fonts)[0]


def _policy_offsets(text: str) -> tuple[int, int, int, int]:
    """Locate the one canonical policy block embedded in the root worker."""
    if text.count(POLICY_START_MARKER) != 1 or text.count(POLICY_END_MARKER) != 1:
        raise ValueError('Service Worker template must contain one delimited cache policy block')
    block_start = text.index(POLICY_START_MARKER)
    body_start = block_start + len(POLICY_START_MARKER)
    body_end = text.index(POLICY_END_MARKER, body_start)
    block_end = body_end + len(POLICY_END_MARKER)
    if body_end < body_start or not text[body_start:body_end].strip():
        raise ValueError('Service Worker cache policy block must not be empty')
    return block_start, body_start, body_end, block_end


def _cache_policy_source(template: bytes) -> bytes:
    """Return the exact policy source used by both raw and emitted workers."""
    try:
        text = template.decode('utf-8')
    except UnicodeDecodeError as error:
        raise ValueError('Service Worker template must be UTF-8') from error
    _, body_start, body_end, _ = _policy_offsets(text)
    return text[body_start:body_end].encode('utf-8')


def _normalized_template(template: bytes) -> bytes:
    try:
        text = template.decode('utf-8')
    except UnicodeDecodeError as error:
        raise ValueError('Service Worker template must be UTF-8') from error
    text, cache_count = CACHE_RE.subn("const CACHE='{{CACHE}}';", text)
    text, shell_count = SHELL_RE.subn('const SHELL={{SHELL}};', text)
    text, required_shell_count = REQUIRED_SHELL_RE.subn(
        'const REQUIRED_SHELL={{REQUIRED_SHELL}};', text,
    )
    if POLICY_MARKER in text:
        raise ValueError('Service Worker template must not contain an unresolved cache policy marker')
    block_start, _, _, block_end = _policy_offsets(text)
    text = text[:block_start] + POLICY_MARKER + text[block_end:]
    policy_count = text.count(POLICY_MARKER)
    offline_count = len(OFFLINE_RE.findall(text))
    if (cache_count != 1 or shell_count != 1 or required_shell_count != 1
            or policy_count != 1 or offline_count != 1):
        raise ValueError('Service Worker template must contain one supported CACHE, SHELL, REQUIRED_SHELL, delimited policy, and required offline declaration')
    return text.encode('utf-8')


def _public_closure(artifact_dir: Path) -> list[dict[str, str]]:
    files = []
    for path in sorted(artifact_dir.rglob('*')):
        if path.is_symlink():
            raise ValueError('Unsafe symlink in public artifact closure: ' + path.relative_to(artifact_dir).as_posix())
        if not path.is_file():
            continue
        relative = path.relative_to(artifact_dir).as_posix()
        if relative in EXCLUDED_CLOSURE_PATHS:
            continue
        if Path(relative).is_absolute() or '..' in Path(relative).parts:
            raise ValueError('Unsafe path in public artifact closure: ' + relative)
        files.append({
            'path': relative,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        })
    if not any(row['path'] == 'index.html' for row in files):
        raise ValueError('Public artifact closure is missing index.html')
    return files


def render_service_worker(artifact_dir: Path, template: bytes, font_contract: dict) -> bytes:
    """Render deterministic cache identity and SHELL into the controlled template."""
    artifact_dir = Path(artifact_dir).resolve()
    if (not isinstance(font_contract, dict) or not isinstance(font_contract.get('routes'), dict)
            or not isinstance(font_contract.get('fonts'), dict)):
        raise ValueError('A source-derived page-font contract is required for the Service Worker')
    normalized = _normalized_template(template)
    policy = _cache_policy_source(template)
    urls, required_shell = _shell_plan(
        (artifact_dir / 'index.html').read_bytes(), artifact_dir,
        font_contract['routes'], font_contract['fonts'],
    )
    closure = _public_closure(artifact_dir)
    material = json.dumps({
        'schemaVersion': 1,
        'templateSha256': hashlib.sha256(normalized).hexdigest(),
        'cachePolicySha256': hashlib.sha256(policy).hexdigest(),
        'shellUrls': urls,
        'requiredShellUrls': required_shell,
        'files': closure,
    }, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    cache_digest = hashlib.sha256(material).hexdigest()
    cache_name = 'huiwen-digital-v16-' + cache_digest
    shell_json = json.dumps(urls, ensure_ascii=False, separators=(',', ':'))
    required_shell_json = json.dumps(required_shell, ensure_ascii=False, separators=(',', ':'))

    try:
        text = template.decode('utf-8')
    except UnicodeDecodeError as error:
        raise ValueError('Service Worker template must be UTF-8') from error
    text, cache_count = CACHE_RE.subn(f"const CACHE='{cache_name}';", text)
    text, shell_count = SHELL_RE.subn('const SHELL=' + shell_json + ';', text)
    text, required_shell_count = REQUIRED_SHELL_RE.subn(
        'const REQUIRED_SHELL=' + required_shell_json + ';', text,
    )
    if (cache_count != 1 or shell_count != 1 or required_shell_count != 1
            or len(OFFLINE_RE.findall(text)) != 1):
        raise ValueError('Service Worker template must contain one supported CACHE, SHELL, REQUIRED_SHELL, delimited policy, and required offline declaration')
    return text.encode('utf-8')
