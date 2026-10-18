#!/usr/bin/env python3
"""Fail-closed validation for published page-font artifacts and HTTP responses."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path, PurePosixPath

from bs4 import BeautifulSoup

import build_artifact_page_fonts as producer
import build_public


ROOT = Path(__file__).resolve().parents[1]
FONT_MANIFEST = producer.MANIFEST_NAME
FONT_PREFIXES = (producer.CORE_DIR + "/", producer.DELTA_DIR + "/")
FONT_NAME = re.compile(r"[a-f0-9]{64}\.woff2\Z")


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _safe_relative(path: str) -> bool:
    candidate = PurePosixPath(path)
    return (bool(path) and candidate.as_posix() == path and not candidate.is_absolute()
            and ".." not in candidate.parts and "\\" not in path)


def is_page_font_path(path: str) -> bool:
    if not isinstance(path, str):
        return False
    for prefix in FONT_PREFIXES:
        if path.startswith(prefix):
            return bool(FONT_NAME.fullmatch(path[len(prefix):]))
    return False


def validate_font_bytes(path: str, payload: bytes, row: dict) -> dict:
    """Validate bytes and their WOFF2 cmap/axis against one manifest row."""
    if not is_page_font_path(path):
        raise ValueError("PAGE_FONT_PATH_INVALID: " + str(path))
    if not isinstance(row, dict):
        raise ValueError("PAGE_FONT_ROW_INVALID: " + path)
    digest = sha256(payload)
    if path.rsplit("/", 1)[-1] != digest + ".woff2" or row.get("sha256") != digest:
        raise ValueError("PAGE_FONT_SHA256_OR_PATH_MISMATCH: " + path)
    if row.get("bytes") != len(payload):
        raise ValueError("PAGE_FONT_SIZE_MISMATCH: " + path)
    try:
        info = producer.font_info(payload)
    except (ValueError, OSError) as error:
        raise ValueError("PAGE_FONT_WOFF2_INVALID: " + path) from error
    codepoints = row.get("codepoints")
    if (not isinstance(codepoints, list)
            or codepoints != sorted(set(codepoints))
            or any(type(value) is not int or not 0 <= value <= 0x10FFFF for value in codepoints)
            or producer.glyphset_sha256(codepoints) != row.get("glyphsetSha256")):
        raise ValueError("PAGE_FONT_GLYPHSET_HASH_INVALID: " + path)
    if info["codepoints"] != codepoints:
        raise ValueError("PAGE_FONT_CMAP_MISMATCH: " + path)
    role = "common" if path.startswith(producer.CORE_DIR + "/") else "delta"
    expected_family = producer.CORE_FAMILY if role == "common" else producer.DELTA_FAMILY
    if expected_family not in info["families"]:
        raise ValueError("PAGE_FONT_FAMILY_MISMATCH: " + path)
    if info.get("wght") != [{"tag": "wght", "min": 250, "default": 250, "max": 900}]:
        raise ValueError("PAGE_FONT_WGHT_AXIS_MISMATCH: " + path)
    return info


def validate_route_html(route: str, payload: bytes, row: dict) -> None:
    """Check the emitted route marker, exact inline style and complete preload set."""
    soup = BeautifulSoup(payload, "html5lib")
    if soup.html is None or soup.head is None or soup.html.get("data-huiwen-font-artifact-route") != route:
        raise ValueError("PAGE_FONT_ROUTE_MARKER_INVALID: " + route)
    common, delta = row.get("commonFont"), row.get("deltaFont")
    if not is_page_font_path(common) or not is_page_font_path(delta):
        raise ValueError("PAGE_FONT_ROUTE_PATH_INVALID: " + route)
    styles = soup.find_all("style", attrs={producer.STYLE_MARKER: "1"})
    if len(styles) != 1:
        raise ValueError("PAGE_FONT_ROUTE_STYLE_MISSING: " + route)
    style = str(styles[0].string or styles[0].decode_contents())
    if sha256(style.encode("utf-8")) != row.get("styleSha256"):
        raise ValueError("PAGE_FONT_ROUTE_STYLE_HASH_MISMATCH: " + route)
    expected_block, _ = producer.make_style(route, common, delta)
    expected_soup = BeautifulSoup(expected_block, "html5lib")
    expected_style = expected_soup.find("style", attrs={producer.STYLE_MARKER: "1"})
    if style != str(expected_style.string or expected_style.decode_contents()):
        raise ValueError("PAGE_FONT_ROUTE_STYLE_CONTENT_MISMATCH: " + route)
    preloads = soup.find_all("link", attrs={producer.PRELOAD_MARKER: True})
    all_preloads = soup.select('link[rel~="preload"][as="font"]')
    actual = {
        tag.get(producer.PRELOAD_MARKER): str(tag.get("href", "")).lstrip("/")
        for tag in preloads
    }
    if (row.get("preloads") != [common, delta] or len(preloads) != 2 or len(all_preloads) != 2
            or actual != {"common": common, "delta": delta}):
        raise ValueError("PAGE_FONT_ROUTE_PRELOAD_CLOSURE_INVALID: " + route)


def load_publication(artifact_root: Path) -> tuple[dict, bytes]:
    root = Path(artifact_root)
    manifest_path = root / "publication-manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("PAGE_FONT_PUBLICATION_MANIFEST_MISSING_OR_UNSAFE")
    raw = manifest_path.read_bytes()
    publication = json.loads(raw)
    files = publication.get("files") if isinstance(publication, dict) else None
    if not isinstance(publication, dict) or publication.get("version") != 1 or not isinstance(files, dict):
        raise ValueError("PAGE_FONT_PUBLICATION_MANIFEST_INVALID")
    for path, digest in files.items():
        if not isinstance(path, str) or not _safe_relative(path):
            raise ValueError("PAGE_FONT_PUBLICATION_PATH_INVALID: " + str(path))
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("PAGE_FONT_PUBLICATION_HASH_INVALID: " + path)
    return publication, raw


def validate_publication_binding(artifact_root: Path, publication: dict, manifest: dict, manifest_bytes: bytes) -> None:
    """Bind the font manifest, every font file and all namespace entries to publication."""
    root = Path(artifact_root)
    files = publication["files"]
    declared_manifest = files.get(FONT_MANIFEST)
    if not declared_manifest or sha256(manifest_bytes) != declared_manifest:
        raise ValueError("PAGE_FONT_MANIFEST_NOT_BOUND_TO_PUBLICATION")
    rows = manifest.get("fonts")
    if manifest.get("schemaVersion") != producer.MANIFEST_SCHEMA or not isinstance(rows, dict) or not rows:
        raise ValueError("PAGE_FONT_MANIFEST_INVALID")

    expected_paths = set()
    for path, row in rows.items():
        if not is_page_font_path(path):
            raise ValueError("PAGE_FONT_ASSET_PATH_INVALID: " + str(path))
        if not isinstance(row, dict) or path.rsplit("/", 1)[-1] != str(row.get("sha256", "")) + ".woff2":
            raise ValueError("PAGE_FONT_ASSET_FILENAME_NOT_FULL_SHA256: " + path)
        if type(row.get("bytes")) is not int or row["bytes"] < 1:
            raise ValueError("PAGE_FONT_ASSET_SIZE_INVALID: " + path)
        codepoints = row.get("codepoints")
        if (not isinstance(codepoints, list) or codepoints != sorted(set(codepoints))
                or any(type(value) is not int or not 0 <= value <= 0x10FFFF for value in codepoints)
                or producer.glyphset_sha256(codepoints) != row.get("glyphsetSha256")):
            raise ValueError("PAGE_FONT_GLYPHSET_HASH_INVALID: " + path)
        expected_paths.add(path)
        if files.get(path) != row.get("sha256"):
            raise ValueError("PAGE_FONT_ASSET_NOT_BOUND_TO_PUBLICATION: " + path)
        target = root / path
        if (target.is_symlink() or not target.is_file() or root.resolve() not in target.resolve().parents
                or sha256(target.read_bytes()) != files[path]):
            raise ValueError("PAGE_FONT_ASSET_PUBLICATION_BYTES_MISMATCH: " + path)

    actual_namespace_paths = set()
    for prefix in FONT_PREFIXES:
        directory = root / prefix.rstrip("/")
        if directory.is_symlink():
            raise ValueError("PAGE_FONT_NAMESPACE_SYMLINK: " + prefix)
        if directory.exists():
            for item in directory.rglob("*"):
                if item.is_symlink() or not item.is_file():
                    if item.is_dir() and not item.is_symlink():
                        raise ValueError("PAGE_FONT_NAMESPACE_NESTED_DIRECTORY: " + item.relative_to(root).as_posix())
                    raise ValueError("PAGE_FONT_NAMESPACE_UNSAFE_ENTRY: " + item.relative_to(root).as_posix())
                actual_namespace_paths.add(item.relative_to(root).as_posix())
    if actual_namespace_paths != expected_paths:
        extra = sorted(actual_namespace_paths - expected_paths)
        missing = sorted(expected_paths - actual_namespace_paths)
        raise ValueError(f"PAGE_FONT_NAMESPACE_CLOSURE_INVALID: extra={extra[:3]} missing={missing[:3]}")
    for path in expected_paths:
        target = root / path
        if (files.get(path) != sha256(target.read_bytes()) or rows[path].get("bytes") != target.stat().st_size
                or root.resolve() not in target.resolve().parents):
            raise ValueError("PAGE_FONT_NAMESPACE_UNPUBLISHED_OR_TAMPERED: " + path)


def page_font_namespace_records(artifact_root: Path, publication: dict) -> dict[str, list[tuple[str, str]]]:
    """Return byte-verified full-SHA font entries grouped by their two cache namespaces."""
    root = Path(artifact_root)
    files = publication.get("files") if isinstance(publication, dict) else None
    if not isinstance(files, dict):
        raise ValueError("PAGE_FONT_PUBLICATION_MANIFEST_INVALID")
    manifest_path = root / FONT_MANIFEST
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("PAGE_FONT_MANIFEST_MISSING_OR_UNSAFE")
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    validate_publication_binding(root, publication, manifest, manifest_bytes)
    grouped = {producer.CORE_DIR: [], producer.DELTA_DIR: []}
    for path, row in manifest["fonts"].items():
        prefix = producer.CORE_DIR if path.startswith(producer.CORE_DIR + "/") else producer.DELTA_DIR
        grouped[prefix].append((path, row["sha256"]))
    if not grouped[producer.CORE_DIR] or not grouped[producer.DELTA_DIR]:
        raise ValueError("PAGE_FONT_NAMESPACE_EMPTY")
    return grouped


def validate_route_publication(artifact_root: Path, publication: dict, routes) -> None:
    root = Path(artifact_root)
    files = publication.get("files") if isinstance(publication, dict) else None
    if not isinstance(files, dict):
        raise ValueError("PAGE_FONT_PUBLICATION_MANIFEST_INVALID")
    for route in routes:
        if route not in files:
            raise ValueError("PAGE_FONT_ROUTE_NOT_PUBLISHED: " + route)
        target = root / route
        if (target.is_symlink() or not target.is_file() or root.resolve() not in target.resolve().parents
                or sha256(target.read_bytes()) != files[route]):
            raise ValueError("PAGE_FONT_ROUTE_PUBLICATION_BYTES_MISMATCH: " + route)


def validate_artifact_contract(artifact_root: Path, source_root: Path = ROOT) -> dict:
    """Validate producer closure against current public projection and publication hashes."""
    root, source = Path(artifact_root).resolve(), Path(source_root).resolve()
    publication, _ = load_publication(root)
    manifest_path = root / FONT_MANIFEST
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    validate_publication_binding(root, publication, manifest, manifest_bytes)
    candidate_routes, inactive_routes = producer.candidate_routes(
        source, root, build_public.public_paths(source),
    )
    validate_route_publication(root, publication, candidate_routes)
    _, public_ids = producer._inactive_and_public_ids(source)
    producer.validate_manifest(root, manifest, candidate_routes, inactive_routes, public_ids)
    return {"publication": publication, "manifest": manifest, "manifestBytes": manifest_bytes,
            "fonts": manifest["fonts"], "routes": manifest["routes"],
            "fontRoutes": sorted(manifest["routes"]), "fontAssets": sorted(manifest["fonts"])}
