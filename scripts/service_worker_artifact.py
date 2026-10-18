"""Derive the public Service Worker from the completed, allowlisted artifact."""
from __future__ import annotations

import hashlib
import json
import posixpath
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urljoin, urlsplit


PUBLIC_ORIGIN = 'https://www.huiwen.tw'
OFFLINE_PATH = 'offline.html'
EXCLUDED_CLOSURE_PATHS = {
    'sw.js', 'publication-manifest.json', '_headers', '_redirects', 'deployment.json',
}
CACHE_RE = re.compile(r"(?m)^const CACHE=['\"][^'\"]*['\"];[ \t]*$")
SHELL_RE = re.compile(r'(?m)^const SHELL=\[[^\r\n]*\];[ \t]*$')
OFFLINE_RE = re.compile(r"(?m)^const OFFLINE=['\"]\./offline\.html['\"];[ \t]*$")
POLICY_MARKER = '/* {{CACHE_POLICY}} */'
POLICY_START_MARKER = '/* BEGIN HUIWEN SW CACHE POLICY */'
POLICY_END_MARKER = '/* END HUIWEN SW CACHE POLICY */'
CORE_FONT_RE = re.compile(
    r'^/assets/fonts/huiwen-site-sans/generated/huiwen-index-core-[0-9a-f]{12}\.woff2$'
)


class _IndexShellReferences(HTMLParser):
    """Collect only explicit, same-origin resources needed by the home page."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.references: list[str] = []
        self.core_fonts = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        values = dict(attrs)
        raw = values.get('href') if tag == 'link' else values.get('src') if tag == 'script' else None
        if not raw:
            return

        rel = set((values.get('rel') or '').lower().split())
        path = _safe_public_path(raw)
        if path is None:
            return

        if tag == 'link' and 'stylesheet' in rel and path.endswith('.css'):
            self.references.append(raw)
        elif tag == 'link' and rel.intersection({'icon', 'apple-touch-icon', 'mask-icon'}):
            self.references.append(raw)
        elif tag == 'link' and 'manifest' in rel and path.endswith('.webmanifest'):
            self.references.append(raw)
        elif (tag == 'link' and values.get('as', '').lower() == 'font'
              and values.get('type', '').lower() == 'font/woff2'
              and CORE_FONT_RE.fullmatch(path)):
            self.references.append(raw)
            self.core_fonts += 1
        elif tag == 'script' and path.endswith('.js'):
            self.references.append(raw)


def _safe_public_path(raw: str) -> str | None:
    """Return a safe root-relative artifact path, excluding private/runtime URLs."""
    try:
        resolved = urlsplit(urljoin(PUBLIC_ORIGIN + '/index.html', raw))
        port = resolved.port
    except ValueError:
        return None
    if (resolved.scheme != 'https' or resolved.hostname != 'www.huiwen.tw'
            or port not in (None, 443) or resolved.username or resolved.password):
        return None
    private_query_keys = {'cmsedit', 'draft', 'preview', 'private', 'token'}
    if any(key.casefold() in private_query_keys
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
    if segments.intersection({'admin', 'api', 'draft', 'drafts', 'preview', 'previews'}):
        return None
    if lowered.startswith(('/cms-editor-manifests/', '/cms-page-editor')):
        return None
    if Path(path).name.startswith('cms-page-editor.'):
        return None
    if lowered.endswith(('.json', '.geojson', '.xml')) and not lowered.endswith('.webmanifest'):
        return None
    return path


def shell_urls(index_html: bytes, artifact_dir: Path) -> list[str]:
    """Derive exact install URLs from the public index and required offline file."""
    parser = _IndexShellReferences()
    parser.feed(index_html.decode('utf-8'))
    if parser.core_fonts == 0:
        raise ValueError('Public index is missing its generated core font preload')

    result = ['./index.html']
    seen = set(result)
    for raw in parser.references:
        absolute = urlsplit(urljoin(PUBLIC_ORIGIN + '/index.html', raw))
        path = _safe_public_path(raw)
        if path is None:
            continue
        artifact_path = artifact_dir / path.lstrip('/')
        if not artifact_path.is_file() or artifact_path.is_symlink():
            raise ValueError('Public index shell reference is missing or unsafe: ' + path)
        # Cache keys include the query string. Fragments are not sent in HTTP requests.
        value = '.' + path + (('?' + absolute.query) if absolute.query else '')
        if value not in seen:
            result.append(value)
            seen.add(value)

    offline = artifact_dir / OFFLINE_PATH
    if not offline.is_file() or offline.is_symlink():
        raise ValueError('Required offline document is missing or unsafe')
    if './' + OFFLINE_PATH not in seen:
        result.append('./' + OFFLINE_PATH)
    return result


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
    if POLICY_MARKER in text:
        raise ValueError('Service Worker template must not contain an unresolved cache policy marker')
    block_start, _, _, block_end = _policy_offsets(text)
    text = text[:block_start] + POLICY_MARKER + text[block_end:]
    policy_count = text.count(POLICY_MARKER)
    offline_count = len(OFFLINE_RE.findall(text))
    if cache_count != 1 or shell_count != 1 or policy_count != 1 or offline_count != 1:
        raise ValueError('Service Worker template must contain one supported CACHE, SHELL, delimited policy, and required offline declaration')
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


def render_service_worker(artifact_dir: Path, template: bytes) -> bytes:
    """Render deterministic cache identity and SHELL into the controlled template."""
    artifact_dir = Path(artifact_dir).resolve()
    normalized = _normalized_template(template)
    policy = _cache_policy_source(template)
    urls = shell_urls((artifact_dir / 'index.html').read_bytes(), artifact_dir)
    closure = _public_closure(artifact_dir)
    material = json.dumps({
        'schemaVersion': 1,
        'templateSha256': hashlib.sha256(normalized).hexdigest(),
        'cachePolicySha256': hashlib.sha256(policy).hexdigest(),
        'files': closure,
    }, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    cache_digest = hashlib.sha256(material).hexdigest()
    cache_name = 'huiwen-digital-v16-' + cache_digest
    shell_json = json.dumps(urls, ensure_ascii=False, separators=(',', ':'))

    try:
        text = template.decode('utf-8')
    except UnicodeDecodeError as error:
        raise ValueError('Service Worker template must be UTF-8') from error
    text, cache_count = CACHE_RE.subn(f"const CACHE='{cache_name}';", text)
    text, shell_count = SHELL_RE.subn('const SHELL=' + shell_json + ';', text)
    if cache_count != 1 or shell_count != 1 or len(OFFLINE_RE.findall(text)) != 1:
        raise ValueError('Service Worker template must contain one supported CACHE, SHELL, delimited policy, and required offline declaration')
    return text.encode('utf-8')
