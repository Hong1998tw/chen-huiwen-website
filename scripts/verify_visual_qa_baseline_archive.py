#!/usr/bin/env python3
"""Validate and safely extract the exact 30-capture A-05 baseline artifact."""
from __future__ import annotations

from python_guard import require_supported_python
require_supported_python()

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile, ZipFile

ROOT = Path(__file__).resolve().parents[1]
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 150 * 1024 * 1024
MAX_ENTRY_BYTES = 12 * 1024 * 1024
CAPTURE_COUNT = 30
SHA256 = re.compile(r'^[a-f0-9]{64}$')
SHA40 = re.compile(r'^[a-f0-9]{40}$')


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def expected_capture_ids(policy_path: Path) -> set[str]:
    policy = json.loads(policy_path.read_text(encoding='utf-8'))
    ids = {
        f"{route['id']}-{viewport['width']}"
        for route in policy['routes']
        for viewport in policy['viewports']
    }
    if len(ids) != CAPTURE_COUNT:
        raise ValueError('A05_POLICY_CAPTURE_SET_INVALID')
    return ids


def _file_name(info) -> str:
    name = info.filename
    path = PurePosixPath(name)
    if ('\\' in name or '\x00' in name or path.is_absolute() or
            len(path.parts) != 1 or path.name in ('', '.', '..') or name != path.name):
        raise ValueError('BASELINE_ARCHIVE_PATH_INVALID')
    mode = (info.external_attr >> 16) & 0o170000
    if mode not in (0, stat.S_IFREG):
        raise ValueError('BASELINE_ARCHIVE_ENTRY_NOT_REGULAR_FILE')
    return name


def _safe_output_path(output_dir: Path) -> Path:
    output = Path(os.path.abspath(os.fspath(output_dir)))
    # macOS exposes temporary paths through /tmp and /var aliases; normalize those
    # system aliases before rejecting caller-controlled symlink path components.
    for alias in (Path('/tmp'), Path('/var')):
        if output == alias or alias in output.parents:
            canonical_alias = Path(os.path.realpath(alias))
            if canonical_alias != alias:
                output = canonical_alias / output.relative_to(alias)
            break

    cursor = Path(output.anchor)
    parts = output.parts[1:]
    for index, part in enumerate(parts):
        cursor = cursor / part
        try:
            info = cursor.lstat()
        except FileNotFoundError:
            break
        if stat.S_ISLNK(info.st_mode):
            raise ValueError('BASELINE_OUTPUT_PATH_SYMLINK')
        if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
            raise ValueError('BASELINE_OUTPUT_PATH_INVALID')
        if index == len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
            raise ValueError('BASELINE_OUTPUT_PATH_INVALID')
    return output


def verify_and_extract(archive_path: Path, output_dir: Path, *, policy_path: Path | None = None,
                       max_archive_bytes: int = MAX_ARCHIVE_BYTES,
                       max_uncompressed_bytes: int = MAX_UNCOMPRESSED_BYTES,
                       max_entry_bytes: int = MAX_ENTRY_BYTES) -> dict:
    archive_path = Path(archive_path)
    size = archive_path.stat().st_size
    if size <= 0 or size > max_archive_bytes:
        raise ValueError('BASELINE_ARCHIVE_SIZE_INVALID')

    try:
        with ZipFile(archive_path) as archive:
            entries = {}
            total_uncompressed = 0
            infos = archive.infolist()
            for info in infos:
                name = _file_name(info)
                if info.is_dir() or name in entries:
                    raise ValueError('BASELINE_ARCHIVE_ENTRY_INVALID')
                entries[name] = info
            if len(entries) != CAPTURE_COUNT * 2 + 2:
                raise ValueError('BASELINE_ARCHIVE_ENTRY_COUNT_INVALID')
            for name, info in list(entries.items()):
                if info.file_size > max_entry_bytes:
                    raise ValueError('BASELINE_ARCHIVE_ENTRY_TOO_LARGE')
                total_uncompressed += info.file_size
                if total_uncompressed > max_uncompressed_bytes:
                    raise ValueError('BASELINE_ARCHIVE_EXPANSION_TOO_LARGE')
                entries[name] = (info, archive.read(info))
    except BadZipFile as error:
        raise ValueError('BASELINE_ARCHIVE_ZIP_INVALID') from error

    manifest_bytes = entries.get('manifest.json', (None, None))[1]
    sidecar_bytes = entries.get('manifest.sha256', (None, None))[1]
    if manifest_bytes is None or sidecar_bytes is None:
        raise ValueError('BASELINE_ARCHIVE_MANIFEST_MISSING')
    try:
        sidecar = sidecar_bytes.decode('ascii').strip()
    except UnicodeDecodeError as error:
        raise ValueError('BASELINE_ARCHIVE_MANIFEST_HASH_INVALID') from error
    match = re.fullmatch(r'([a-f0-9]{64})  manifest\.json', sidecar)
    if not match or match.group(1) != digest(manifest_bytes):
        raise ValueError('BASELINE_ARCHIVE_MANIFEST_HASH_MISMATCH')
    try:
        manifest = json.loads(manifest_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError('BASELINE_ARCHIVE_MANIFEST_INVALID') from error
    if (not isinstance(manifest, dict) or manifest.get('schemaVersion') != 3 or
            manifest.get('status') != 'APPROVED' or
            not isinstance(manifest.get('approval'), dict) or
            not all(str(manifest['approval'].get(key, '')).strip() for key in ('reviewedBy', 'reviewedAt', 'note'))):
        raise ValueError('BASELINE_ARCHIVE_NOT_APPROVED')
    source_sha = manifest.get('sourceSHA')
    tool_sha = manifest.get('captureToolSHA')
    if (not isinstance(source_sha, str) or not SHA40.fullmatch(source_sha) or
            manifest.get('siteSourceSHA') != source_sha or
            not isinstance(tool_sha, str) or not SHA40.fullmatch(tool_sha) or
            manifest.get('checkoutSHA') != tool_sha):
        raise ValueError('BASELINE_ARCHIVE_SOURCE_SHA_INVALID')
    captures = manifest.get('captures')
    if not isinstance(captures, list) or len(captures) != CAPTURE_COUNT:
        raise ValueError('BASELINE_ARCHIVE_CAPTURE_SET_INVALID')

    ids = set()
    expected_files = {'manifest.json', 'manifest.sha256'}
    for capture in captures:
        if not isinstance(capture, dict):
            raise ValueError('BASELINE_ARCHIVE_CAPTURE_INVALID')
        capture_id = capture.get('id')
        if not isinstance(capture_id, str) or not re.fullmatch(r'[a-z0-9-]+', capture_id) or capture_id in ids:
            raise ValueError('BASELINE_ARCHIVE_CAPTURE_ID_INVALID')
        if (capture.get('sourceSHA') != source_sha or capture.get('siteSourceSHA') != source_sha or
                capture.get('captureToolSHA') != tool_sha or capture.get('checkoutSHA') != tool_sha):
            raise ValueError('BASELINE_ARCHIVE_CAPTURE_SOURCE_SHA_MISMATCH')
        ids.add(capture_id)
        png_path, metadata_path = f'{capture_id}.png', f'{capture_id}.json'
        if capture.get('screenshotPath') != png_path or capture.get('metadataPath') != metadata_path:
            raise ValueError('BASELINE_ARCHIVE_CAPTURE_PATH_INVALID')
        png_sha, metadata_sha = capture.get('screenshotSha256'), capture.get('metadataSha256')
        if not isinstance(png_sha, str) or not SHA256.fullmatch(png_sha) or not isinstance(metadata_sha, str) or not SHA256.fullmatch(metadata_sha):
            raise ValueError('BASELINE_ARCHIVE_CAPTURE_HASH_INVALID')
        png_bytes = entries.get(png_path, (None, None))[1]
        metadata_bytes = entries.get(metadata_path, (None, None))[1]
        if png_bytes is None or metadata_bytes is None:
            raise ValueError('BASELINE_ARCHIVE_CAPTURE_FILE_MISSING')
        if not png_bytes.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('BASELINE_ARCHIVE_PNG_INVALID')
        if digest(png_bytes) != png_sha:
            raise ValueError('BASELINE_ARCHIVE_PNG_HASH_MISMATCH')
        if digest(metadata_bytes) != metadata_sha:
            raise ValueError('BASELINE_ARCHIVE_METADATA_HASH_MISMATCH')
        try:
            metadata = json.loads(metadata_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError('BASELINE_ARCHIVE_CAPTURE_METADATA_INVALID') from error
        if not isinstance(metadata, dict):
            raise ValueError('BASELINE_ARCHIVE_CAPTURE_METADATA_INVALID')
        if (metadata.get('id') != capture_id or metadata.get('sourceSHA') != source_sha or
                metadata.get('siteSourceSHA') != source_sha or metadata.get('captureToolSHA') != tool_sha or
                metadata.get('checkoutSHA') != tool_sha or
                metadata.get('screenshotSha256') != png_sha or
                metadata.get('environmentLabel') != capture.get('environmentLabel') or
                metadata.get('measurementScope') != capture.get('measurementScope')):
            raise ValueError('BASELINE_ARCHIVE_CAPTURE_METADATA_MISMATCH')
        expected_files.update((png_path, metadata_path))

    if policy_path is not None and ids != expected_capture_ids(Path(policy_path)):
        raise ValueError('BASELINE_ARCHIVE_CAPTURE_IDS_MISMATCH')
    if set(entries) != expected_files:
        raise ValueError('BASELINE_ARCHIVE_FILE_SET_MISMATCH')

    output_dir = _safe_output_path(Path(output_dir))
    output_dir.mkdir(parents=True, exist_ok=True)
    output_dir = _safe_output_path(output_dir)
    if any(output_dir.iterdir()):
        raise ValueError('BASELINE_OUTPUT_NOT_EMPTY')
    for name, (_, data) in entries.items():
        (output_dir / name).write_bytes(data)
    return {
        'status': 'VERIFIED',
        'manifestSha256': digest(manifest_bytes),
        'sourceSHA': source_sha,
        'captureCount': len(captures),
        'pngCount': sum(name.endswith('.png') for name in expected_files),
        'metadataCount': sum(name.endswith('.json') for name in expected_files) - 1
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--policy', type=Path, default=ROOT / 'tests/donation/visual-qa-policy.json')
    args = parser.parse_args()
    try:
        receipt = verify_and_extract(args.archive, args.output, policy_path=args.policy)
    except (OSError, ValueError, RuntimeError, NotImplementedError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(receipt, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
