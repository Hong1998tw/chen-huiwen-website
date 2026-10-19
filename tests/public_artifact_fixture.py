"""Share an immutable, source-bound Cloudflare artifact between read-only tests."""
from __future__ import annotations

import functools
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import types


def build_fixture_key(source_commit, input_digest, builder_id, module_state):
    """Hash every identity component that can change a generated fixture."""
    payload = _stable_value({
        'sourceCommit': source_commit,
        'inputDigest': input_digest,
        'builder': builder_id,
        'moduleState': module_state,
    })
    if payload is _UNSUPPORTED:
        return None
    try:
        encoded = json.dumps(
            payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
        ).encode()
    except (TypeError, ValueError, RecursionError):
        return None
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

# `_CLOUDFLARE_CACHE` is process-local and never persists keys. Keep a strong
# reference for every class whose module binding contributes to a fixture key:
# the reference prevents CPython from reusing its id for a replacement class.
_CLASS_IDENTITY_LOCK = threading.Lock()
_CLASS_IDENTITY_REFERENCES = {}
_CLASS_IDENTITY_SEQUENCE = 0


def _class_identity_token(value):
    """Return a process-local token while retaining the class against id reuse."""
    global _CLASS_IDENTITY_SEQUENCE
    identity = id(value)
    with _CLASS_IDENTITY_LOCK:
        registered = _CLASS_IDENTITY_REFERENCES.get(identity)
        if registered is not None:
            if registered[0] is not value:
                return _UNSUPPORTED
            return registered[1]
        _CLASS_IDENTITY_SEQUENCE += 1
        token = _CLASS_IDENTITY_SEQUENCE
        _CLASS_IDENTITY_REFERENCES[identity] = (value, token)
        return token


def _canonical_class_binding(value):
    """Resolve a class's module/qualname without invoking dynamic attributes."""
    module_name = type.__getattribute__(value, '__module__')
    qualname = type.__getattribute__(value, '__qualname__')
    if not isinstance(module_name, str) or not isinstance(qualname, str):
        return _UNSUPPORTED
    owner = sys.modules.get(module_name)
    if owner is None:
        return _UNSUPPORTED
    parts = qualname.split('.')
    if not parts or any(not part or part == '<locals>' for part in parts):
        return _UNSUPPORTED
    try:
        current = types.ModuleType.__getattribute__(owner, '__dict__').get(parts[0], _UNSUPPORTED)
        for part in parts[1:]:
            if current is _UNSUPPORTED:
                return _UNSUPPORTED
            namespace = type.__getattribute__(current, '__dict__')
            current = namespace.get(part, _UNSUPPORTED)
    except (AttributeError, TypeError):
        return _UNSUPPORTED
    return (owner, module_name, qualname) if current is value else _UNSUPPORTED


def _stable_code_constant(value, active):
    if isinstance(value, types.CodeType):
        return _stable_code(value, active)
    if value is None or type(value) in (bool, int, str):
        return value
    if type(value) is float:
        return {'floatBits': struct.pack('!d', value).hex()}
    if type(value) is complex:
        return {'complexBits': struct.pack('!dd', value.real, value.imag).hex()}
    if isinstance(value, bytes):
        return {'bytesSha256': hashlib.sha256(value).hexdigest(), 'length': len(value)}
    if value is Ellipsis:
        return {'ellipsis': True}
    if type(value) is tuple:
        values = [_stable_code_constant(item, active) for item in value]
        return _UNSUPPORTED if any(item is _UNSUPPORTED for item in values) else {'tuple': values}
    if type(value) is frozenset:
        values = [_stable_code_constant(item, active) for item in value]
        if any(item is _UNSUPPORTED for item in values):
            return _UNSUPPORTED
        values.sort(key=lambda item: json.dumps(
            item, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
        ))
        return {'frozenset': values}
    return _UNSUPPORTED


def _stable_code(code, active=None):
    """Fingerprint source code fields without CPython's adaptive quickening state."""
    if active is None:
        active = set()
    identity = id(code)
    if identity in active:
        return _UNSUPPORTED
    active.add(identity)
    try:
        constants = [_stable_code_constant(value, active) for value in code.co_consts]
        if any(value is _UNSUPPORTED for value in constants):
            return _UNSUPPORTED
        return {
            'argcount': code.co_argcount,
            'posonlyargcount': code.co_posonlyargcount,
            'kwonlyargcount': code.co_kwonlyargcount,
            'nlocals': code.co_nlocals,
            'stacksize': code.co_stacksize,
            'flags': code.co_flags,
            'bytecodeSha256': hashlib.sha256(code.co_code).hexdigest(),
            'constants': constants,
            'names': code.co_names,
            'varnames': code.co_varnames,
            'freevars': code.co_freevars,
            'cellvars': code.co_cellvars,
            'filename': code.co_filename,
            'name': code.co_name,
            'qualname': code.co_qualname,
            'firstlineno': code.co_firstlineno,
            'linetableSha256': hashlib.sha256(code.co_linetable).hexdigest(),
            'exceptiontableSha256': hashlib.sha256(code.co_exceptiontable).hexdigest(),
        }
    finally:
        active.remove(identity)


def _stable_value(value, active=None, seen=None):
    try:
        return _stable_value_impl(value, active, seen)
    except (OverflowError, RecursionError, TypeError, ValueError):
        return _UNSUPPORTED


def _stable_value_impl(value, active=None, seen=None):
    """Return a deterministic JSON value, or reject state we cannot prove stable."""
    if value is None or type(value) in (bool, int, str):
        return value
    if type(value) is tuple and not value:
        # CPython reuses the empty tuple singleton for empty function defaults.
        # Repeating this immutable value does not create aliased mutable state.
        return {'tuple': []}
    if type(value) is float:
        return {'floatBits': struct.pack('!d', value).hex()}
    if isinstance(value, bytes):
        return {'bytesSha256': hashlib.sha256(value).hexdigest(), 'length': len(value)}
    if isinstance(value, Path):
        return {'path': os.fspath(value)}
    if isinstance(value, re.Pattern):
        pattern = _stable_value(value.pattern, active, seen)
        if pattern is _UNSUPPORTED:
            return _UNSUPPORTED
        return {'regex': pattern, 'flags': value.flags}
    if isinstance(value, type) and type(value) is type and value.__module__ == 'builtins':
        return {'builtinClass': f'{value.__module__}.{value.__qualname__}'}
    if active is None:
        active = set()
    if seen is None:
        seen = set()
    identity = id(value)
    if identity in active or identity in seen:
        return _UNSUPPORTED
    active.add(identity)
    seen.add(identity)
    try:
        if isinstance(value, types.FunctionType):
            try:
                closure = []
                for cell in value.__closure__ or ():
                    try:
                        captured = cell.cell_contents
                    except ValueError:
                        return _UNSUPPORTED
                    normalized = _stable_value(captured, active, seen)
                    if normalized is _UNSUPPORTED:
                        return _UNSUPPORTED
                    closure.append(normalized)
                defaults = _stable_value(value.__defaults__, active, seen)
                kwdefaults = _stable_value(value.__kwdefaults__, active, seen)
                if defaults is _UNSUPPORTED or kwdefaults is _UNSUPPORTED:
                    return _UNSUPPORTED
                code_state = _stable_code(value.__code__)
                if code_state is _UNSUPPORTED:
                    return _UNSUPPORTED
                code_digest = hashlib.sha256(json.dumps(
                    code_state, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                ).encode()).hexdigest()
            except (AttributeError, TypeError, ValueError, RecursionError):
                return _UNSUPPORTED
            return {
                'function': f'{value.__module__}.{value.__qualname__}',
                'codeSha256': code_digest,
                'defaults': defaults,
                'kwdefaults': kwdefaults,
                'closure': closure,
            }
        if isinstance(value, type):
            return _UNSUPPORTED
        if type(value) in (tuple, list):
            values = [_stable_value(item, active, seen) for item in value]
            if any(item is _UNSUPPORTED for item in values):
                return _UNSUPPORTED
            return {'tuple' if type(value) is tuple else 'list': values}
        if type(value) in (set, frozenset):
            values = [_stable_value(item, active, seen) for item in value]
            if any(item is _UNSUPPORTED for item in values):
                return _UNSUPPORTED
            values.sort(key=lambda item: json.dumps(
                item, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
            ))
            return {'frozenset' if type(value) is frozenset else 'set': values}
        if type(value) is dict:
            values = {}
            for key, item in value.items():
                normalized_key = _stable_value(key, active, seen)
                normalized_value = _stable_value(item, active, seen)
                if normalized_key is _UNSUPPORTED or normalized_value is _UNSUPPORTED:
                    return _UNSUPPORTED
                encoded_key = json.dumps(
                    normalized_key, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                )
                if encoded_key in values:
                    return _UNSUPPORTED
                values[encoded_key] = normalized_value
            return {'dict': values}
        return _UNSUPPORTED
    finally:
        active.remove(identity)


_MODULE_METADATA_FIELDS = {
    '__builtins__', '__cached__', '__doc__', '__file__', '__loader__',
    '__name__', '__package__', '__spec__',
}


def _module_source_identity(module):
    """Identify a runtime module by its source location, mode, and exact bytes."""
    filename = getattr(module, '__file__', None)
    if filename is None:
        return {'name': module.__name__, 'path': None, 'mode': None, 'sha256': None}
    source = Path(filename)
    try:
        info = source.lstat()
        if not stat.S_ISREG(info.st_mode):
            return _UNSUPPORTED
        digest = hashlib.sha256()
        with source.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        path = str(source.resolve(strict=True))
    except (OSError, RuntimeError, ValueError):
        return _UNSUPPORTED
    return {
        'name': module.__name__,
        'path': path,
        'mode': stat.S_IMODE(info.st_mode),
        'sha256': digest.hexdigest(),
    }


def _is_lru_cache_wrapper(value):
    wrapper_type = getattr(functools, '_lru_cache_wrapper', None)
    return isinstance(wrapper_type, type) and type(value) is wrapper_type


def _module_field_state(value):
    """Encode known production-module bindings without weakening closure state."""
    if isinstance(value, types.ModuleType):
        identity = _module_source_identity(value)
        if identity is _UNSUPPORTED:
            return _UNSUPPORTED
        return {'module': identity}
    if isinstance(value, type):
        canonical = _canonical_class_binding(value)
        if canonical is _UNSUPPORTED:
            return _UNSUPPORTED
        owner, module_name, qualname = canonical
        identity = _module_source_identity(owner)
        if identity is _UNSUPPORTED:
            return _UNSUPPORTED
        class_identity = _class_identity_token(value)
        if class_identity is _UNSUPPORTED:
            return _UNSUPPORTED
        return {
            'class': f'{module_name}.{qualname}',
            'classIdentity': class_identity,
            'moduleSource': identity,
        }
    if _is_lru_cache_wrapper(value):
        wrapped = _stable_value(value.__wrapped__)
        parameters = _stable_value(value.cache_parameters())
        if wrapped is _UNSUPPORTED or parameters is _UNSUPPORTED:
            return _UNSUPPORTED
        return {'lruCache': wrapped, 'parameters': parameters}
    if isinstance(value, types.BuiltinFunctionType):
        module_name = getattr(value, '__module__', None)
        owner = sys.modules.get(module_name) if isinstance(module_name, str) else None
        if owner is None:
            return _UNSUPPORTED
        identity = _module_source_identity(owner)
        name = getattr(value, '__qualname__', None)
        if identity is _UNSUPPORTED or not isinstance(name, str):
            return _UNSUPPORTED
        return {'builtinFunction': f'{module_name}.{name}', 'moduleSource': identity}
    if type(value).__module__ == '__future__' and type(value).__qualname__ == '_Feature':
        mandatory = _stable_value(value.mandatory)
        optional = _stable_value(value.optional)
        if mandatory is _UNSUPPORTED or optional is _UNSUPPORTED:
            return _UNSUPPORTED
        return {
            'futureFeature': value.compiler_flag,
            'mandatory': mandatory,
            'optional': optional,
        }
    return _stable_value(value)


def _module_field_has_identity(value):
    """Return whether repeated module bindings need an explicit alias marker."""
    return (
        type(value) in (dict, list, set)
        or isinstance(value, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type))
        or _is_lru_cache_wrapper(value)
    )


def _module_state(module):
    values = {}
    first_binding = {}
    for name, value in vars(module).items():
        if name in _MODULE_METADATA_FIELDS:
            continue
        if _module_field_has_identity(value):
            first_name = first_binding.get(id(value))
            if first_name is not None:
                values[name] = {'aliasOf': first_name}
                continue
            first_binding[id(value)] = name
        normalized = _module_field_state(value)
        if normalized is _UNSUPPORTED:
            return _UNSUPPORTED
        values[name] = normalized
    source = _module_source_identity(module)
    if source is _UNSUPPORTED:
        return _UNSUPPORTED
    return {'name': module.__name__, 'source': source, 'values': values}


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
    module_states = [_module_state(module) for module in runtime_modules]
    module_state = {
        'python': sys.version,
        'platform': sys.platform,
        'fontEnvironment': font_producer.verify_environment(),
        'modules': module_states,
    }
    revision = _source_commit(root)
    key = build_fixture_key(
        revision, input_digest, 'cloudflare-static-public-v1', module_state,
    )
    all_effective_inputs_tracked = effective_paths <= source_paths
    clean_inputs = _builder_inputs_clean(root) and all_effective_inputs_tracked
    if any(state is _UNSUPPORTED for state in module_states):
        reason = 'module_state_unsupported'
    elif key is None:
        reason = 'fixture_key_unsupported'
    elif not clean_inputs:
        reason = 'builder_inputs_dirty_or_untracked'
    else:
        reason = None
    return key, revision, reason is None, reason


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

    def _build(self, builder, builder_args):
        temporary = tempfile.TemporaryDirectory(prefix='cloudflare-public-fixture-')
        template = Path(temporary.name) / 'site'
        template.mkdir()
        try:
            builder(template, *builder_args)
            _assert_regular_tree(template)
        except BaseException:
            temporary.cleanup()
            raise
        return temporary, template

    @staticmethod
    def _diagnose(event, digest, reason):
        label = digest[:16] if isinstance(digest, str) and re.fullmatch(r'[0-9a-f]{64}', digest) else 'unavailable'
        print(
            f'public-artifact-fixture cache={event} digest={label} reason={reason}',
            file=sys.stderr, flush=True,
        )

    def copy_to(self, key, builder, destination, *, cacheable=True, bypass_reason=None,
                builder_args=()):
        destination = Path(destination)
        if destination.exists() or destination.is_symlink():
            raise ValueError('Artifact fixture copy destination already exists')
        builder_state = _stable_value({'function': builder, 'args': builder_args})
        if builder_state is _UNSUPPORTED:
            cacheable = False
            bypass_reason = 'builder_state_unsupported'
        if key is None:
            cacheable = False
            bypass_reason = bypass_reason or 'fixture_key_unsupported'
        if builder_state is _UNSUPPORTED or key is None:
            effective_key = None
        else:
            identity = _stable_value({'inputKey': key, 'builderState': builder_state})
            if identity is _UNSUPPORTED:
                cacheable = False
                bypass_reason = bypass_reason or 'fixture_key_unsupported'
                effective_key = None
            else:
                effective_key = hashlib.sha256(json.dumps(
                    identity, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                ).encode()).hexdigest()
        if effective_key is None:
            cacheable = False
            bypass_reason = bypass_reason or 'fixture_key_unsupported'
        if not cacheable:
            self._diagnose('bypass', effective_key, bypass_reason or 'inputs_not_cacheable')
            temporary, template = self._build(builder, builder_args)
            try:
                return copy_regular_tree(template, destination)
            finally:
                temporary.cleanup()
        if effective_key != self._key:
            reason = 'template_empty' if self._key is None else 'identity_changed'
            self._diagnose('miss', effective_key, reason)
            self.close()
            temporary, template = self._build(builder, builder_args)
            current_state = _stable_value({'function': builder, 'args': builder_args})
            if current_state is _UNSUPPORTED or current_state != builder_state:
                self._diagnose('bypass', None, 'builder_state_changed_during_build')
                try:
                    return copy_regular_tree(template, destination)
                finally:
                    temporary.cleanup()
            self._temporary, self._template = temporary, template
            self._key = effective_key
        else:
            self._diagnose('hit', effective_key, 'exact_identity')
        return copy_regular_tree(self._template, destination)


_CLOUDFLARE_CACHE = ArtifactTemplateCache()


def _build_cloudflare_fixture(path, root, revision, cloudflare_build):
    """Build with explicit inputs instead of capturing the Cloudflare module."""
    cloudflare_build(root, path, revision)
    receipt = json.loads((path / 'deployment.json').read_text(encoding='utf-8'))
    if receipt.get('sourceCommit') != revision:
        raise ValueError('Cloudflare test fixture sourceCommit is not the current Git HEAD')


def prepare_cloudflare_test_artifact(root, temporary_directory, cloudflare, font_producer):
    """Return a per-class copy of an external artifact or the shared clean build."""
    destination = Path(temporary_directory) / 'site'
    external = os.environ.get('PAGE_FONT_ARTIFACT_ROOT')
    if external:
        return copy_regular_tree(Path(external).resolve(), destination)

    key, revision, clean_inputs, reason = _cloudflare_input_identity(
        root, cloudflare, font_producer,
    )
    result = _CLOUDFLARE_CACHE.copy_to(
        key, _build_cloudflare_fixture, destination,
        cacheable=clean_inputs, bypass_reason=reason,
        builder_args=(Path(root).resolve(), revision, cloudflare.build),
    )
    receipt = json.loads((result / 'deployment.json').read_text(encoding='utf-8'))
    if receipt.get('sourceCommit') != revision:
        raise ValueError('Shared Cloudflare test fixture sourceCommit differs from its input key')
    return result
