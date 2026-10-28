#!/usr/bin/env python3
"""Build artifact-only q9 WOFF2 common/delta faces for public detail pages.

The only supported producer runtime is fontTools 4.66.1 plus Brotli 1.2.0.
fontTools has no public WOFF2 quality argument, so this module uses a local,
version-guarded writer and TTFont adapter. It never patches package globals.
"""
from __future__ import annotations

from python_guard import require_supported_python
require_supported_python()

from collections import OrderedDict, defaultdict
from calendar import monthrange
from hashlib import sha256
from html import unescape
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import resource
import sys
import tempfile
import time
import unicodedata
import rare_han_support as rare_support
from urllib.parse import unquote, urlsplit

import brotli
import fontTools
from bs4 import BeautifulSoup
from fontTools import subset
from fontTools.misc.textTools import pad
from fontTools.ttLib import TTFont, TTLibError
from fontTools.ttLib import sfnt as sfnt_module
from fontTools.ttLib import ttFont as ttfont_module
from fontTools.ttLib import woff2 as woff2_module
from fontTools.ttLib.sfnt import SFNTWriter
from fontTools.ttLib.woff2 import WOFF2Writer


ROOT = Path(__file__).resolve().parents[1]
TC_REL = "assets/fonts/huiwen-site-sans/huiwen-site-sans-tc-20261007.woff2"
JP_REL = "assets/fonts/huiwen-site-sans/source-han-sans-jp-vf-2.005R.woff2"
LICENSE_REL = "assets/fonts/huiwen-site-sans/LICENSE.txt"
MANIFEST_NAME = "page-font-manifest.json"
MANIFEST_SCHEMA = 2
QUALITY = 9
EXPECTED_TC_SHA256 = "04b42051aaae0a7927a00fbf125b67c29f9c2eacc5f54e2c53073c0a59b8960f"
EXPECTED_MODULE_SHA256 = {
    "fontTools.ttLib.woff2": "3f7e0028c924ad31d6116eb8d253870ed0de89fec24e597b97e9d06af07438d8",
    "fontTools.ttLib.ttFont": "01bed50be567307a84cd4f0c19e12514e746689501f6f7aacddc04edeeb59079",
    "fontTools.ttLib.sfnt": "adb2adf08781868769f14bcff10ec6cd3772f6fb80d4d316c4404bcc8653a4d9",
    "fontTools.subset": "977e38c0da72464a56c6917cb9d2dac468d5f0a478edc42abf4cecb9b7989a66",
}
FONT_ROOT = "assets/fonts/huiwen-site-sans"
CORE_DIR = f"{FONT_ROOT}/page-core"
DELTA_DIR = f"{FONT_ROOT}/page-delta"
CORE_FAMILY = "Huiwen Sans TC Page Common"
DELTA_FAMILY = "Huiwen Sans TC Page Delta"
CORE_UNIQUE_ID = "Huiwen Sans TC Page Common; q9; 1"
DELTA_UNIQUE_ID = "Huiwen Sans TC Page Delta; q9; 1"
WHOLE_PAGE_FAMILY = "Huiwen Sans TC Page Core"
WHOLE_PAGE_UNIQUE_ID = "Huiwen Sans TC Page Core; 1.0"
ROUTE_RE = re.compile(r"^(?:achievement|news)-[a-z0-9-]+\.html$")
LEGACY_REDIRECT_REASON = "legacy-meta-refresh-without-full-tc-font"
STYLE_MARKER = "data-huiwen-font-page-artifact"
PRELOAD_MARKER = "data-huiwen-font-page-preload"
OPTIONS = {"flavor": "woff2", "layout_features": ["*"], "retain_gids": False}
REQUIRED_ATTRS = {"alt", "placeholder", "title", "value"}
CJK_RANGES = (
    (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF),
    (0x20000, 0x2FA1F), (0x30000, 0x323AF),
)
KERN_SCRIPT_TAGS = {"DFLT", "latn", "hani", "kana", "grek", "cyrl"}
COMMON_CLOSURE_ALGORITHM = "route-intersection+source-ascii-latin-combining+default-kern-connected-components-v1"
SCRIPT_DYNAMIC_TEXT = (
    "搜尋⌕⌘ K天 Ctrl K 搜尋陳慧文官網 關閉搜尋 全站搜尋 "
    "搜尋政績、新聞、政見、里別…… 搜尋資料載入中… "
    "開啟選單 開啟主要選單 關閉主要選單 關閉選單 2026選舉 律師時間表 "
    "分享這一頁 網址已複製 複製分享網址 請選取並複製下方網址。 分享網址 關閉"
)
FINGERPRINTED_DYNAMIC_SCRIPTS = re.compile(
    r"(?P<alias>digital|news|civic|legal-calendar|public-records)\.(?P<digest>[a-f0-9]{64})\.js\Z"
)
FINGERPRINTED_PRESS_SCRIPT = re.compile(r"press\.(?P<digest>[a-f0-9]{64})\.js\Z")
CASE_DYNAMIC_TEXT = (
    "延伸閱讀 延伸探索 依里別與共同主題串連政績、新聞與政見，方便一次閱讀相關內容。 "
    "政績 × 新聞 × 政見 → 探索 分享這一頁"
)
NEWS_DYNAMIC_TEXT = (
    "內容與完整報導 篇 閱讀 的內容與完整報導 篩選與排序說明 "
    "重要優先沿用編輯排序；日期優先依報導日期由新到舊。 "
    "全部主題 全部標籤 已選 項 上一頁 下一頁 新聞報導第 頁 全部 筆 第 頁"
)


def sha256_bytes(payload: bytes) -> str:
    return sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_json(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def glyphset_sha256(codepoints) -> str:
    values = list(codepoints)
    if values != sorted(set(values)) or any(type(value) is not int or not 0 <= value <= 0x10FFFF for value in values):
        raise ValueError("FONT_GLYPHSET_NOT_SORTED_UNIQUE_INTS")
    return sha256_bytes(json.dumps(values, separators=(",", ":")).encode("ascii"))


def module_sha256(module) -> str:
    return sha256_bytes(Path(module.__file__).read_bytes())


def verify_environment() -> dict:
    actual_modules = {
        "fontTools.ttLib.woff2": module_sha256(woff2_module),
        "fontTools.ttLib.ttFont": module_sha256(ttfont_module),
        "fontTools.ttLib.sfnt": module_sha256(sfnt_module),
        "fontTools.subset": module_sha256(subset),
    }
    actual_brotli = getattr(brotli, "__version__", "unknown")
    if fontTools.__version__ != "4.66.1" or actual_brotli != "1.2.0":
        raise RuntimeError(f"FONT_Q9_RUNTIME_VERSION_MISMATCH: fontTools={fontTools.__version__}, Brotli={actual_brotli}")
    if actual_modules != EXPECTED_MODULE_SHA256:
        raise RuntimeError(f"FONT_Q9_INTERNAL_API_SOURCE_MISMATCH: {actual_modules}")
    if woff2_module.brotli is not brotli:
        raise RuntimeError("FONT_Q9_BROTLI_IMPLEMENTATION_MISMATCH")
    return {
        "python": platform.python_version(),
        "fontTools": fontTools.__version__,
        "brotli": actual_brotli,
        "quality": QUALITY,
        "options": OPTIONS,
        "modules": actual_modules,
        "writerApi": "fontTools.ttLib.woff2.WOFF2Writer.close copied with explicit brotli quality=9",
        "fontApi": "fontTools.ttLib.ttFont.TTFont._save adapter selecting a local WOFF2Writer subclass",
    }


# Derived from fontTools 4.66.1 fontTools/ttLib/woff2.py WOFF2Writer.close.
# fontTools is MIT licensed; see scripts/THIRD_PARTY_NOTICES.fonttools.txt.
class Q9WOFF2Writer(WOFF2Writer):
    """Use only Brotli quality 9 while preserving fontTools' WOFF2 framing."""

    def close(self):
        if len(self.tables) != self.numTables:
            raise TTLibError(
                "wrong number of tables; expected %d, found %d"
                % (self.numTables, len(self.tables))
            )
        if self.sfntVersion in ("\x00\x01\x00\x00", "true"):
            is_true_type = True
        elif self.sfntVersion == "OTTO":
            is_true_type = False
        else:
            raise TTLibError("Not a TrueType or OpenType font (bad sfntVersion)")
        if (
            is_true_type
            and "glyf" in self.flavorData.transformedTables
            and "glyf" in self.tables
        ):
            self._normaliseGlyfAndLoca(padding=4)
        self._setHeadTransformFlag()
        self.tables = OrderedDict(sorted(self.tables.items()))
        self.totalSfntSize = self._calcSFNTChecksumsLengthsAndOffsets()
        font_data = self._transformTables()
        compressed_font = brotli.compress(font_data, mode=brotli.MODE_FONT, quality=QUALITY)
        self.totalCompressedSize = len(compressed_font)
        self.length = self._calcTotalSize()
        self.majorVersion, self.minorVersion = self._getVersion()
        self.reserved = 0
        directory = self._packTableDirectory()
        self.file.seek(0)
        self.file.write(pad(directory + compressed_font, size=4))
        self._writeFlavorData()


# Derived from fontTools 4.66.1 fontTools/ttLib/ttFont.py TTFont._save.
class Q9TTFont(TTFont):
    """Select Q9WOFF2Writer locally; no module-level factory is patched."""

    def _save(self, file, tableCache=None):
        if self.flavor != "woff2":
            raise RuntimeError("FONT_Q9_ADAPTER_REQUIRES_WOFF2")
        if self.recalcTimestamp and "head" in self:
            self["head"]
        tags = self.keys()
        tags.pop(0)
        writer = Q9WOFF2Writer(file, len(tags), self.sfntVersion, self.flavor, self.flavorData)
        done = []
        for tag in tags:
            self._writeTable(tag, writer, done, tableCache)
        writer.close()
        return writer.reordersTables()


def unicode_cmap(font: TTFont) -> dict[int, str]:
    """Return every valid Unicode scalar mapping, preferring getBestCmap on conflicts."""
    mappings = {}
    for table in font["cmap"].tables:
        if not table.isUnicode():
            continue
        table_cmap = getattr(table, "cmap", None)
        if not isinstance(table_cmap, dict):
            continue
        for codepoint, glyph_name in table_cmap.items():
            if (
                type(codepoint) is int
                and 0 <= codepoint <= 0x10FFFF
                and not 0xD800 <= codepoint <= 0xDFFF
                and glyph_name
            ):
                mappings.setdefault(codepoint, glyph_name)
    mappings.update(font.getBestCmap() or {})
    return dict(sorted(mappings.items()))


def font_info(payload: bytes, *, include_tables: bool = False) -> dict:
    if not isinstance(payload, bytes) or payload[:4] != b"wOF2":
        raise ValueError("FONT_PAYLOAD_NOT_WOFF2")
    try:
        font = TTFont(BytesIO(payload), recalcBBoxes=False, recalcTimestamp=False)
        result = {
            "codepoints": list(unicode_cmap(font)),
            "tableTags": sorted(font.reader.keys()),
            "wght": [],
            "families": [],
        }
        if "fvar" in font:
            result["wght"] = [
                {"tag": axis.axisTag, "min": axis.minValue, "default": axis.defaultValue, "max": axis.maxValue}
                for axis in font["fvar"].axes
            ]
        if "name" in font:
            result["families"] = sorted({
                record.toUnicode()
                for record in font["name"].names
                if record.nameID in {1, 4, 16, 21}
            })
        if include_tables:
            result["tables"] = {
                str(tag): sha256_bytes(font.reader[tag])
                for tag in sorted(font.reader.keys())
            }
        font.close()
        return result
    except Exception as error:
        raise ValueError(f"FONT_PAYLOAD_INVALID_WOFF2: {error}") from error


def rename_font_family(font: TTFont, family: str, unique_id: str) -> None:
    names = font["name"]
    for name_id in (1, 4, 16, 21):
        names.removeNames(nameID=name_id)
        names.setName(family, name_id, 3, 1, 0x409)
        names.setName(family, name_id, 0, 4, 0)
    names.removeNames(nameID=6)
    postscript = re.sub(r"[^A-Za-z0-9]", "", family)
    names.setName(postscript, 6, 3, 1, 0x409)
    names.setName(postscript, 6, 0, 4, 0)
    names.removeNames(nameID=3)
    names.setName(unique_id, 3, 3, 1, 0x409)
    names.setName(unique_id, 3, 0, 4, 0)


def source_axes(source_bytes: bytes) -> list[dict]:
    font = TTFont(BytesIO(source_bytes), recalcBBoxes=False, recalcTimestamp=False)
    axes = [
        {"tag": axis.axisTag, "min": axis.minValue, "default": axis.defaultValue, "max": axis.maxValue}
        for axis in font["fvar"].axes
    ] if "fvar" in font else []
    font.close()
    return axes


def validate_compiled_font(payload: bytes, expected: tuple[int, ...], family: str, axes: list[dict]) -> dict:
    info = font_info(payload)
    if info["codepoints"] != list(expected):
        raise ValueError("FONT_Q9_CMAP_NOT_EXACT")
    if info["wght"] != axes or axes != [{"tag": "wght", "min": 250.0, "default": 250.0, "max": 900.0}]:
        raise ValueError("FONT_Q9_WGHT_AXIS_MISMATCH")
    if not {"CFF2", "fvar"}.issubset(info["tableTags"]):
        raise ValueError("FONT_Q9_VARIABLE_CFF2_TABLES_MISSING")
    if family not in info["families"]:
        raise ValueError("FONT_Q9_FAMILY_MISMATCH")
    return info


class ProcessFontCompiler:
    """A private, in-memory cache whose values can only come from this compiler."""

    def __init__(self):
        self.cache: dict[str, bytes] = {}
        self.attestations: dict[str, str] = {}
        self.hits = 0
        self.misses = 0
        self.code_sha256 = sha256_bytes(Path(__file__).read_bytes())
        self.environment = verify_environment()

    def key(self, source_bytes: bytes, codepoints, family: str, unique_id: str, options: dict) -> tuple[str, tuple[int, ...]]:
        glyphs = tuple(sorted(set(codepoints)))
        if not glyphs or any(type(cp) is not int or cp < 0 or cp > 0x10FFFF for cp in glyphs):
            raise ValueError("FONT_Q9_EMPTY_OR_INVALID_GLYPHSET")
        inputs = {
            "schemaVersion": 1,
            "sourceFontSha256": sha256_bytes(source_bytes),
            "compilerSha256": self.code_sha256,
            "python": self.environment["python"],
            "fontTools": self.environment["fontTools"],
            "brotli": self.environment["brotli"],
            "moduleHashes": self.environment["modules"],
            "quality": QUALITY,
            "family": family,
            "uniqueId": unique_id,
            "glyphset": list(glyphs),
            "options": json.loads(canonical_json(options)),
        }
        return sha256_bytes(canonical_json(inputs)), glyphs

    def compile(self, source_bytes: bytes, codepoints, family: str, unique_id: str, options: dict | None = None) -> tuple[bytes, dict]:
        if not isinstance(source_bytes, bytes):
            raise TypeError("FONT_SOURCE_MUST_BE_BYTES")
        effective_options = json.loads(canonical_json(OPTIONS if options is None else options))
        key, glyphs = self.key(source_bytes, codepoints, family, unique_id, effective_options)
        payload = self.cache.get(key)
        if payload is not None:
            try:
                if self.attestations.get(key) != sha256_bytes(payload):
                    raise ValueError("FONT_Q9_CACHE_ATTESTATION_MISMATCH")
                validate_compiled_font(payload, glyphs, family, source_axes(source_bytes))
                self.hits += 1
                return payload, {"cacheHit": True, "keySha256": key, "sha256": sha256_bytes(payload), "bytes": len(payload)}
            except Exception:
                self.cache.pop(key, None)
                self.attestations.pop(key, None)
        self.misses += 1
        payload = self._compile(source_bytes, glyphs, family, unique_id, effective_options)
        validate_compiled_font(payload, glyphs, family, source_axes(source_bytes))
        self.cache[key] = payload
        self.attestations[key] = sha256_bytes(payload)
        return payload, {"cacheHit": False, "keySha256": key, "sha256": self.attestations[key], "bytes": len(payload)}

    @staticmethod
    def _compile(source_bytes: bytes, codepoints: tuple[int, ...], family: str, unique_id: str, options: dict) -> bytes:
        font = Q9TTFont(BytesIO(source_bytes), recalcBBoxes=False, recalcTimestamp=False)
        subset_options = subset.Options()
        for name, value in options.items():
            setattr(subset_options, name, value)
        subsetter = subset.Subsetter(options=subset_options)
        subsetter.populate(unicodes=list(codepoints))
        created = font["head"].created
        modified = font["head"].modified
        subsetter.subset(font)
        requested = set(codepoints)
        for cmap_table in font["cmap"].tables:
            if cmap_table.isUnicode():
                cmap_table.cmap = {
                    cp: name for cp, name in cmap_table.cmap.items()
                    if cp in requested
                }
        rename_font_family(font, family, unique_id)
        font["head"].created = created
        font["head"].modified = modified
        font.recalcTimestamp = False
        font.flavor = "woff2"
        output = BytesIO()
        font.save(output)
        font.close()
        return output.getvalue()


def is_cjk(codepoint: int) -> bool:
    return any(start <= codepoint <= end for start, end in CJK_RANGES)


def is_required_character(char: str) -> bool:
    category = unicodedata.category(char)
    return is_cjk(ord(char)) or category[0] in {"L", "M", "N"}


def css_unescape(value: str) -> str:
    value = unescape(value)
    value = re.sub(r"\\([0-9a-fA-F]{1,6})(?:\s)?", lambda match: chr(int(match.group(1), 16)), value)
    return re.sub(r"\\(.)", r"\1", value)


def css_content_strings(css: str) -> str:
    pattern = re.compile(r"content\s*:\s*(?:\"((?:\\.|[^\"\\])*)\"|'((?:\\.|[^'\\])*)')", re.I | re.S)
    values = [css_unescape(match.group(1) if match.group(1) is not None else match.group(2)) for match in pattern.finditer(css)]
    return "\n".join(values)


def _safe_css_path(root: Path, route: str, href: str) -> Path | None:
    parsed = urlsplit(href)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return None
    raw_path = unquote(parsed.path)
    if raw_path.startswith("/"):
        relative = PurePosixPath(raw_path.lstrip("/"))
    else:
        parent = PurePosixPath(route).parent
        relative = (PurePosixPath("") if str(parent) == "." else parent) / raw_path
    normalized = PurePosixPath(os.path.normpath(str(relative)))
    if normalized.is_absolute() or ".." in normalized.parts:
        raise ValueError(f"FONT_CSS_PATH_TRAVERSAL: {route}: {href}")
    target = root.joinpath(*normalized.parts)
    if target.suffix.lower() != ".css":
        return None
    if target.is_symlink() or not target.is_file() or root.resolve() not in target.resolve().parents:
        raise ValueError(f"FONT_CSS_PATH_MISSING_OR_UNSAFE: {route}: {normalized.as_posix()}")
    return target


def _safe_artifact_path(root: Path, href: str) -> Path:
    parsed = urlsplit(href)
    if parsed.scheme or parsed.netloc or not parsed.path:
        raise ValueError("FONT_ASSET_PATH_NOT_LOCAL")
    raw_path = unquote(parsed.path)
    normalized = PurePosixPath(os.path.normpath(raw_path.lstrip("/")))
    if normalized.is_absolute() or ".." in normalized.parts:
        raise ValueError("FONT_ASSET_PATH_TRAVERSAL")
    target = root.joinpath(*normalized.parts)
    if target.is_symlink() or not target.is_file() or root.resolve() not in target.resolve().parents:
        raise ValueError("FONT_ASSET_PATH_MISSING_OR_UNSAFE")
    return target


def _css_imports(css: str) -> list[str]:
    return re.findall(r"@import\s+(?:url\(\s*)?[\"']([^\"']+)[\"']", css, flags=re.I)


def linked_css(root: Path, route: str, soup) -> tuple[list[str], str]:
    paths = set()
    pieces = []
    visited = set()

    def read_css(path: Path, href: str):
        relative = path.relative_to(root).as_posix()
        if relative in visited:
            return
        visited.add(relative)
        css = path.read_text(encoding="utf-8")
        pieces.append(css_content_strings(css))
        if re.search(r"content\s*:[^;}]*attr\(\s*href\s*\)", css, re.I):
            for anchor in soup.find_all("a", href=True):
                value = str(anchor["href"])
                if value.startswith(("https://", "http://", "//")):
                    pieces.append(value)
        for imported in _css_imports(css):
            target = _safe_css_path(root, route, imported)
            if target:
                paths.add(target.relative_to(root).as_posix())
                read_css(target, imported)

    for link in soup.find_all("link", href=True):
        rels = {str(item).lower() for item in (link.get("rel") or [])}
        if "stylesheet" not in rels:
            continue
        target = _safe_css_path(root, route, str(link["href"]))
        if target:
            paths.add(target.relative_to(root).as_posix())
            read_css(target, str(link["href"]))
    for style in soup.find_all("style"):
        pieces.append(css_content_strings(str(style.string or style.decode_contents())))
    for node in soup.find_all(attrs={"style": True}):
        pieces.append(css_content_strings(str(node.get("style", ""))))
    return sorted(paths), "\n".join(pieces)


def _press_script_references(soup):
    references = []
    for tag in soup.find_all("script", src=True):
        raw = str(tag["src"])
        parsed = urlsplit(raw)
        decoded_path = unquote(parsed.path).replace("\\", "/")
        basename = PurePosixPath(decoded_path).name
        if basename == "press.js" or FINGERPRINTED_PRESS_SCRIPT.fullmatch(basename):
            references.append((tag, parsed, decoded_path))
    return references


def _active_press_runtime(soup):
    """Return the referenced press runtime and its grid only when it can render."""
    references = _press_script_references(soup)
    section = soup.select_one("[data-press-index]")
    grid = section.select_one("[data-press-grid]") if section is not None else None
    # press.js exits before reading PAGE_SIZE or changing text when this DOM is
    # absent. A mere script reference is therefore not a pagination surface.
    if not references or section is None or grid is None:
        return None
    if len(references) != 1:
        raise ValueError("FONT_PRESS_PAGINATION_SCRIPT_AMBIGUOUS")
    return references[0], grid


def _press_script_source(root: Path, reference) -> Path:
    _tag, parsed, decoded_path = reference
    if parsed.scheme or parsed.netloc:
        raise ValueError("FONT_PRESS_PAGINATION_SCRIPT_PATH_UNSAFE")
    root = Path(root).resolve()
    normalized_path = PurePosixPath(decoded_path).as_posix().lstrip("/")
    if normalized_path in {"press.js"} and not parsed.fragment:
        path = root / "press.js"
        if path.is_symlink() or root not in path.resolve().parents:
            raise ValueError("FONT_PRESS_PAGINATION_SOURCE_UNSAFE")
        if not path.is_file():
            raise ValueError("FONT_PRESS_PAGINATION_SOURCE_MISSING")
        if parsed.query:
            match = re.fullmatch(r"v=([a-f0-9]{12})", parsed.query)
            if not match or not sha256_file(path).startswith(match.group(1)):
                raise ValueError("FONT_PRESS_PAGINATION_SCRIPT_VERSION_MISMATCH")
        return path

    hashed = FINGERPRINTED_PRESS_SCRIPT.fullmatch(PurePosixPath(normalized_path).name)
    if hashed and normalized_path == PurePosixPath(normalized_path).name:
        path = _safe_artifact_path(root, parsed.path)
        if sha256_file(path) != hashed.group("digest"):
            raise ValueError("FONT_PRESS_PAGINATION_SCRIPT_FILENAME_HASH_MISMATCH")
        return path
    raise ValueError("FONT_PRESS_PAGINATION_SCRIPT_PATH_UNSAFE")


def dynamic_ui_text(route: str, soup, root: Path = ROOT) -> str:
    script_names = set()
    for tag in soup.find_all("script", src=True):
        parsed = urlsplit(str(tag["src"]))
        if not parsed.scheme and not parsed.netloc:
            script_path = PurePosixPath(unquote(parsed.path))
            script_name = script_path.name
            match = FINGERPRINTED_DYNAMIC_SCRIPTS.fullmatch(script_name)
            if match and script_path.as_posix().lstrip("/") == script_name:
                artifact_script = _safe_artifact_path(root, parsed.path)
                if sha256_file(artifact_script) != match.group("digest"):
                    raise ValueError("FONT_DYNAMIC_SCRIPT_FILENAME_HASH_MISMATCH: " + script_name)
                script_names.add(match.group("alias") + ".js")
            else:
                script_names.add(script_name)
    pieces = [SCRIPT_DYNAMIC_TEXT]
    press_runtime = _active_press_runtime(soup)
    if press_runtime is not None:
        reference, grid = press_runtime
        script_path = _press_script_source(root, reference)
        script = script_path.read_text(encoding="utf-8")
        page_sizes = re.findall(r"\bconst\s+PAGE_SIZE\s*=\s*(\d+)\s*;", script)
        if not page_sizes:
            raise ValueError("FONT_PRESS_PAGE_SIZE_NOT_FOUND")
        if len(page_sizes) != 1:
            raise ValueError("FONT_PRESS_PAGE_SIZE_AMBIGUOUS")
        page_size_match = page_sizes[0]
        page_size = int(page_size_match)
        if page_size < 1:
            raise ValueError("FONT_PRESS_PAGE_SIZE_INVALID")
        total = len(grid.select("[data-news-categories]"))
        pages = max(1, (total + page_size - 1) // page_size)
        if soup.select_one("[data-press-index] [data-press-count]") is not None:
            pieces.append(f"全部 · {total} 筆 · 第 1/{pages} 頁" if total else "全部 · 0 筆")
        if total > page_size and soup.select_one("[data-press-index] [data-press-pagination]") is not None:
            pieces.extend(("上一頁", "下一頁"))
            pieces.extend(str(page) for page in range(1, pages + 1))
            pieces.extend(f"新聞發稿第 {page} 頁" for page in range(1, pages + 1))
    if "digital.js" in script_names and PurePosixPath(route).name.startswith("achievement-"):
        pieces.append(CASE_DYNAMIC_TEXT)
    if "public-records.js" in script_names and soup.select_one('article[id^="record-"]') is not None:
        pieces.append("顯示全部工作紀錄 目前顯示 1 筆工作紀錄，共 0123456789 筆可供查閱。 找不到這筆工作紀錄，以下顯示全部 0123456789 筆。 共 0123456789 筆工作紀錄。")
    if "news.js" in script_names:
        pieces.extend((NEWS_DYNAMIC_TEXT, "陳慧文於高雄市議會市政總質詢發言 2024年11月29日，陳慧文於高雄市議會市政總質詢發言。圖／陳慧文議員服務處提供。"))
    if "civic.js" in script_names:
        pieces.append("搜尋政績、新聞、歷屆政見、活動與服務資訊。 顯示本月全部日期 只看今日起的日期 僅顯示今日起的日期")
    if route == "service.html" and "legal-calendar.js" in script_names:
        schedule_node = soup.find(id="legal-schedule-data")
        if schedule_node is None:
            raise ValueError("FONT_SERVICE_LEGAL_SCHEDULE_DATA_MISSING")
        try:
            schedule = json.loads(schedule_node.string or schedule_node.get_text())
        except (json.JSONDecodeError, TypeError) as error:
            raise ValueError("FONT_SERVICE_LEGAL_SCHEDULE_DATA_INVALID") from error
        month = schedule.get("month") if isinstance(schedule, dict) else None
        sessions = schedule.get("sessions") if isinstance(schedule, dict) else None
        if not isinstance(month, str) or not re.fullmatch(r"\d{4}-\d{2}", month) or not isinstance(sessions, list):
            raise ValueError("FONT_SERVICE_LEGAL_SCHEDULE_SHAPE_INVALID")
        page_month = soup.select_one("[data-schedule-month]")
        if page_month is None or page_month.get("data-schedule-month") != month:
            raise ValueError("FONT_SERVICE_LEGAL_SCHEDULE_MONTH_MISMATCH")
        year, month_number = month.split("-")
        session_dates = []
        for session in sessions:
            session_date = session.get("date") if isinstance(session, dict) else None
            if not isinstance(session_date, str) or not re.fullmatch(rf"{re.escape(month)}-\d{{2}}", session_date):
                raise ValueError("FONT_SERVICE_LEGAL_SCHEDULE_SESSION_DATE_INVALID")
            session_dates.append(session_date)

        pieces.extend((
            f"{year}年{int(month_number)}月已公布 {len(sessions)} 場，請先確認名額再前往",
            f"此為{year}年{int(month_number)}月時間表；新月份請先來電確認",
            f"這是 {month} 的歷史時間表，已非當月資訊。新月份時段請查看服務處最新公告或來電確認。",
        ))
        if sessions:
            pieces.append(
                "下一場諮詢 已選場次 此場次已結束 本月已公布場次已結束 "
                "顯示本月全部日期 只看尚未結束的場次 · 僅顯示尚未結束的場次"
            )
        else:
            pieces.append("本月未安排諮詢場次")
        # civic.js filters by date, so its state is reachable before month-end
        # when at least one published session falls before the final day.
        last_day = monthrange(int(year), int(month_number))[1]
        if any(int(session_date[-2:]) < last_day for session_date in session_dates):
            pieces.append("只看今日起的日期 · 僅顯示今日起的日期")
    return "\n".join(pieces)


def parse_jp_face(root: Path, css: str) -> tuple[set[int], dict[int, str]]:
    faces = re.findall(r"@font-face\s*\{[^}]*font-family\s*:\s*[\"']Huiwen Sans JP Support[\"'][^}]*\}", css, re.I)
    if len(faces) != 1:
        raise ValueError("FONT_JP_SUPPORT_FACE_MISSING_OR_AMBIGUOUS")
    face = faces[0]
    ranges_match = re.search(r"unicode-range\s*:\s*([^;}]+)", face, re.I)
    src_match = re.search(r"src\s*:\s*url\(\s*([\"']?)([^\"')]+)\1\s*\)", face, re.I)
    if not ranges_match or not src_match:
        raise ValueError("FONT_JP_SUPPORT_RANGE_OR_SOURCE_MISSING")
    allowed = set()
    for item in ranges_match.group(1).split(","):
        match = re.fullmatch(r"\s*U\+([0-9A-Fa-f]{1,6})\s*", item)
        if not match:
            raise ValueError("FONT_JP_SUPPORT_RANGE_NOT_EXACT_CODEPOINTS")
        allowed.add(int(match.group(1), 16))
    path = _safe_artifact_path(root, src_match.group(2))
    jp = TTFont(path, recalcBBoxes=False, recalcTimestamp=False)
    cmap = jp.getBestCmap() or {}
    jp.close()
    return allowed, cmap


def extract_page_spec(root: Path, route: str, tc_cmap: dict[int, str], jp_allowed: set[int], jp_cmap: dict[int, str]) -> dict:
    path = root / route
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"FONT_ROUTE_MISSING_OR_UNSAFE: {route}")
    return _page_spec_from_bytes(root, route, path.read_bytes(), tc_cmap, jp_allowed, jp_cmap, require_unmarked=True)


def _page_spec_from_bytes(
    root: Path,
    route: str,
    raw: bytes,
    tc_cmap: dict[int, str],
    jp_allowed: set[int],
    jp_cmap: dict[int, str],
    *,
    require_unmarked: bool,
) -> dict:
    soup = BeautifulSoup(raw, "html5lib")
    if soup.html is None or soup.head is None or soup.body is None:
        raise ValueError(f"FONT_ROUTE_MALFORMED_HTML: {route}")
    if soup.html.get("data-huiwen-font-page"):
        raise ValueError(f"FONT_EXISTING_ROUTE_MUST_BE_SKIPPED: {route}")
    if require_unmarked and (soup.html.get("data-huiwen-font-artifact-route") or STYLE_MARKER in raw.decode("utf-8", "replace")):
        raise ValueError(f"FONT_ARTIFACT_ROUTE_ALREADY_MARKED: {route}")
    text_parts = []
    for node in soup.find_all(string=True):
        parent = getattr(node, "parent", None)
        if parent is not None and parent.name in {"script", "style", "template"}:
            continue
        text_parts.append(str(node))
    for node in soup.find_all(True):
        if node.name in {"script", "style", "template"}:
            continue
        for attr in REQUIRED_ATTRS:
            value = node.get(attr)
            if isinstance(value, list):
                value = " ".join(map(str, value))
            if value:
                text_parts.append(str(value))
        for attr, value in node.attrs.items():
            if str(attr).lower().startswith("aria-") and value:
                text_parts.append(" ".join(map(str, value)) if isinstance(value, list) else str(value))
        if node.name == "input" and str(node.get("type", "")).lower() != "hidden" and node.get("value"):
            text_parts.append(str(node["value"]))
    stylesheet_paths, css_text = linked_css(root, route, soup)
    visible_text = "\n".join(text_parts + [css_text, dynamic_ui_text(route, soup, root)])
    characters = {ord(char) for char in visible_text}
    support_css = "\n".join((root / path).read_text(encoding="utf-8") for path in stylesheet_paths)
    support_css += "\n" + "\n".join(str(style.string or style.decode_contents()) for style in soup.find_all("style"))
    supplement_allowed, supplement_cmap = rare_support.parse_face(root, support_css)
    tc_glyphs = tuple(sorted(characters.intersection(tc_cmap)))
    if not tc_glyphs:
        raise ValueError(f"FONT_ROUTE_HAS_NO_TC_GLYPHS: {route}")
    missing = sorted(cp for cp in characters if is_required_character(chr(cp)) and cp not in tc_cmap and cp not in jp_cmap and cp not in supplement_cmap)
    if missing:
        sample = " ".join(f"U+{cp:04X} {chr(cp)}" for cp in missing[:20])
        raise ValueError(f"FONT_ROUTE_HAS_UNCOVERED_REQUIRED_CHARACTERS: {route}: {sample}")
    jp_missing = sorted(cp for cp in characters if is_required_character(chr(cp)) and cp not in tc_cmap and cp in jp_cmap)
    outside_face = sorted(set(jp_missing) - jp_allowed)
    if outside_face:
        sample = " ".join(f"U+{cp:04X} {chr(cp)}" for cp in outside_face[:20])
        raise ValueError(f"FONT_ROUTE_NEEDS_JP_GLYPH_OUTSIDE_EXACT_FACE: {route}: {sample}")
    supplement_missing = sorted(cp for cp in characters if is_required_character(chr(cp))
                                and cp not in tc_cmap and cp not in jp_cmap and cp in supplement_cmap)
    if set(supplement_missing) - supplement_allowed:
        raise ValueError("FONT_ROUTE_NEEDS_SUPPLEMENT_OUTSIDE_EXACT_FACE: " + route)
    return {
        "route": route,
        "html": raw,
        "codepoints": tc_glyphs,
        "glyphsetSha256": glyphset_sha256(list(tc_glyphs)),
        "jpFallback": jp_missing,
        "supplementFallback": supplement_missing,
        "stylesheetPaths": stylesheet_paths,
        "dataTextCharacters": len(visible_text),
    }


def _safe_public_html_route(route: str) -> bool:
    if not isinstance(route, str) or not route or "\\" in route:
        return False
    path = PurePosixPath(route)
    return (
        not path.is_absolute()
        and path.suffix.lower() == ".html"
        and ".." not in path.parts
        and "." not in path.parts
        and path.as_posix() == route
    )


def _uses_full_tc_font(root: Path, route: str, raw: bytes, soup) -> bool:
    stylesheet_paths, _ = linked_css(root, route, soup)
    css = [
        (root / relative).read_text(encoding="utf-8")
        for relative in stylesheet_paths
    ]
    css.extend(str(style.string or style.decode_contents()) for style in soup.find_all("style"))
    css.extend(str(node.get("style", "")) for node in soup.find_all(attrs={"style": True}))
    source = raw.decode("utf-8", "replace")
    if "huiwen-site-sans-tc-20261007.woff2" in source:
        return True
    return bool(re.search(
        r"(?:font-family|font)\s*:[^{};]*[\"']Huiwen Sans TC[\"']",
        "\n".join(css),
        flags=re.I,
    ))


def _legacy_redirect_target(soup, public_html_routes: set[str]) -> str | None:
    refresh = [
        node for node in soup.find_all("meta")
        if str(node.get("http-equiv", "")).strip().lower() == "refresh"
    ]
    body_text = soup.body.get_text(" ", strip=True) if soup.body else ""
    if len(refresh) != 1 or not body_text.startswith("頁面已搬移至"):
        return None
    content = str(refresh[0].get("content", ""))
    match = re.fullmatch(r"\s*0(?:\.0+)?\s*;\s*url\s*=\s*(.+?)\s*", content, flags=re.I)
    if not match:
        return None
    target = match.group(1).strip().strip("\"'")
    parsed = urlsplit(target)
    if parsed.scheme != "https" or parsed.netloc.lower() not in {"huiwen.tw", "www.huiwen.tw"} or parsed.query or parsed.fragment:
        return None
    relative = unquote(parsed.path).lstrip("/")
    target_routes = {relative, relative.rstrip("/") + "/index.html"}
    return target if target_routes.intersection(public_html_routes) else None


def public_html_route_inventory(source_root: Path, artifact_root: Path, public_paths):
    paths = sorted(set(public_paths))
    html_routes = sorted(path for path in paths if PurePosixPath(path).suffix.lower() == ".html")
    unsafe = [route for route in html_routes if not _safe_public_html_route(route)]
    if unsafe:
        raise ValueError("FONT_PUBLIC_HTML_ROUTE_UNSAFE: " + ", ".join(unsafe[:20]))
    inactive = set()
    state_path = source_root / "data/page-content.json"
    if state_path.is_file():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        pages = state.get("pages", {}) if isinstance(state, dict) else {}
        if isinstance(pages, dict):
            inactive = {
                route for route, row in pages.items()
                if isinstance(row, dict) and row.get("status", "published") in {"unpublished", "deleted"}
            }
    public_ids = {
        row.get("id") for row in json.loads((source_root / "data/achievements-public.json").read_text(encoding="utf-8"))
        if isinstance(row, dict) and isinstance(row.get("id"), str)
    }
    detail_routes = [path for path in html_routes if path == PurePosixPath(path).name and ROUTE_RE.fullmatch(path)]
    stale = [path for path in detail_routes if path in inactive]
    stale.extend(
        path for path in detail_routes
        if PurePosixPath(path).name.startswith("achievement-")
        and PurePosixPath(path).stem.removeprefix("achievement-") not in public_ids
    )
    if stale:
        raise ValueError("FONT_UNPUBLISHED_OR_UNPROJECTED_ROUTE_IN_PUBLIC_PATHS: " + ", ".join(sorted(set(stale))[:20]))
    eligible = []
    skipped = []
    excluded = []
    public_route_set = set(html_routes)
    for route in html_routes:
        output = artifact_root / route
        if not output.is_file() or output.is_symlink():
            raise ValueError(f"FONT_PUBLIC_HTML_MISSING_FROM_ARTIFACT: {route}")
        raw = output.read_bytes()
        soup = BeautifulSoup(raw, "html5lib")
        if soup.html is None:
            raise ValueError(f"FONT_PUBLIC_HTML_MALFORMED: {route}")
        if soup.html and soup.html.get("data-huiwen-font-page"):
            skipped.append(route)
        elif _uses_full_tc_font(artifact_root, route, raw, soup):
            eligible.append(route)
        else:
            target = _legacy_redirect_target(soup, public_route_set)
            if target is None:
                raise ValueError(f"FONT_PUBLIC_HTML_NON_TC_ROUTE_UNCLASSIFIED: {route}")
            excluded.append({"route": route, "reason": LEGACY_REDIRECT_REASON, "target": target})
    return eligible, skipped, excluded


def candidate_routes(source_root: Path, artifact_root: Path, public_paths) -> tuple[list[str], list[str]]:
    eligible, skipped, _excluded = public_html_route_inventory(source_root, artifact_root, public_paths)
    return eligible, skipped


def source_glyphs(source_bytes: bytes) -> tuple[dict[int, str], list[dict]]:
    font = TTFont(BytesIO(source_bytes), recalcBBoxes=False, recalcTimestamp=False)
    cmap = unicode_cmap(font)
    axes = [
        {"tag": axis.axisTag, "min": axis.minValue, "default": axis.defaultValue, "max": axis.maxValue}
        for axis in font["fvar"].axes
    ] if "fvar" in font else []
    font.close()
    return cmap, axes


def _value_record_activity(value, variation_store) -> tuple[bool, bool]:
    if value is None:
        return False, False
    base = any(
        getattr(value, field, 0) not in (None, 0)
        for field in ("XPlacement", "YPlacement", "XAdvance", "YAdvance")
    )
    variation = False
    for field in ("XPlaDevice", "YPlaDevice", "XAdvDevice", "YAdvDevice"):
        device = getattr(value, field, None)
        if device is None:
            continue
        delta_format = getattr(device, "DeltaFormat", None)
        if delta_format == 0x8000:
            if variation_store is None:
                raise ValueError("FONT_KERN_VARIATION_INDEX_WITHOUT_VARSTORE")
            outer = getattr(device, "StartSize", None)
            inner = getattr(device, "EndSize", None)
            var_data = getattr(variation_store, "VarData", None) or []
            if type(outer) is not int or type(inner) is not int or not 0 <= outer < len(var_data):
                raise ValueError("FONT_KERN_VARIATION_INDEX_OUT_OF_RANGE")
            items = getattr(var_data[outer], "Item", None) or []
            if not 0 <= inner < len(items):
                raise ValueError("FONT_KERN_VARIATION_INDEX_OUT_OF_RANGE")
            variation = variation or any(delta != 0 for delta in items[inner])
        elif delta_format in {1, 2, 3}:
            deltas = getattr(device, "DeltaValue", None) or []
            variation = variation or any(delta != 0 for delta in deltas)
        else:
            raise ValueError(f"FONT_KERN_DEVICE_FORMAT_UNSUPPORTED: {delta_format}")
    return base, variation


def source_default_kern_evidence(font, cmap: dict[int, str] | None = None) -> dict:
    """Resolve active default `kern` PairPos edges, including variation-only records."""
    cmap = unicode_cmap(font) if cmap is None else cmap
    if "GPOS" not in font:
        return {
            "scriptTags": [], "featureIndices": [], "lookupIndices": [], "subtables": [],
            "pairEdges": set(), "baseEdges": set(), "variationEdges": set(),
            "classZeroEdges": set(), "participantGlyphs": set(), "participantCodepoints": set(),
            "encodedPairEdges": set(), "encodedBaseEdges": set(), "encodedVariationEdges": set(),
            "encodedClassZeroEdges": set(),
        }
    gpos = font["GPOS"].table
    feature_records = getattr(getattr(gpos, "FeatureList", None), "FeatureRecord", None) or []
    script_records = getattr(getattr(gpos, "ScriptList", None), "ScriptRecord", None) or []
    feature_indices = set()
    script_tags = set()
    for script_record in script_records:
        script_tag = getattr(script_record, "ScriptTag", None)
        script = getattr(script_record, "Script", None)
        lang_sys = getattr(script, "DefaultLangSys", None)
        if script_tag not in KERN_SCRIPT_TAGS or lang_sys is None:
            continue
        indices = list(getattr(lang_sys, "FeatureIndex", None) or [])
        required = getattr(lang_sys, "ReqFeatureIndex", 0xFFFF)
        if required != 0xFFFF:
            indices.append(required)
        active = {index for index in indices if type(index) is int and 0 <= index < len(feature_records)
                  and getattr(feature_records[index], "FeatureTag", None) == "kern"}
        if active:
            feature_indices.update(active)
            script_tags.add(script_tag)

    lookup_indices = set()
    for index in feature_indices:
        feature = getattr(feature_records[index], "Feature", None)
        lookup_indices.update(getattr(feature, "LookupListIndex", None) or [])

    # Include variable FeatureTableSubstitution alternatives for enabled default kern features.
    feature_variations = getattr(gpos, "FeatureVariations", None)
    variation_records = getattr(feature_variations, "FeatureVariationRecord", None) or []
    for variation_record in variation_records:
        substitution = getattr(variation_record, "FeatureTableSubstitution", None)
        for item in getattr(substitution, "SubstitutionRecord", None) or []:
            if getattr(item, "FeatureIndex", None) not in feature_indices:
                continue
            alternate = getattr(item, "Feature", None)
            lookup_indices.update(getattr(alternate, "LookupListIndex", None) or [])

    lookup_list = getattr(getattr(gpos, "LookupList", None), "Lookup", None) or []
    if any(type(index) is not int or not 0 <= index < len(lookup_list) for index in lookup_indices):
        raise ValueError("FONT_KERN_LOOKUP_INDEX_OUT_OF_RANGE")
    variation_store = getattr(getattr(font.get("GDEF").table, "VarStore", None), "VarData", None) if "GDEF" in font else None
    if variation_store is not None:
        variation_store = font["GDEF"].table.VarStore

    pair_edges = set()
    base_edges = set()
    variation_edges = set()
    class_zero_edges = set()
    participants = set()
    subtable_metrics = []
    glyph_order = list(font.getGlyphOrder())

    for lookup_index in sorted(lookup_indices):
        lookup = lookup_list[lookup_index]
        lookup_type = getattr(lookup, "LookupType", None)
        for subtable_index, outer in enumerate(getattr(lookup, "SubTable", None) or []):
            if lookup_type == 2:
                subtable = outer
            elif lookup_type == 9 and getattr(outer, "ExtensionLookupType", None) == 2:
                subtable = getattr(outer, "ExtSubTable", None)
            else:
                raise ValueError(f"FONT_KERN_LOOKUP_UNSUPPORTED: lookup={lookup_index} type={lookup_type}")
            fmt = getattr(subtable, "Format", None)
            if fmt not in {1, 2}:
                raise ValueError(f"FONT_KERN_PAIRPOS_FORMAT_UNSUPPORTED: lookup={lookup_index} format={fmt}")
            local_pairs = set()
            local_base = set()
            local_variation = set()
            local_class_zero = set()
            if fmt == 1:
                coverage = list(getattr(getattr(subtable, "Coverage", None), "glyphs", None) or [])
                pair_sets = list(getattr(subtable, "PairSet", None) or [])
                if len(coverage) != len(pair_sets):
                    raise ValueError("FONT_KERN_PAIRSET_COVERAGE_LENGTH_MISMATCH")
                for first, pair_set in zip(coverage, pair_sets):
                    for pair in getattr(pair_set, "PairValueRecord", None) or []:
                        first_activity = _value_record_activity(getattr(pair, "Value1", None), variation_store)
                        second_activity = _value_record_activity(getattr(pair, "Value2", None), variation_store)
                        has_base = first_activity[0] or second_activity[0]
                        has_variation = first_activity[1] or second_activity[1]
                        if not (has_base or has_variation):
                            continue
                        edge = (first, pair.SecondGlyph)
                        local_pairs.add(edge)
                        if has_base:
                            local_base.add(edge)
                        if has_variation:
                            local_variation.add(edge)
            else:
                coverage = set(getattr(getattr(subtable, "Coverage", None), "glyphs", None) or [])
                class1 = getattr(getattr(subtable, "ClassDef1", None), "classDefs", None) or {}
                class2 = getattr(getattr(subtable, "ClassDef2", None), "classDefs", None) or {}
                left_groups = defaultdict(set)
                right_groups = defaultdict(set)
                for glyph in coverage:
                    left_groups[class1.get(glyph, 0)].add(glyph)
                for glyph in glyph_order:
                    right_groups[class2.get(glyph, 0)].add(glyph)
                for first_class, row in enumerate(getattr(subtable, "Class1Record", None) or []):
                    for second_class, cell in enumerate(getattr(row, "Class2Record", None) or []):
                        first_activity = _value_record_activity(getattr(cell, "Value1", None), variation_store)
                        second_activity = _value_record_activity(getattr(cell, "Value2", None), variation_store)
                        has_base = first_activity[0] or second_activity[0]
                        has_variation = first_activity[1] or second_activity[1]
                        if not (has_base or has_variation):
                            continue
                        for first in left_groups.get(first_class, ()):
                            for second in right_groups.get(second_class, ()):
                                edge = (first, second)
                                local_pairs.add(edge)
                                if has_base:
                                    local_base.add(edge)
                                if has_variation:
                                    local_variation.add(edge)
                                if first_class == 0 or second_class == 0:
                                    local_class_zero.add(edge)
            pair_edges.update(local_pairs)
            base_edges.update(local_base)
            variation_edges.update(local_variation)
            class_zero_edges.update(local_class_zero)
            participants.update(glyph for edge in local_pairs for glyph in edge)
            subtable_metrics.append({
                "lookupIndex": lookup_index,
                "subtableIndex": subtable_index,
                "format": fmt,
                "activeGlyphPairCount": len(local_pairs),
                "nonZeroBasePairCount": len(local_base),
                "nonEmptyVariationPairCount": len(local_variation),
                "classZeroPairCount": len(local_class_zero),
            })

    aliases = defaultdict(set)
    for codepoint, glyph in cmap.items():
        aliases[glyph].add(codepoint)
    participant_codepoints = {cp for glyph in participants for cp in aliases.get(glyph, ())}
    def encoded_pairs(edges):
        return {
            (first_cp, second_cp)
            for first, second in edges
            for first_cp in aliases.get(first, ())
            for second_cp in aliases.get(second, ())
        }

    encoded_pair_edges = encoded_pairs(pair_edges)
    encoded_base_edges = encoded_pairs(base_edges)
    encoded_variation_edges = encoded_pairs(variation_edges)
    encoded_class_zero_edges = encoded_pairs(class_zero_edges)
    return {
        "scriptTags": sorted(script_tags),
        "featureIndices": sorted(feature_indices),
        "lookupIndices": sorted(lookup_indices),
        "subtables": subtable_metrics,
        "pairEdges": pair_edges,
        "baseEdges": base_edges,
        "variationEdges": variation_edges,
        "classZeroEdges": class_zero_edges,
        "participantGlyphs": participants,
        "participantCodepoints": participant_codepoints,
        "encodedPairEdges": encoded_pair_edges,
        "encodedBaseEdges": encoded_base_edges,
        "encodedVariationEdges": encoded_variation_edges,
        "encodedClassZeroEdges": encoded_class_zero_edges,
    }


def _source_seed_codepoints(cmap: dict[int, str]) -> set[int]:
    """Seed common with encoded ASCII/Latin and combining marks."""
    return {
        codepoint for codepoint in cmap
        if codepoint < 0x250
        or 0x1E00 <= codepoint <= 0x1EFF
        or unicodedata.category(chr(codepoint)).startswith("M")
    }


def build_common_closure(source_bytes: bytes, route_codepoint_sets) -> dict:
    route_sets = [set(values) for values in route_codepoint_sets]
    if not route_sets or any(not values for values in route_sets):
        raise ValueError("FONT_ROUTE_CLOSURE_EMPTY")
    route_intersection = set(route_sets[0])
    for values in route_sets[1:]:
        route_intersection.intersection_update(values)
    font = TTFont(BytesIO(source_bytes), recalcBBoxes=False, recalcTimestamp=False)
    cmap = unicode_cmap(font)
    evidence = source_default_kern_evidence(font, cmap)
    aliases = defaultdict(set)
    for codepoint, glyph in cmap.items():
        aliases[glyph].add(codepoint)
    seeds = route_intersection | _source_seed_codepoints(cmap)
    if not seeds.issubset(cmap):
        raise ValueError("FONT_ROUTE_INTERSECTION_NOT_IN_SOURCE_CMAP")
    adjacency = defaultdict(set)
    for first, second in evidence["pairEdges"]:
        adjacency[first].add(second)
        adjacency[second].add(first)
    closure_glyphs = {cmap[codepoint] for codepoint in seeds}
    pending = list(closure_glyphs)
    while pending:
        glyph = pending.pop()
        for neighbor in adjacency.get(glyph, ()):
            if neighbor not in closure_glyphs:
                closure_glyphs.add(neighbor)
                pending.append(neighbor)
    common = set(seeds)
    common.update(codepoint for glyph in closure_glyphs for codepoint in aliases.get(glyph, ()))
    kern_participants = evidence["participantCodepoints"]
    kern_glyph_names = sorted(evidence["participantGlyphs"])
    result = {
        "algorithm": COMMON_CLOSURE_ALGORITHM,
        "routeIntersectionCodepoints": sorted(route_intersection),
        "routeIntersectionGlyphsetSha256": glyphset_sha256(sorted(route_intersection)),
        "sourceSeedCodepoints": sorted(_source_seed_codepoints(cmap)),
        "sourceSeedGlyphsetSha256": glyphset_sha256(sorted(_source_seed_codepoints(cmap))),
        "kernParticipantCodepoints": sorted(kern_participants),
        "kernParticipantGlyphsetSha256": glyphset_sha256(sorted(kern_participants)),
        "kernParticipantGlyphCount": len(evidence["participantGlyphs"]),
        "kernParticipantGlyphNamesSha256": sha256_bytes(canonical_json(kern_glyph_names)),
        "kernEvidence": {
            "scriptTags": evidence["scriptTags"],
            "featureIndices": evidence["featureIndices"],
            "lookupIndices": evidence["lookupIndices"],
            "subtables": evidence["subtables"],
            "activeGlyphPairCount": len(evidence["pairEdges"]),
            "encodedPairCount": len(evidence["encodedPairEdges"]),
            "nonZeroBaseGlyphPairCount": len(evidence["baseEdges"]),
            "nonZeroBaseEncodedPairCount": len(evidence["encodedBaseEdges"]),
            "nonEmptyVariationGlyphPairCount": len(evidence["variationEdges"]),
            "nonEmptyVariationEncodedPairCount": len(evidence["encodedVariationEdges"]),
            "variationOnlyGlyphPairCount": len(evidence["variationEdges"] - evidence["baseEdges"]),
            "variationOnlyEncodedPairCount": len(evidence["encodedVariationEdges"] - evidence["encodedBaseEdges"]),
            "classZeroGlyphPairCount": len(evidence["classZeroEdges"]),
            "classZeroEncodedPairCount": len(evidence["encodedClassZeroEdges"]),
        },
        "commonCodepoints": sorted(common),
        "commonGlyphsetSha256": glyphset_sha256(sorted(common)),
    }
    font.close()
    return result


def source_provenance(source_bytes: bytes, license_bytes: bytes) -> dict:
    font = TTFont(BytesIO(source_bytes), recalcBBoxes=False, recalcTimestamp=False)
    family_names = sorted({
        record.toUnicode()
        for record in font["name"].names
        if record.nameID in {1, 4, 16, 21}
    }) if "name" in font else []
    cmap = unicode_cmap(font)
    axes = [
        {"tag": axis.axisTag, "min": axis.minValue, "default": axis.defaultValue, "max": axis.maxValue}
        for axis in font["fvar"].axes
    ] if "fvar" in font else []
    result = {
        "fontPath": TC_REL,
        "fontSha256": sha256_bytes(source_bytes),
        "fontBytes": len(source_bytes),
        "familyNames": family_names,
        "tables": sorted(font.keys()),
        "sourceCodepointCount": len(cmap),
        "sourceCodepointGlyphsetSha256": glyphset_sha256(sorted(cmap)),
        "axes": axes,
        "licensePath": LICENSE_REL,
        "licenseSha256": sha256_bytes(license_bytes),
        "licenseBytes": len(license_bytes),
    }
    font.close()
    return result


def _woff_path(path: str, role: str) -> bool:
    prefix = CORE_DIR if role == "common" else DELTA_DIR if role == "delta" else None
    if prefix is None or not path.startswith(prefix + "/"):
        return False
    filename = path.removeprefix(prefix + "/")
    return bool(re.fullmatch(r"[a-f0-9]{64}\.woff2", filename))


def make_style(route: str, common_path: str, delta_path: str) -> tuple[str, list[str]]:
    preloads = [common_path, delta_path]
    links = "".join(
        f'<link rel="preload" href="/{path}" as="font" type="font/woff2" crossorigin="anonymous" {PRELOAD_MARKER}="{role}">'
        for role, path in (("common", common_path), ("delta", delta_path))
    )
    offline_body_override = (
        f':root[data-huiwen-font-artifact-route="{route}"] body{{font-family:var(--huiwen-font-family)}}'
        if route == "offline.html" else ""
    )
    style = (
        f'@font-face{{font-family:"{CORE_FAMILY}";src:url("/{common_path}") format("woff2");font-style:normal;font-weight:250 900;font-display:swap}}'
        f'@font-face{{font-family:"{DELTA_FAMILY}";src:url("/{delta_path}") format("woff2");font-style:normal;font-weight:250 900;font-display:swap}}'
        f':root[data-huiwen-font-artifact-route="{route}"]{{--huiwen-font-family:"{DELTA_FAMILY}","{CORE_FAMILY}","Huiwen Sans TC","Huiwen Sans JP Support","Huiwen Sans Rare Han Support",sans-serif}}'
        f'{offline_body_override}'
        ':root[data-huiwen-font-artifact-preview="1"]{--huiwen-font-family:"Huiwen Sans TC","Huiwen Sans JP Support","Huiwen Sans Rare Han Support",sans-serif}'
    )
    return links + f'<style {STYLE_MARKER}="1">{style}</style>', preloads


def inject_page(source: bytes, route: str, common_path: str, delta_path: str) -> tuple[bytes, str, list[str]]:
    text = source.decode("utf-8")
    if STYLE_MARKER in text or PRELOAD_MARKER in text:
        raise ValueError(f"FONT_ROUTE_ALREADY_HAS_ARTIFACT_CLOSURE: {route}")
    style_block, preloads = make_style(route, common_path, delta_path)
    updated, count = re.subn(r"</head\s*>", lambda _: style_block + "</head>", text, count=1, flags=re.I)
    if count != 1:
        raise ValueError(f"FONT_ROUTE_HEAD_CLOSE_NOT_UNIQUE: {route}")
    updated, count = re.subn(
        r"<html\b[^>]*>",
        lambda match: _set_route_marker(match.group(0), route),
        updated,
        count=1,
        flags=re.I,
    )
    if count != 1:
        raise ValueError(f"FONT_ROUTE_HTML_ROOT_MISSING: {route}")
    return updated.encode("utf-8"), style_block, preloads


def _set_route_marker(opening: str, route: str) -> str:
    if not _safe_public_html_route(route):
        raise ValueError("FONT_ROUTE_ATTRIBUTE_INVALID")
    opening = re.sub(r"\sdata-huiwen-font-artifact-route=(?:\"[^\"]*\"|'[^']*'|[^\s>]+)", "", opening, flags=re.I)
    return opening[:-1] + f' data-huiwen-font-artifact-route="{route}">'


def _wght_contract(info: dict) -> bool:
    return info.get("wght") == [{"tag": "wght", "min": 250.0, "default": 250.0, "max": 900.0}]


def validate_manifest(
    artifact_root: Path,
    manifest: dict,
    candidates: list[str],
    inactive_routes=None,
    public_ids=None,
    *,
    route_inventory=None,
) -> None:
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA or manifest.get("sourceFontSha256") != EXPECTED_TC_SHA256:
        raise ValueError("FONT_MANIFEST_HEADER_INVALID")
    compiler = manifest.get("compiler")
    if (
        not isinstance(compiler, dict)
        or compiler.get("quality") != QUALITY
        or compiler.get("fontTools") != "4.66.1"
        or compiler.get("brotli") != "1.2.0"
        or compiler.get("moduleHashes") != EXPECTED_MODULE_SHA256
        or compiler.get("options") != OPTIONS
        or not re.fullmatch(r"[a-f0-9]{64}", compiler.get("compilerSha256", ""))
    ):
        raise ValueError("FONT_MANIFEST_COMPILER_INVALID")
    fonts = manifest.get("fonts")
    routes = manifest.get("routes")
    if not isinstance(fonts, dict) or not isinstance(routes, dict) or set(routes) != set(candidates):
        raise ValueError("FONT_MANIFEST_ROUTE_SET_INVALID")
    inventory = manifest.get("routeInventory")
    expected_inventory_shape = {"candidateRoutes", "skippedExistingFontRoutes", "excludedRoutes"}
    if not isinstance(inventory, dict) or set(inventory) != expected_inventory_shape:
        raise ValueError("FONT_MANIFEST_ROUTE_INVENTORY_INVALID")
    if inventory.get("candidateRoutes") != sorted(set(candidates)):
        raise ValueError("FONT_MANIFEST_ROUTE_INVENTORY_CANDIDATES_INVALID")
    if route_inventory is not None and inventory != route_inventory:
        raise ValueError("FONT_MANIFEST_ROUTE_INVENTORY_SOURCE_MISMATCH")
    skipped_routes = inventory.get("skippedExistingFontRoutes")
    excluded_routes = inventory.get("excludedRoutes")
    if (
        not isinstance(skipped_routes, list)
        or skipped_routes != sorted(set(skipped_routes))
        or not isinstance(excluded_routes, list)
        or excluded_routes != sorted(excluded_routes, key=lambda row: row.get("route", "") if isinstance(row, dict) else "")
    ):
        raise ValueError("FONT_MANIFEST_ROUTE_INVENTORY_ORDER_INVALID")
    excluded_names = [row.get("route") for row in excluded_routes if isinstance(row, dict)]
    if len(excluded_names) != len(excluded_routes) or len(excluded_names) != len(set(excluded_names)):
        raise ValueError("FONT_MANIFEST_ROUTE_INVENTORY_EXCLUSIONS_INVALID")
    if set(candidates).intersection(skipped_routes) or set(candidates).intersection(excluded_names) or set(skipped_routes).intersection(excluded_names):
        raise ValueError("FONT_MANIFEST_ROUTE_INVENTORY_OVERLAP")
    all_public_html_routes = set(candidates) | set(skipped_routes) | set(excluded_names)
    if any(not _safe_public_html_route(route) for route in all_public_html_routes):
        raise ValueError("FONT_MANIFEST_ROUTE_INVENTORY_PATH_INVALID")
    inactive_routes = set(inactive_routes or ())
    validate_route_source_status(candidates, skipped_routes, inactive_routes)
    for route in skipped_routes:
        path = artifact_root / route
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"FONT_MANIFEST_SKIPPED_ROUTE_MISSING: {route}")
        soup = BeautifulSoup(path.read_bytes(), "html5lib")
        if soup.html is None or not soup.html.get("data-huiwen-font-page"):
            raise ValueError(f"FONT_MANIFEST_SKIPPED_ROUTE_MARKER_INVALID: {route}")
    for row in excluded_routes:
        route = row.get("route")
        path = artifact_root / route
        if row.get("reason") != LEGACY_REDIRECT_REASON or not path.is_file() or path.is_symlink():
            raise ValueError(f"FONT_MANIFEST_EXCLUDED_ROUTE_INVALID: {route}")
        raw = path.read_bytes()
        soup = BeautifulSoup(raw, "html5lib")
        if soup.html is None or _uses_full_tc_font(artifact_root, route, raw, soup):
            raise ValueError(f"FONT_MANIFEST_EXCLUDED_ROUTE_USES_TC_FONT: {route}")
        if _legacy_redirect_target(soup, all_public_html_routes) != row.get("target"):
            raise ValueError(f"FONT_MANIFEST_EXCLUDED_ROUTE_REDIRECT_INVALID: {route}")
    source_path = artifact_root / TC_REL
    license_path = artifact_root / LICENSE_REL
    if not source_path.is_file() or source_path.is_symlink() or not license_path.is_file() or license_path.is_symlink():
        raise ValueError("FONT_MANIFEST_SOURCE_PROVENANCE_ASSET_MISSING")
    source_bytes = source_path.read_bytes()
    license_bytes = license_path.read_bytes()
    if sha256_bytes(source_bytes) != EXPECTED_TC_SHA256:
        raise ValueError("FONT_MANIFEST_SOURCE_FONT_HASH_MISMATCH")
    if manifest.get("sourceProvenance") != source_provenance(source_bytes, license_bytes):
        raise ValueError("FONT_MANIFEST_SOURCE_PROVENANCE_INVALID")
    tc_cmap, _axes = source_glyphs(source_bytes)
    styles_path = artifact_root / "styles.css"
    if not styles_path.is_file() or styles_path.is_symlink():
        raise ValueError("FONT_MANIFEST_STYLESHEET_MISSING")
    jp_allowed, jp_cmap = parse_jp_face(artifact_root, styles_path.read_text(encoding="utf-8"))
    supplement_allowed, _supplement_cmap = rare_support.parse_face(artifact_root, styles_path.read_text(encoding="utf-8"))
    expected_supplement = rare_support.provenance(artifact_root) if supplement_allowed else None
    if manifest.get("supplementSourceProvenance") != expected_supplement:
        raise ValueError("FONT_MANIFEST_SUPPLEMENT_PROVENANCE_INVALID")
    public_ids = None if public_ids is None else set(public_ids)
    for route in routes:
        if not _safe_public_html_route(route) or route in inactive_routes:
            raise ValueError(f"FONT_MANIFEST_ROUTE_NOT_PUBLIC: {route}")
        if (
            route == PurePosixPath(route).name
            and route.startswith("achievement-")
            and public_ids is not None
            and PurePosixPath(route).stem.removeprefix("achievement-") not in public_ids
        ):
            raise ValueError(f"FONT_MANIFEST_ACHIEVEMENT_NOT_PROJECTED: {route}")
    decoded = {}
    for path, row in fonts.items():
        role = "common" if _woff_path(path, "common") else "delta" if _woff_path(path, "delta") else None
        if role is None or not isinstance(row, dict):
            raise ValueError(f"FONT_MANIFEST_ASSET_PATH_INVALID: {path}")
        if PurePosixPath(path).name != row.get("sha256", "") + ".woff2":
            raise ValueError(f"FONT_MANIFEST_ASSET_FILENAME_NOT_CONTENT_HASH: {path}")
        expected_family = CORE_FAMILY if role == "common" else DELTA_FAMILY
        if row.get("family") != expected_family:
            raise ValueError(f"FONT_MANIFEST_ASSET_FAMILY_INVALID: {path}")
        codepoints = row.get("codepoints")
        if not isinstance(codepoints, list) or glyphset_sha256(codepoints) != row.get("glyphsetSha256"):
            raise ValueError(f"FONT_MANIFEST_GLYPHSET_INVALID: {path}")
        if row.get("wght") != {"min": 250, "default": 250, "max": 900}:
            raise ValueError(f"FONT_MANIFEST_WGHT_INVALID: {path}")
        payload_path = artifact_root / path
        if not payload_path.is_file() or payload_path.is_symlink():
            raise ValueError(f"FONT_MANIFEST_ASSET_MISSING: {path}")
        payload = payload_path.read_bytes()
        if sha256_bytes(payload) != row.get("sha256") or row.get("bytes") != len(payload):
            raise ValueError(f"FONT_MANIFEST_ASSET_HASH_MISMATCH: {path}")
        info = font_info(payload)
        if info["codepoints"] != codepoints or not _wght_contract(info) or expected_family not in info["families"]:
            raise ValueError(f"FONT_MANIFEST_ASSET_CMAP_OR_AXIS_MISMATCH: {path}")
        if not {"CFF2", "fvar"}.issubset(info["tableTags"]):
            raise ValueError(f"FONT_MANIFEST_ASSET_VARIABLE_CFF2_TABLES_MISSING: {path}")
        if role == "common":
            compiled_font = TTFont(BytesIO(payload), recalcBBoxes=False, recalcTimestamp=False)
            compiled_kern = source_default_kern_evidence(compiled_font)
            compiled_font.close()
            if not compiled_kern["featureIndices"] or not compiled_kern["pairEdges"] or not compiled_kern["variationEdges"]:
                raise ValueError("FONT_MANIFEST_COMMON_KERN_FEATURE_OR_VARIATION_MISSING")
        decoded[path] = set(codepoints)
    common_paths = [path for path in fonts if _woff_path(path, "common")]
    if len(common_paths) != 1:
        raise ValueError("FONT_MANIFEST_COMMON_ASSET_COUNT_INVALID")
    common_path = common_paths[0]
    actual_route_codepoints = {}
    for route, row in routes.items():
        if not isinstance(row, dict):
            raise ValueError(f"FONT_MANIFEST_ROUTE_ENTRY_INVALID: {route}")
        common = row.get("commonFont")
        delta = row.get("deltaFont")
        if common != common_path or not _woff_path(common, "common") or not _woff_path(delta, "delta") or common not in fonts or delta not in fonts:
            raise ValueError(f"FONT_MANIFEST_ROUTE_FONT_PATH_INVALID: {route}")
        route_codepoints = row.get("codepoints")
        if not isinstance(route_codepoints, list) or glyphset_sha256(route_codepoints) != row.get("glyphsetSha256"):
            raise ValueError(f"FONT_MANIFEST_ROUTE_GLYPHSET_INVALID: {route}")
        common_set = decoded[common]
        delta_set = decoded[delta]
        if row.get("commonGlyphsetSha256") != fonts[common].get("glyphsetSha256"):
            raise ValueError(f"FONT_MANIFEST_ROUTE_COMMON_GLYPHSET_INVALID: {route}")
        if row.get("deltaGlyphsetSha256") != fonts[delta].get("glyphsetSha256"):
            raise ValueError(f"FONT_MANIFEST_ROUTE_DELTA_GLYPHSET_INVALID: {route}")
        preloads = row.get("preloads")
        if preloads != [common, delta] or len(preloads) > 2:
            raise ValueError(f"FONT_MANIFEST_PRELOAD_CLOSURE_INVALID: {route}")
        page_path = artifact_root / route
        if not page_path.is_file() or page_path.is_symlink():
            raise ValueError(f"FONT_MANIFEST_ROUTE_HTML_MISSING: {route}")
        page_bytes = page_path.read_bytes()
        soup = BeautifulSoup(page_bytes, "html5lib")
        if soup.html is None or soup.html.get("data-huiwen-font-artifact-route") != route:
            raise ValueError(f"FONT_MANIFEST_HTML_ROUTE_MARKER_INVALID: {route}")
        actual_spec = _page_spec_from_bytes(
            artifact_root, route, page_bytes, tc_cmap, jp_allowed, jp_cmap,
            require_unmarked=False,
        )
        if list(actual_spec["codepoints"]) != route_codepoints:
            raise ValueError(f"FONT_MANIFEST_ROUTE_TEXT_GLYPHSET_MISMATCH: {route}")
        if row.get("jpFallbackCodepoints") != actual_spec["jpFallback"]:
            raise ValueError(f"FONT_MANIFEST_ROUTE_FALLBACK_MISMATCH: {route}")
        if row.get("supplementFallbackCodepoints") != actual_spec["supplementFallback"]:
            raise ValueError(f"FONT_MANIFEST_ROUTE_SUPPLEMENT_MISMATCH: {route}")
        actual_route_codepoints[route] = set(route_codepoints)
        styles = soup.find_all("style", attrs={STYLE_MARKER: "1"})
        if len(styles) != 1:
            raise ValueError(f"FONT_MANIFEST_STYLE_CLOSURE_INVALID: {route}")
        style = str(styles[0].string or styles[0].decode_contents())
        if sha256_bytes(style.encode("utf-8")) != row.get("styleSha256"):
            raise ValueError(f"FONT_MANIFEST_STYLE_HASH_MISMATCH: {route}")
        expected_block, _ = make_style(route, common, delta)
        expected_soup = BeautifulSoup(expected_block, "html5lib")
        expected_style = expected_soup.find("style", attrs={STYLE_MARKER: "1"})
        if style != str(expected_style.string or expected_style.decode_contents()):
            raise ValueError(f"FONT_MANIFEST_STYLE_CONTENT_INVALID: {route}")
        if row.get("styleBytes") != len(expected_block.encode("utf-8")):
            raise ValueError(f"FONT_MANIFEST_STYLE_BYTES_INVALID: {route}")
        preload_tags = soup.find_all("link", attrs={PRELOAD_MARKER: True})
        all_font_preloads = soup.select('link[rel~="preload"][as="font"]')
        preloads_in_html = {
            tag.get(PRELOAD_MARKER): str(tag.get("href", "")).lstrip("/")
            for tag in preload_tags
        }
        if len(preload_tags) != 2 or len(all_font_preloads) != 2 or preloads_in_html != {"common": common, "delta": delta}:
            raise ValueError(f"FONT_MANIFEST_HTML_PRELOAD_CLOSURE_INVALID: {route}")
    referenced_fonts = {common_path} | {row["deltaFont"] for row in routes.values()}
    if set(fonts) != referenced_fonts:
        raise ValueError("FONT_MANIFEST_UNREFERENCED_ASSET")
    expected_closure = build_common_closure(source_bytes, [actual_route_codepoints[route] for route in sorted(actual_route_codepoints)])
    if manifest.get("routeClosure") != expected_closure:
        raise ValueError("FONT_MANIFEST_ROUTE_CLOSURE_INVALID")
    common_set = decoded[common_path]
    if common_set != set(expected_closure["commonCodepoints"]):
        raise ValueError("FONT_MANIFEST_COMMON_GLYPHSET_INVALID")
    if fonts[common_path].get("glyphsetSha256") != expected_closure["commonGlyphsetSha256"]:
        raise ValueError("FONT_MANIFEST_COMMON_GLYPHSET_HASH_INVALID")
    for route, row in routes.items():
        route_set = actual_route_codepoints[route]
        delta_set = decoded[row["deltaFont"]]
        if common_set.intersection(delta_set):
            raise ValueError(f"FONT_MANIFEST_ROUTE_CMAP_OVERLAP: {route}")
        if delta_set != route_set - common_set:
            raise ValueError(f"FONT_MANIFEST_ROUTE_DELTA_NOT_EXACT: {route}")
        if not route_set.issubset(common_set | delta_set):
            raise ValueError(f"FONT_MANIFEST_ROUTE_CMAP_COVERAGE_INVALID: {route}")


def _inactive_and_public_ids(source_root: Path) -> tuple[set[str], set[str]]:
    state_path = source_root / "data/page-content.json"
    inactive = set()
    if state_path.is_file():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        pages = state.get("pages", {}) if isinstance(state, dict) else {}
        if isinstance(pages, dict):
            inactive = {
                route for route, row in pages.items()
                if isinstance(row, dict) and row.get("status", "published") in {"unpublished", "deleted"}
            }
    rows = json.loads((source_root / "data/achievements-public.json").read_text(encoding="utf-8"))
    public_ids = {row.get("id") for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str)}
    return inactive, public_ids


def validate_route_source_status(candidates, skipped_routes, inactive_routes) -> None:
    """Reject source-unpublished routes in both generated and pre-existing font inventories."""
    source_routes = set(candidates) | set(skipped_routes)
    inactive = sorted(source_routes.intersection(inactive_routes))
    if inactive:
        raise ValueError("FONT_MANIFEST_ROUTE_NOT_PUBLIC: " + inactive[0])


def _runtime_rss_bytes() -> int:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def _build_once(source_root: Path, artifact_root: Path, paths, compiler: ProcessFontCompiler, source_bytes: bytes) -> dict:
    started_wall = time.perf_counter()
    started_cpu = time.process_time()
    before_hits, before_misses = compiler.hits, compiler.misses
    source_digest = sha256_bytes(source_bytes)
    if source_digest != EXPECTED_TC_SHA256:
        raise ValueError(f"FONT_TC_SOURCE_SHA_MISMATCH: {source_digest}")
    artifact_source_path = artifact_root / TC_REL
    if not artifact_source_path.is_file() or sha256_file(artifact_source_path) != source_digest:
        raise ValueError("FONT_TC_SOURCE_ARTIFACT_MISMATCH")
    if (artifact_root / LICENSE_REL).read_bytes() != (source_root / LICENSE_REL).read_bytes():
        raise ValueError("FONT_OFL_LICENSE_ARTIFACT_MISMATCH")
    tc_cmap, axes = source_glyphs(source_bytes)
    if axes != [{"tag": "wght", "min": 250.0, "default": 250.0, "max": 900.0}]:
        raise ValueError("FONT_TC_SOURCE_WGHT_AXIS_MISMATCH")
    styles_path = artifact_root / "styles.css"
    styles_css = styles_path.read_text(encoding="utf-8")
    jp_allowed, jp_cmap = parse_jp_face(artifact_root, styles_css)
    routes, skipped, excluded = public_html_route_inventory(source_root, artifact_root, paths)
    specs = [extract_page_spec(artifact_root, route, tc_cmap, jp_allowed, jp_cmap) for route in routes]
    if not specs:
        raise ValueError("FONT_NO_PUBLIC_DETAIL_CANDIDATES")
    common_closure = build_common_closure(source_bytes, [spec["codepoints"] for spec in specs])
    common = set(common_closure["commonCodepoints"])
    common_glyphs = tuple(sorted(common))
    if not common_glyphs:
        raise ValueError("FONT_COMMON_CORE_EMPTY")
    if any(not (set(spec["codepoints"]) - common) for spec in specs):
        raise ValueError("FONT_ROUTE_DELTA_EMPTY")

    written_payloads: dict[str, bytes] = {}
    fonts = {}

    def emit(role: str, codepoints: tuple[int, ...]) -> str:
        family, unique = (CORE_FAMILY, CORE_UNIQUE_ID) if role == "common" else (DELTA_FAMILY, DELTA_UNIQUE_ID)
        payload, _event = compiler.compile(source_bytes, codepoints, family, unique)
        digest = sha256_bytes(payload)
        relative = f"{CORE_DIR if role == 'common' else DELTA_DIR}/{digest}.woff2"
        target = artifact_root / relative
        previous = written_payloads.get(relative)
        if previous is None:
            if target.exists():
                raise ValueError(f"FONT_ARTIFACT_ASSET_PREEXISTS: {relative}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            written_payloads[relative] = payload
            info = font_info(payload)
            fonts[relative] = {
                "sha256": digest,
                "codepoints": list(codepoints),
                "glyphsetSha256": glyphset_sha256(list(codepoints)),
                "wght": {"min": 250, "default": 250, "max": 900},
                "family": family,
                "bytes": len(payload),
            }
            if info["codepoints"] != list(codepoints):
                raise ValueError(f"FONT_EMITTED_CMAP_MISMATCH: {relative}")
        elif previous != payload:
            raise ValueError(f"FONT_CONTENT_ADDRESS_COLLISION: {relative}")
        return relative

    common_path = emit("common", common_glyphs)
    route_manifest = {}
    per_page_bytes = []
    for spec in specs:
        delta = tuple(sorted(set(spec["codepoints"]) - common))
        delta_path = emit("delta", delta)
        updated, style_block, preloads = inject_page(spec["html"], spec["route"], common_path, delta_path)
        (artifact_root / spec["route"]).write_bytes(updated)
        style = BeautifulSoup(style_block, "html5lib").find("style", attrs={STYLE_MARKER: "1"})
        style_text = str(style.string or style.decode_contents())
        route_manifest[spec["route"]] = {
            "commonFont": common_path,
            "deltaFont": delta_path,
            "codepoints": list(spec["codepoints"]),
            "glyphsetSha256": spec["glyphsetSha256"],
            "commonGlyphsetSha256": common_closure["commonGlyphsetSha256"],
            "deltaGlyphsetSha256": glyphset_sha256(list(delta)),
            "preloads": preloads,
            "styleSha256": sha256_bytes(style_text.encode("utf-8")),
            "styleBytes": len(style_block.encode("utf-8")),
            "commonBytes": len(written_payloads[common_path]),
            "deltaBytes": len(written_payloads[delta_path]),
            "initialFontBytes": len(written_payloads[common_path]) + len(written_payloads[delta_path]),
            "dataTextCharacters": spec["dataTextCharacters"],
            "jpFallbackCodepoints": spec["jpFallback"],
            "supplementFallbackCodepoints": spec["supplementFallback"],
        }
        per_page_bytes.append({
            "route": spec["route"],
            "commonBytes": len(written_payloads[common_path]),
            "deltaBytes": len(written_payloads[delta_path]),
            "initialFontBytes": len(written_payloads[common_path]) + len(written_payloads[delta_path]),
            "glyphCount": len(spec["codepoints"]),
            "glyphsetSha256": spec["glyphsetSha256"],
        })

    compiler_info = {
        "fontTools": compiler.environment["fontTools"],
        "brotli": compiler.environment["brotli"],
        "quality": QUALITY,
        "compilerSha256": compiler.code_sha256,
        "moduleHashes": compiler.environment["modules"],
        "options": OPTIONS,
    }
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA,
        "sourceFontSha256": source_digest,
        "sourceProvenance": source_provenance(source_bytes, (artifact_root / LICENSE_REL).read_bytes()),
        "supplementSourceProvenance": rare_support.provenance(artifact_root) if rare_support.parse_face(artifact_root, styles_css)[0] else None,
        "routeInventory": {
            "candidateRoutes": routes,
            "skippedExistingFontRoutes": skipped,
            "excludedRoutes": excluded,
        },
        "routeClosure": common_closure,
        "compiler": compiler_info,
        "fonts": {path: fonts[path] for path in sorted(fonts)},
        "routes": {route: route_manifest[route] for route in sorted(route_manifest)},
    }
    manifest_bytes = canonical_json(manifest) + b"\n"
    (artifact_root / MANIFEST_NAME).write_bytes(manifest_bytes)
    inactive, public_ids = _inactive_and_public_ids(source_root)
    validate_manifest(
        artifact_root, manifest, routes, inactive, public_ids,
        route_inventory={
            "candidateRoutes": routes,
            "skippedExistingFontRoutes": skipped,
            "excludedRoutes": excluded,
        },
    )
    elapsed_wall = time.perf_counter() - started_wall
    elapsed_cpu = time.process_time() - started_cpu
    return {
        "manifest": manifest,
        "manifestBytes": manifest_bytes,
        "manifestSha256": sha256_bytes(manifest_bytes),
        "routes": routes,
        "skippedExistingRoutes": skipped,
        "excludedRoutes": excluded,
        "specs": specs,
        "perPageFontBytes": per_page_bytes,
        "uniqueFontAssetCount": len(written_payloads),
        "uniqueFontAssetBytes": sum(len(payload) for payload in written_payloads.values()),
        "commonCodepoints": list(common_glyphs),
        "commonClosure": common_closure,
        "compileStats": {
            "hits": compiler.hits - before_hits,
            "misses": compiler.misses - before_misses,
        },
        "elapsedWallSeconds": elapsed_wall,
        "elapsedCpuSeconds": elapsed_cpu,
    }


def _copy_warm_inputs(source_artifact: Path, warm_artifact: Path, specs: list[dict], skipped_routes=(), excluded_routes=()) -> None:
    for spec in specs:
        target = warm_artifact / spec["route"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(spec["html"])
        for relative in spec["stylesheetPaths"]:
            source = source_artifact / relative
            target = warm_artifact / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
        soup = BeautifulSoup(spec["html"], "html5lib")
        press_runtime = _active_press_runtime(soup)
        if press_runtime is not None:
            source = _press_script_source(source_artifact, press_runtime[0])
            target = warm_artifact / "press.js"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
    for route in (*skipped_routes, *(row["route"] for row in excluded_routes)):
        source = source_artifact / route
        target = warm_artifact / route
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
    styles = source_artifact / "styles.css"
    target_styles = warm_artifact / "styles.css"
    if styles.is_file() and not target_styles.exists():
        target_styles.write_bytes(styles.read_bytes())
    for relative in (TC_REL, LICENSE_REL):
        source = source_artifact / relative
        target = warm_artifact / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
    if styles.is_file():
        jp_css = styles.read_text(encoding="utf-8")
        match = re.search(
            r"@font-face\s*\{[^}]*font-family\s*:\s*[\"']Huiwen Sans JP Support[\"'][^}]*src\s*:\s*url\(\s*([\"']?)([^\"')]+)\1\s*\)",
            jp_css,
            re.I,
        )
        if not match:
            raise ValueError("FONT_WARM_JP_SUPPORT_SOURCE_MISSING")
        source = _safe_artifact_path(source_artifact, match.group(2))
        relative = source.relative_to(source_artifact)
        target = warm_artifact / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())

    if styles.is_file() and rare_support.FAMILY in styles.read_text(encoding="utf-8"):
        for relative in rare_support.PUBLIC_FILES:
            source = source_artifact / relative
            target = warm_artifact / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())


def build(source_root: Path, artifact_root: Path, public_paths, *, compiler: ProcessFontCompiler | None = None) -> dict:
    """Build and read back artifact fonts, then replay in-process against a second root."""
    source_root = Path(source_root).resolve()
    artifact_root = Path(artifact_root).resolve()
    source_bytes = (source_root / TC_REL).read_bytes()
    compiler = compiler or ProcessFontCompiler()
    initial_hits, initial_misses = compiler.hits, compiler.misses
    cold = _build_once(source_root, artifact_root, public_paths, compiler, source_bytes)
    with tempfile.TemporaryDirectory(prefix=".page-font-warm-", dir=artifact_root.parent) as warm_name:
        warm_artifact = Path(warm_name) / "site"
        warm_artifact.mkdir()
        _copy_warm_inputs(
            artifact_root, warm_artifact, cold["specs"],
            cold["skippedExistingRoutes"], cold["excludedRoutes"],
        )
        warm = _build_once(source_root, warm_artifact, public_paths, compiler, source_bytes)
        if warm["manifestBytes"] != cold["manifestBytes"]:
            raise ValueError("FONT_WARM_MANIFEST_NOT_IDENTICAL")
    if (initial_misses == 0 and cold["compileStats"]["misses"] < 1) or warm["compileStats"]["misses"] != 0:
        raise ValueError("FONT_COLD_WARM_CACHE_COUNTS_INVALID")
    return {
        "schemaVersion": 1,
        "status": "complete",
        "samePythonProcess": True,
        "sourceFontSha256": cold["manifest"]["sourceFontSha256"],
        "candidateRoutes": len(cold["routes"]),
        "skippedExistingFontRoutes": cold["skippedExistingRoutes"],
        "excludedLegacyRedirectRoutes": cold["excludedRoutes"],
        "compiler": cold["manifest"]["compiler"],
        "commonGlyphCount": len(cold["commonCodepoints"]),
        "commonGlyphsetSha256": glyphset_sha256(cold["commonCodepoints"]),
        "cold": {
            "wallSeconds": cold["elapsedWallSeconds"],
            "cpuSeconds": cold["elapsedCpuSeconds"],
            "cacheHits": cold["compileStats"]["hits"],
            "cacheMisses": cold["compileStats"]["misses"],
            "fontAssetCount": cold["uniqueFontAssetCount"],
            "fontAssetBytes": cold["uniqueFontAssetBytes"],
            "manifestSha256": cold["manifestSha256"],
        },
        "warm": {
            "wallSeconds": warm["elapsedWallSeconds"],
            "cpuSeconds": warm["elapsedCpuSeconds"],
            "cacheHits": warm["compileStats"]["hits"],
            "cacheMisses": warm["compileStats"]["misses"],
            "fontAssetCount": warm["uniqueFontAssetCount"],
            "fontAssetBytes": warm["uniqueFontAssetBytes"],
            "manifestSha256": warm["manifestSha256"],
            "manifestIdenticalToCold": warm["manifestSha256"] == cold["manifestSha256"],
        },
        "peakRssBytesProcess": _runtime_rss_bytes(),
        "cacheEntries": len(compiler.cache),
        "cachePayloadBytes": sum(len(value) for value in compiler.cache.values()),
        "sourceBytesRetainedInCacheEntries": 0,
        "perPageFontBytes": cold["perPageFontBytes"],
        "manifestPath": MANIFEST_NAME,
        "manifestSha256": cold["manifestSha256"],
        "manifestExample": {
            "schemaVersion": MANIFEST_SCHEMA,
            "sourceFontSha256": cold["manifest"]["sourceFontSha256"],
            "compiler": cold["manifest"]["compiler"],
            "firstRoute": next(iter(cold["manifest"]["routes"].items()), None),
            "firstFont": next(iter(cold["manifest"]["fonts"].items()), None),
        },
        "preflightCompilerCacheCountersBeforeBuild": {"hits": initial_hits, "misses": initial_misses},
    }


def compare_common_delta_samples(source_root: Path, artifact_root: Path, public_paths, sample_routes: tuple[str, ...]) -> dict:
    """Compare q9 common+delta bytes against q9 whole-page bytes for named routes."""
    source_bytes = (source_root / TC_REL).read_bytes()
    compiler = ProcessFontCompiler()
    tc_cmap, axes = source_glyphs(source_bytes)
    css = (artifact_root / "styles.css").read_text(encoding="utf-8")
    jp_allowed, jp_cmap = parse_jp_face(artifact_root, css)
    routes, _skipped = candidate_routes(source_root, artifact_root, public_paths)
    specs = [extract_page_spec(artifact_root, route, tc_cmap, jp_allowed, jp_cmap) for route in routes]
    by_route = {spec["route"]: spec for spec in specs}
    if not set(sample_routes).issubset(by_route):
        raise ValueError(f"FONT_SAMPLE_ROUTE_NOT_PUBLIC: {sorted(set(sample_routes) - set(by_route))}")
    closure = build_common_closure(source_bytes, [spec["codepoints"] for spec in specs])
    common = set(closure["commonCodepoints"])
    common_glyphs = tuple(sorted(common))
    common_payload, _ = compiler.compile(source_bytes, common_glyphs, CORE_FAMILY, CORE_UNIQUE_ID)
    results = []
    for route in sample_routes:
        spec = by_route[route]
        delta = tuple(sorted(set(spec["codepoints"]) - common))
        delta_payload, _ = compiler.compile(source_bytes, delta, DELTA_FAMILY, DELTA_UNIQUE_ID)
        whole_payload, _ = compiler.compile(source_bytes, spec["codepoints"], WHOLE_PAGE_FAMILY, WHOLE_PAGE_UNIQUE_ID)
        common_bytes = len(common_payload)
        delta_bytes = len(delta_payload)
        whole_bytes = len(whole_payload)
        results.append({
            "route": route,
            "glyphCount": len(spec["codepoints"]),
            "commonBytes": common_bytes,
            "deltaBytes": delta_bytes,
            "commonDeltaInitialBytes": common_bytes + delta_bytes,
            "wholeQ9Bytes": whole_bytes,
            "deltaVsWholePercent": round(((common_bytes + delta_bytes) / whole_bytes - 1) * 100, 4),
            "underTenPercentThreshold": common_bytes + delta_bytes <= whole_bytes * 1.10,
        })
    return {
        "sourceFontSha256": sha256_bytes(source_bytes),
        "q9": QUALITY,
        "candidateRouteCount": len(specs),
        "commonGlyphCount": len(common_glyphs),
        "commonGlyphsetSha256": glyphset_sha256(common_glyphs),
        "routeIntersectionGlyphCount": len(closure["routeIntersectionCodepoints"]),
        "commonClosureExtraGlyphCount": len(common - set(closure["routeIntersectionCodepoints"])),
        "commonClosure": closure,
        "samples": results,
        "allUnderTenPercentThreshold": all(row["underTenPercentThreshold"] for row in results),
    }


if __name__ == "__main__":
    raise SystemExit("Import build_artifact_page_fonts from the reviewed public builder.")
