"""Share an immutable, source-bound Cloudflare artifact between read-only tests."""
from __future__ import annotations

import hashlib
import json
import marshal
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import types


def build_fixture_key(source_commit, input_digest, builder_id, module_state):
    """Hash every identity component that can change a generated fixture."""
    payload = {
        'sourceCommit': source_commit,
        'inputDigest': input_digest,
        'builder': builder_id,
        'moduleState': module_state,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def hash_input_paths(root, paths):
    """Hash current worktree bytes and modes, including changed and untracked inputs."""
    root = Path(root).resolve()
    digest = hashlib.sha256()
    for relative in sorted({Path(path).as_posix() for path in paths}):
        candidate = Path(relative)
        if candidate.is_absolute() or '..' in candidate.parts:
            raise ValueError('Fixture input path escapes source root: ' + relative)
        target = root / candidate
        digest.update(relative.encode('utf-8', errors='surrogateescape') + b'\0')
        try:
            info = target.lstat()
        except FileNotFoundError:
            digest.update(b'missing\0')
            continue
        digest.update(f'{stat.S_IMODE(info.st_mode):04o}\0'.encode())
        if stat.S_ISLNK(info.st_mode):
            digest.update(b'symlink\0')
            digest.update(os.readlink(target).encode('utf-8', errors='surrogateescape'))
        elif stat.S_ISREG(info.st_mode):
            digest.update(b'file\0')
            with target.open('rb') as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(block)
        else:
            raise ValueError('Fixture input is not a regular file: ' + relative)
        digest.update(b'\0')
    return digest.hexdigest()


def _git_output(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)


def _source_commit(root):
    return _git_output(root, 'rev-parse', 'HEAD').decode().strip()


def _source_paths(root):
    output = _git_output(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
    paths = {os.fsdecode(path) for path in output.split(b'\0') if path}
    # Test code is not read by the artifact builder. Excluding it lets tests
    # change while preserving the production source and its Git identity.
    return {path for path in paths if Path(path).parts[:1] != ('tests',)}


def _builder_inputs_clean(root):
    output = _git_output(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
    for record in output.split(b'\0'):
        if not record:
            continue
        path = os.fsdecode(record[3:])
        if Path(path).parts[:1] != ('tests',):
            return False
    return True


_UNSUPPORTED = object()


def _stable_value(value):
    if value is None or type(value) in (bool, int, float, str):
        return value
    if isinstance(value, bytes):
        return {'bytesSha256': hashlib.sha256(value).hexdigest()}
    if isinstance(value, Path):
        return {'path': str(value)}
    if isinstance(value, re.Pattern):
        return {'regex': value.pattern, 'flags': value.flags}
    if isinstance(value, types.FunctionType):
        return {
            'function': f'{value.__module__}.{value.__qualname__}',
            'codeSha256': hashlib.sha256(marshal.dumps(value.__code__)).hexdigest(),
            'defaults': _stable_value(value.__defaults__),
            'kwdefaults': _stable_value(value.__kwdefaults__),
        }
    if isinstance(value, type):
        members = {}
        for name, member in value.__dict__.items():
            if name.startswith('__'):
                continue
            normalized = _stable_value(member)
            if normalized is not _UNSUPPORTED:
                members[name] = normalized
        return {
            'class': f'{value.__module__}.{value.__qualname__}',
            'members': members,
        }
    if isinstance(value, (tuple, list)):
        values = [_stable_value(item) for item in value]
        return _UNSUPPORTED if any(item is _UNSUPPORTED for item in values) else values
    if isinstance(value, (set, frozenset)):
        values = [_stable_value(item) for item in value]
        if any(item is _UNSUPPORTED for item in values):
            return _UNSUPPORTED
        return sorted(values, key=lambda item: json.dumps(item, sort_keys=True, ensure_ascii=False))
    if isinstance(value, dict):
        values = {}
        for key, item in value.items():
            normalized_key = _stable_value(key)
            normalized_value = _stable_value(item)
            if normalized_key is _UNSUPPORTED or normalized_value is _UNSUPPORTED:
                return _UNSUPPORTED
            values[json.dumps(normalized_key, sort_keys=True, ensure_ascii=False)] = normalized_value
        return values
    return _UNSUPPORTED


def _module_state(module):
    values = {}
    for name, value in vars(module).items():
        if name.startswith('__') or isinstance(value, types.ModuleType):
            continue
        normalized = _stable_value(value)
        if normalized is not _UNSUPPORTED:
            values[name] = normalized
    return {'name': module.__name__, 'path': getattr(module, '__file__', None), 'values': values}


def _cloudflare_input_identity(root, cloudflare, font_producer):
    root = Path(root).resolve()
    scripts = root / 'scripts'
    if str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    import page_font_contract
    import public_asset_fingerprints
    import service_worker_artifact
    import validate_public_copy

    public = cloudflare.build_public
    source_paths = _source_paths(root)
    effective_paths = set(source_paths)
    effective_paths.update(public.public_paths(root))
    effective_paths.update({
        'data/achievements.json', 'data/page-content.json',
        'schema/public-achievement.schema.json', 'sitemap.xml', 'sw.js',
        font_producer.TC_REL, font_producer.JP_REL,
    })
    input_digest = hash_input_paths(root, effective_paths)
    runtime_modules = (
        cloudflare, public, font_producer, page_font_contract,
        public_asset_fingerprints, service_worker_artifact, validate_public_copy,
    )
    for module in runtime_modules:
        filename = getattr(module, '__file__', None)
        if filename:
            module_path = Path(filename).resolve()
            if root in module_path.parents:
                effective_paths.add(module_path.relative_to(root).as_posix())
    module_state = {
        'python': sys.version,
        'platform': sys.platform,
        'fontEnvironment': font_producer.verify_environment(),
        'modules': [_module_state(module) for module in runtime_modules],
    }
    revision = _source_commit(root)
    key = build_fixture_key(
        revision, input_digest, 'cloudflare-static-public-v1', module_state,
    )
    all_effective_inputs_tracked = effective_paths <= source_paths
    return key, revision, _builder_inputs_clean(root) and all_effective_inputs_tracked


def _assert_regular_tree(root):
    root = Path(root)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError('Artifact fixture root must be a real directory')
    for path in root.rglob('*'):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('Artifact fixture entries must be independent regular files: ' + str(path))


def copy_regular_tree(source, destination):
    """Copy an artifact with independent regular files and no symlinks/hardlinks."""
    source = Path(source).resolve()
    destination = Path(destination)
    _assert_regular_tree(source)
    if destination.exists() or destination.is_symlink():
        raise ValueError('Artifact fixture copy destination already exists')
    shutil.copytree(source, destination, copy_function=shutil.copy2, symlinks=False)
    _assert_regular_tree(destination)
    return destination


class ArtifactTemplateCache:
    """Keep only the latest exact-key template; callers receive independent copies."""

    def __init__(self):
        self._key = None
        self._temporary = None
        self._template = None

    def close(self):
        if self._temporary is not None:
            self._temporary.cleanup()
        self._temporary = None
        self._template = None
        self._key = None

    def _build(self, builder):
        temporary = tempfile.TemporaryDirectory(prefix='cloudflare-public-fixture-')
        template = Path(temporary.name) / 'site'
        template.mkdir()
        try:
            builder(template)
            _assert_regular_tree(template)
        except BaseException:
            temporary.cleanup()
            raise
        return temporary, template

    def copy_to(self, key, builder, destination, *, cacheable=True):
        destination = Path(destination)
        if destination.exists() or destination.is_symlink():
            raise ValueError('Artifact fixture copy destination already exists')
        if not cacheable:
            temporary, template = self._build(builder)
            try:
                return copy_regular_tree(template, destination)
            finally:
                temporary.cleanup()
        if key != self._key:
            self.close()
            self._temporary, self._template = self._build(builder)
            self._key = key
        return copy_regular_tree(self._template, destination)


_CLOUDFLARE_CACHE = ArtifactTemplateCache()


def prepare_cloudflare_test_artifact(root, temporary_directory, cloudflare, font_producer):
    """Return a per-class copy of an external artifact or the shared clean build."""
    destination = Path(temporary_directory) / 'site'
    external = os.environ.get('PAGE_FONT_ARTIFACT_ROOT')
    if external:
        return copy_regular_tree(Path(external).resolve(), destination)

    key, revision, clean_inputs = _cloudflare_input_identity(root, cloudflare, font_producer)

    def build(path):
        cloudflare.build(root, path, revision)
        receipt = json.loads((path / 'deployment.json').read_text(encoding='utf-8'))
        if receipt.get('sourceCommit') != revision:
            raise ValueError('Cloudflare test fixture sourceCommit is not the current Git HEAD')

    result = _CLOUDFLARE_CACHE.copy_to(key, build, destination, cacheable=clean_inputs)
    receipt = json.loads((result / 'deployment.json').read_text(encoding='utf-8'))
    if receipt.get('sourceCommit') != revision:
        raise ValueError('Shared Cloudflare test fixture sourceCommit differs from its input key')
    return result
