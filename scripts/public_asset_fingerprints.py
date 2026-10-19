"""Derive byte-addressed CSS/JS paths inside the reviewed public artifact only."""
from __future__ import annotations
from python_guard import require_supported_python
require_supported_python()

import hashlib
from html.parser import HTMLParser
import html
from pathlib import Path, PurePosixPath
import posixpath
import re
from urllib.parse import unquote, unquote_plus, urljoin, urlsplit, urlunsplit


PUBLIC_ORIGIN = 'https://www.huiwen.tw'
CMS_RUNTIME_NAME = re.compile(r'cms-page-editor\.([a-f0-9]{12})\.js\Z')
FINGERPRINTED_NAME = re.compile(r'(?P<stem>.+)\.(?P<digest>[a-f0-9]{64})(?P<suffix>\.(?:css|js))\Z')

_CSS_IDENT = re.compile(r'[A-Za-z_-][A-Za-z0-9_-]*')
_JS_URL_CALL = re.compile(
    r'\bnew\s+URL\(\s*(?P<quote>["\'])(?P<url>[^"\'\n]*\.(?:css|js)(?:\?[^"\'\n]*)?(?:#[^"\'\n]*)?)(?P=quote)\s*,'
)
_JS_PROPERTY_URL = re.compile(
    r'\.(?:src|href)\s*=\s*(?P<quote>["\'])(?P<url>[^"\'\n]*\.(?:css|js)(?:\?[^"\'\n]*)?(?:#[^"\'\n]*)?)(?P=quote)'
)
_JS_TEMPLATE_URL = re.compile(
    r'\bnew\s+URL\(\s*`(?P<url>(?:\./|\.\./|/)?[A-Za-z0-9_./-]+\.(?:css|js)'
    r'\?v=\$\{[A-Z0-9_]+\})`\s*,'
)
_JS_TEMPLATE_LITERAL = re.compile(
    r'\bnew\s+URL\(\s*`(?P<url>(?:\./|\.\./|/)?[A-Za-z0-9_./-]+\.(?:css|js)'
    r'(?:\?[^`$]*)?(?:#[^`$]*)?)`\s*,'
)
_JS_MODULE_URL = re.compile(
    r'\b(?:import\s+(?:[^;\n]*?\s+from\s*)?|export\s+[^;\n]*?\s+from\s*)'
    r'(?P<quote>["\'])(?P<url>(?:\./|\.\./|/)[^"\'\n]+\.(?:m?js|css)'
    r'(?:\?[^"\'\n]*)?(?:#[^"\'\n]*)?)(?P=quote)'
)
_JS_DYNAMIC_IMPORT = re.compile(
    r'\bimport\s*\(\s*(?P<quote>["\'])(?P<url>(?:\./|\.\./|/)'
    r'[^"\'\n]+\.(?:m?js|css)(?:\?[^"\'\n]*)?(?:#[^"\'\n]*)?)(?P=quote)\s*\)'
)
_LEAFLET_CSS_SELECTOR = re.compile(r'link\[href\$="(?P<url>leaflet\.css)"\]')
_LEAFLET_CSS_LENGTH = re.compile(r'-"(?P<url>leaflet\.css)"\.length-1')
_LEAFLET_HASHED_CSS_SELECTOR = re.compile(
    r'link\[href\$="(?P<url>leaflet\.[a-f0-9]{64}\.css)"\]'
)
_LEAFLET_HASHED_CSS_LENGTH = re.compile(
    r'-"(?P<url>leaflet\.[a-f0-9]{64}\.css)"\.length-1'
)


def public_asset_source_paths() -> set[str]:
    """Exact CSS/JS inputs admitted by the current public artifact allowlist."""
    from build_public import ROOT_FILES

    allowed = {
        path for path in ROOT_FILES
        if Path(path).suffix.lower() in {'.css', '.js'} and path != 'sw.js'
    }
    allowed.update({'assets/vendor/leaflet.css', 'assets/vendor/leaflet.js'})
    return allowed


def fingerprinted_path(relative: str, payload: bytes) -> str:
    """Insert the full payload SHA-256 before a public CSS/JS extension."""
    path = PurePosixPath(relative)
    if path.suffix.lower() not in {'.css', '.js'} or path.suffix == '.mjs':
        raise ValueError('CSS/JS fingerprint input has an unsupported extension: ' + relative)
    digest = hashlib.sha256(payload).hexdigest()
    return (path.parent / f'{path.stem}.{digest}{path.suffix}').as_posix()


def _safe_artifact_file(root: Path, relative: str, label: str) -> Path:
    path = PurePosixPath(relative)
    if (not relative or path.as_posix() != relative or path.is_absolute()
            or '..' in path.parts or '\\' in relative):
        raise ValueError(label + ' has an unsafe path: ' + relative)
    target = root
    for part in path.parts:
        target = target / part
        if target.is_symlink():
            raise ValueError(label + ' is missing or unsafe: ' + relative)
    if (not target.is_file()
            or root.resolve() not in target.resolve().parents):
        raise ValueError(label + ' is missing or unsafe: ' + relative)
    return target


def _artifact_destination(root: Path, relative: str, label: str) -> Path:
    """Create only normal directories below the artifact root; reject symlink parents."""
    path = PurePosixPath(relative)
    if (not relative or path.as_posix() != relative or path.is_absolute()
            or '..' in path.parts or '\\' in relative):
        raise ValueError(label + ' has an unsafe path: ' + relative)
    target = root
    for part in path.parts[:-1]:
        target = target / part
        if target.is_symlink():
            raise ValueError(label + ' has an unsafe parent: ' + relative)
        target.mkdir(exist_ok=True)
        if not target.is_dir() or root.resolve() not in target.resolve().parents:
            raise ValueError(label + ' has an unsafe parent: ' + relative)
    destination = target / path.name
    if destination.is_symlink():
        raise ValueError(label + ' is an unsafe symlink: ' + relative)
    return destination


def _candidate_reference(owner: str, raw: str) -> str | None:
    """Resolve a local CSS/JS URL against its containing public artifact file."""
    if not urlsplit(raw).path:
        return None
    try:
        resolved = urlsplit(urljoin(PUBLIC_ORIGIN + '/' + owner, raw))
        port = resolved.port
    except ValueError:
        return None
    if (resolved.scheme not in {'http', 'https'} or resolved.hostname != 'www.huiwen.tw'
            or port not in (None, 443) or resolved.username or resolved.password):
        return None
    path = unquote(resolved.path).lstrip('/')
    if not path:
        return None
    if '\\' in path or '\x00' in path:
        raise ValueError('Unsafe local CSS/JS reference in ' + owner + ': ' + raw)
    normalized = posixpath.normpath(path)
    if normalized.startswith('../') or normalized == '..':
        raise ValueError('CSS/JS reference escapes the public artifact in ' + owner + ': ' + raw)
    suffix = PurePosixPath(normalized).suffix.lower()
    return normalized if suffix in {'.css', '.js'} else None


def _strip_version_query(query: str) -> str:
    """Drop only the old cache-busting v parameter after moving its identity into the path."""
    if not query:
        return ''
    retained = [part for part in query.split('&')
                if unquote_plus(part.partition('=')[0]).lower() != 'v']
    return '&'.join(retained)


def _rewrite_url(owner: str, raw: str, mapping: dict[str, str], candidates: set[str]) -> str:
    target = _candidate_reference(owner, raw)
    if target is None:
        return raw
    if target in mapping.values():
        return raw
    derived = mapping.get(target)
    if derived is None:
        if target in candidates:
            raise ValueError('CSS/JS dependency was not derived before its owner: ' + owner + ' -> ' + target)
        if target == 'sw.js' or CMS_RUNTIME_NAME.fullmatch(PurePosixPath(target).name):
            return raw
        raise ValueError('Unowned local CSS/JS reference: ' + owner + ' -> ' + raw)

    parsed = urlsplit(raw)
    if parsed.scheme or parsed.netloc:
        new_path = '/' + derived
    elif parsed.path.startswith('/'):
        new_path = '/' + derived
    else:
        relative_dir = posixpath.dirname(owner) or '.'
        new_path = posixpath.relpath(derived, relative_dir)
        if parsed.path.startswith('./') and not new_path.startswith('../'):
            new_path = './' + new_path
    query = _strip_version_query(parsed.query)
    return urlunsplit((parsed.scheme, parsed.netloc, new_path, query, parsed.fragment))


def _css_references(text: str):
    """Yield exact value spans for CSS url() and quoted @import references."""
    index = 0
    length = len(text)
    while index < length:
        if text.startswith('/*', index):
            end = text.find('*/', index + 2)
            index = length if end < 0 else end + 2
            continue
        if text[index] in {'"', "'"}:
            index = _quoted_end(text, index)
            continue
        if text[index] == '@' and text[index:index + 7].lower() == '@import':
            cursor = index + 7
            while cursor < length and text[cursor].isspace():
                cursor += 1
            if cursor < length and text[cursor] in {'"', "'"}:
                end = _quoted_end(text, cursor)
                yield (cursor + 1, end - 1, text[cursor + 1:end - 1])
                index = end
                continue
        match = _CSS_IDENT.match(text, index)
        if match and match.group(0).lower() == 'url':
            cursor = match.end()
            while cursor < length and text[cursor].isspace():
                cursor += 1
            if cursor < length and text[cursor] == '(':
                parsed = _css_url_value(text, cursor + 1)
                if parsed:
                    start, end, value, token_end = parsed
                    yield (start, end, value)
                    index = token_end
                    continue
        index += 1


def _quoted_end(text: str, start: int) -> int:
    quote = text[start]
    index = start + 1
    while index < len(text):
        if text[index] == '\\':
            index += 2
        elif text[index] == quote:
            return index + 1
        else:
            index += 1
    return len(text)


def _css_url_value(text: str, start: int):
    cursor = start
    while cursor < len(text) and text[cursor].isspace():
        cursor += 1
    if cursor >= len(text):
        return None
    if text[cursor] in {'"', "'"}:
        quote_start = cursor
        quote_end = _quoted_end(text, quote_start)
        value_start, value_end = quote_start + 1, quote_end - 1
        cursor = quote_end
        while cursor < len(text) and text[cursor].isspace():
            cursor += 1
        if cursor >= len(text) or text[cursor] != ')':
            return None
        return value_start, value_end, text[value_start:value_end], cursor + 1
    value_start = cursor
    escaped = False
    while cursor < len(text):
        char = text[cursor]
        if escaped:
            escaped = False
        elif char == '\\':
            escaped = True
        elif char == ')':
            value_end = cursor
            while value_end > value_start and text[value_end - 1].isspace():
                value_end -= 1
            return value_start, value_end, text[value_start:value_end], cursor + 1
        cursor += 1
    return None


def _js_references(owner: str, text: str):
    """Yield URL specifiers in executable URL construction, src/href assignments and imports."""
    patterns = [_JS_URL_CALL, _JS_PROPERTY_URL, _JS_TEMPLATE_URL, _JS_TEMPLATE_LITERAL,
                _JS_MODULE_URL, _JS_DYNAMIC_IMPORT]
    if (owner == 'assets/vendor/leaflet.js'
            or re.fullmatch(r'assets/vendor/leaflet\.[a-f0-9]{64}\.js', owner)):
        patterns.extend((_LEAFLET_CSS_SELECTOR, _LEAFLET_CSS_LENGTH,
                         _LEAFLET_HASHED_CSS_SELECTOR, _LEAFLET_HASHED_CSS_LENGTH))
    spans = set()
    for pattern in patterns:
        for match in pattern.finditer(text):
            span = match.span('url')
            if span in spans:
                continue
            spans.add(span)
            yield span[0], span[1], match.group('url')


def _local_dependencies(owner: str, payload: bytes, candidates: set[str]) -> set[str]:
    try:
        text = payload.decode('utf-8')
    except UnicodeDecodeError as error:
        raise ValueError('Public CSS/JS must be UTF-8 for reference closure: ' + owner) from error
    references = _css_references(text) if owner.lower().endswith('.css') else _js_references(owner, text)
    dependencies = set()
    for _, _, raw in references:
        target = _candidate_reference(owner, raw)
        if target is None:
            continue
        if target in candidates:
            dependencies.add(target)
        elif target != 'sw.js' and not CMS_RUNTIME_NAME.fullmatch(PurePosixPath(target).name):
            raise ValueError('Unowned local CSS/JS reference: ' + owner + ' -> ' + raw)
    return dependencies


def _rewrite_css(owner: str, text: str, mapping: dict[str, str], candidates: set[str]) -> str:
    edits = []
    for start, end, raw in _css_references(text):
        replacement = _rewrite_url(owner, raw, mapping, candidates)
        if replacement != raw:
            edits.append((start, end, replacement))
    for start, end, value in sorted(edits, reverse=True):
        text = text[:start] + value + text[end:]
    return text


def _rewrite_js(owner: str, text: str, mapping: dict[str, str], candidates: set[str]) -> str:
    edits = []
    for start, end, raw in _js_references(owner, text):
        replacement = _rewrite_url(owner, raw, mapping, candidates)
        if replacement != raw:
            edits.append((start, end, replacement))
    for start, end, value in sorted(edits, reverse=True):
        text = text[:start] + value + text[end:]
    return text


def _reference_spans(source: str, mapping: dict[str, str], candidates: set[str], owner: str):
    """Rewrite HTML start-tag URL attributes without reserializing unrelated markup."""
    edits = []
    cursor = 1
    while cursor < len(source) and not source[cursor].isspace() and source[cursor] not in '/>':
        cursor += 1
    while cursor < len(source):
        while cursor < len(source) and source[cursor].isspace():
            cursor += 1
        if cursor >= len(source) or source[cursor] in '/>':
            break
        name_start = cursor
        while cursor < len(source) and not source[cursor].isspace() and source[cursor] not in {'=', '/', '>'}:
            cursor += 1
        if cursor == name_start:
            cursor += 1
            continue
        name = source[name_start:cursor].lower()
        while cursor < len(source) and source[cursor].isspace():
            cursor += 1
        if cursor >= len(source) or source[cursor] != '=':
            continue
        cursor += 1
        while cursor < len(source) and source[cursor].isspace():
            cursor += 1
        quote = source[cursor] if cursor < len(source) and source[cursor] in {'"', "'"} else ''
        if quote:
            value_start = cursor + 1
            value_end = value_start
            while value_end < len(source) and source[value_end] != quote:
                value_end += 1
            if value_end >= len(source):
                break
            next_cursor = value_end + 1
        else:
            value_start = cursor
            value_end = cursor
            while value_end < len(source) and not source[value_end].isspace() and source[value_end] != '>':
                value_end += 1
            next_cursor = value_end
        value = source[value_start:value_end]
        decoded = html.unescape(value)
        if name in {'href', 'src'}:
            rewritten = _rewrite_url(owner, decoded, mapping, candidates)
        elif name == 'style':
            rewritten = _rewrite_css(owner, decoded, mapping, candidates)
        else:
            cursor = next_cursor
            continue
        if rewritten == decoded:
            cursor = next_cursor
            continue
        escaped = html.escape(rewritten, quote=True)
        edits.append((value_start, value_end, escaped))
        cursor = next_cursor
    for start, end, value in sorted(edits, reverse=True):
        source = source[:start] + value + source[end:]
    return source


class _HtmlAssetRewriter(HTMLParser):
    def __init__(self, source: str, document: str, mapping: dict[str, str], candidates: set[str]):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.document = document
        self.mapping = mapping
        self.candidates = candidates
        self.line_offsets = [0]
        self.line_offsets.extend(index + 1 for index, char in enumerate(source) if char == '\n')
        self.edits = []
        self.raw_element = None
        self.script_javascript = True

    def _offset(self) -> int:
        line, column = self.getpos()
        return self.line_offsets[line - 1] + column

    def handle_starttag(self, tag, attrs):
        start = self._offset()
        raw_tag = self.get_starttag_text()
        rewritten = _reference_spans(raw_tag, self.mapping, self.candidates, self.document)
        if rewritten != raw_tag:
            self.edits.append((start, start + len(raw_tag), rewritten))
        if tag.lower() in {'style', 'script'}:
            self.raw_element = tag.lower()
            values = dict(attrs)
            script_type = (values.get('type') or '').lower()
            self.script_javascript = tag.lower() != 'script' or script_type in {
                '', 'module', 'text/javascript', 'application/javascript',
                'text/ecmascript', 'application/ecmascript', 'application/x-javascript',
            }

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.raw_element = None

    def handle_endtag(self, tag):
        if self.raw_element == tag.lower():
            self.raw_element = None

    def handle_data(self, data):
        if self.raw_element not in {'style', 'script'}:
            return
        if self.raw_element == 'script' and not self.script_javascript:
            return
        if self.raw_element == 'style':
            rewritten = _rewrite_css(self.document, data, self.mapping, self.candidates)
        else:
            rewritten = _rewrite_js(self.document, data, self.mapping, self.candidates)
        if rewritten != data:
            start = self._offset()
            self.edits.append((start, start + len(data), rewritten))

    def output(self) -> str:
        result = self.source
        for start, end, replacement in sorted(self.edits, reverse=True):
            result = result[:start] + replacement + result[end:]
        return result


def _rewrite_html(source: str, document: str, mapping: dict[str, str], candidates: set[str]) -> str:
    parser = _HtmlAssetRewriter(source, document, mapping, candidates)
    parser.feed(source)
    parser.close()
    return parser.output()


def _validate_rewritten_reference_closure(artifact: Path, mapping: dict[str, str], candidates: set[str]) -> None:
    """A second structured pass must leave every published consumer unchanged."""
    for page in sorted(artifact.rglob('*.html')):
        document = page.relative_to(artifact).as_posix()
        current = page.read_text(encoding='utf-8')
        if _rewrite_html(current, document, mapping, candidates) != current:
            raise ValueError('Unfingerprinted CSS/JS reference remains in public HTML: ' + document)
    for alias, derived in mapping.items():
        path = _safe_artifact_file(artifact, derived, 'Fingerprinted CSS/JS closure')
        current = path.read_text(encoding='utf-8')
        rewritten = (_rewrite_css(alias, current, mapping, candidates)
                     if alias.lower().endswith('.css')
                     else _rewrite_js(alias, current, mapping, candidates))
        if rewritten != current:
            raise ValueError('Unfingerprinted CSS/JS dependency remains: ' + derived)


def _ordered_dependencies(paths: set[str], dependencies: dict[str, set[str]]) -> list[str]:
    order = []
    active = []
    visited = set()

    def visit(path):
        if path in visited:
            return
        if path in active:
            cycle = active[active.index(path):] + [path]
            raise ValueError('CSS/JS fingerprint dependency cycle: ' + ' -> '.join(cycle))
        active.append(path)
        for dependency in sorted(dependencies[path]):
            visit(dependency)
        active.pop()
        visited.add(path)
        order.append(path)

    for path in sorted(paths):
        visit(path)
    return order


def derive_public_asset_fingerprints(artifact_root: Path, source_root: Path, published_paths) -> dict:
    """Create hash-named derivatives and rewrite their references in the isolated artifact."""
    artifact = Path(artifact_root).resolve()
    source = Path(source_root).resolve()
    allowlist = public_asset_source_paths()
    published = set(published_paths)
    candidates = allowlist.intersection(published)
    if candidates != allowlist:
        raise ValueError('Public CSS/JS source allowlist is not fully published: '
                         + ', '.join(sorted(allowlist - candidates)))

    aliases = {}
    for relative in sorted(candidates):
        source_file = _safe_artifact_file(source, relative, 'Allowlisted source CSS/JS')
        alias_file = _safe_artifact_file(artifact, relative, 'Public CSS/JS alias')
        source_bytes = source_file.read_bytes()
        if alias_file.read_bytes() != source_bytes:
            raise ValueError('Public CSS/JS alias differs from its canonical source: ' + relative)
        aliases[relative] = source_bytes

    dependencies = {
        relative: _local_dependencies(relative, payload, candidates)
        for relative, payload in aliases.items()
    }
    mapping: dict[str, str] = {}
    for relative in _ordered_dependencies(candidates, dependencies):
        payload = aliases[relative]
        text = payload.decode('utf-8')
        rewritten = (_rewrite_css(relative, text, mapping, candidates)
                     if relative.lower().endswith('.css')
                     else _rewrite_js(relative, text, mapping, candidates))
        derived_bytes = rewritten.encode('utf-8')
        derived = fingerprinted_path(relative, derived_bytes)
        target = _artifact_destination(artifact, derived, 'Fingerprint destination')
        if target.exists():
            if target.is_symlink() or not target.is_file() or target.read_bytes() != derived_bytes:
                raise ValueError('Fingerprint destination already exists with different bytes: ' + derived)
        else:
            target.write_bytes(derived_bytes)
        mapping[relative] = derived

    for page in sorted(artifact.rglob('*.html')):
        if page.is_symlink() or artifact not in page.resolve().parents:
            raise ValueError('Unsafe public HTML asset owner: ' + page.relative_to(artifact).as_posix())
        document = page.relative_to(artifact).as_posix()
        source_text = page.read_text(encoding='utf-8')
        rewritten = _rewrite_html(source_text, document, mapping, candidates)
        if rewritten != source_text:
            page.write_text(rewritten, encoding='utf-8')

    _validate_rewritten_reference_closure(artifact, mapping, candidates)

    for relative, derived in mapping.items():
        target = _safe_artifact_file(artifact, derived, 'Derived public CSS/JS')
        actual = hashlib.sha256(target.read_bytes()).hexdigest()
        match = FINGERPRINTED_NAME.fullmatch(PurePosixPath(derived).name)
        if not match or actual != match.group('digest'):
            raise ValueError('Derived CSS/JS filename hash differs from bytes: ' + derived)
        alias_file = _safe_artifact_file(artifact, relative, 'Retained mutable CSS/JS alias')
        if alias_file.read_bytes() != aliases[relative]:
            raise ValueError('Fingerprint derivation modified its mutable alias: ' + relative)
    return {'paths': mapping, 'dependencies': dependencies}


def _derived_alias(relative: str, allowed: set[str]) -> str | None:
    name = PurePosixPath(relative).name
    match = FINGERPRINTED_NAME.fullmatch(name)
    if not match:
        return None
    alias_name = match.group('stem') + match.group('suffix')
    alias_path = (PurePosixPath(relative).parent / alias_name).as_posix()
    return alias_path if alias_path in allowed else None


def validate_public_asset_fingerprints(
    artifact_root: Path, publication: dict, *, require_complete: bool = False,
) -> list[tuple[str, str]]:
    """Validate exact CSS/JS ownership, publication hashes, and derived filename hashes."""
    root = Path(artifact_root).resolve()
    files = publication.get('files') if isinstance(publication, dict) else None
    if not isinstance(files, dict):
        raise ValueError('Public publication manifest has no files map')
    allowed = public_asset_source_paths()
    derived = []
    saw_aliases = set()
    saw_derived = set()
    for relative in sorted(files, key=str):
        declared_hash = files[relative]
        if (not isinstance(relative, str) or not relative or '\\' in relative
                or PurePosixPath(relative).is_absolute() or '..' in PurePosixPath(relative).parts):
            raise ValueError('Public CSS/JS publication path is unsafe: ' + str(relative))
        suffix = PurePosixPath(relative).suffix.lower()
        if suffix not in {'.css', '.js'}:
            continue
        if relative == 'sw.js':
            continue
        if relative in allowed:
            path = _safe_artifact_file(root, relative, 'Mutable public CSS/JS alias')
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            if declared_hash != actual:
                raise ValueError('Publication hash differs from mutable CSS/JS alias bytes: ' + relative)
            saw_aliases.add(relative)
            continue
        if '/' not in relative and (cms_match := CMS_RUNTIME_NAME.fullmatch(relative)):
            path = _safe_artifact_file(root, relative, 'CMS runtime')
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            if not isinstance(declared_hash, str) or declared_hash != actual or not actual.startswith(cms_match.group(1)):
                raise ValueError('CMS runtime filename hash differs from its public bytes: ' + relative)
            continue
        alias = _derived_alias(relative, allowed)
        if alias is None:
            raise ValueError('Unowned public CSS/JS artifact path: ' + relative)
        path = _safe_artifact_file(root, relative, 'Fingerprinted public CSS/JS')
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        digest = FINGERPRINTED_NAME.fullmatch(PurePosixPath(relative).name).group('digest')
        if not isinstance(declared_hash, str) or declared_hash != actual or actual != digest:
            raise ValueError('Fingerprinted CSS/JS filename or publication hash differs from bytes: ' + relative)
        saw_derived.add(alias)
        derived.append((relative, actual))

    if saw_aliases and saw_aliases != allowed:
        raise ValueError('Public CSS/JS alias allowlist is incomplete: '
                         + ', '.join(sorted(allowed - saw_aliases)))
    if saw_derived and saw_derived != allowed:
        raise ValueError('Public CSS/JS fingerprint closure is incomplete: '
                         + ', '.join(sorted(allowed - saw_derived)))
    if bool(saw_aliases) != bool(saw_derived):
        raise ValueError('Public CSS/JS aliases and fingerprints must be published together')
    if require_complete and (saw_aliases != allowed or saw_derived != allowed):
        raise ValueError('Public CSS/JS publication does not own the complete exact allowlist')
    return derived
