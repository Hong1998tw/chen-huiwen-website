#!/usr/bin/env python3
"""Build artifact-only q9 WOFF2 common/delta faces for public detail pages.

The only supported producer runtime is fontTools 4.66.1 plus Brotli 1.2.0.
fontTools has no public WOFF2 quality argument, so this module uses a local,
version-guarded writer and TTFont adapter. It never patches package globals.
"""
from __future__ import annotations

from python_guard import require_supported_python
require_supported_python()

from collections import OrderedDict
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
MANIFEST_SCHEMA = 1
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
STYLE_MARKER = "data-huiwen-font-page-artifact"
PRELOAD_MARKER = "data-huiwen-font-page-preload"
OPTIONS = {"flavor": "woff2", "layout_features": ["*"], "retain_gids": False}
REQUIRED_ATTRS = {"alt", "placeholder", "title", "value"}
CJK_RANGES = (
    (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF),
    (0x20000, 0x2FA1F), (0x30000, 0x323AF),
)
SCRIPT_DYNAMIC_TEXT = (
    "搜尋⌕⌘ K天 Ctrl K 搜尋陳慧文官網 關閉搜尋 全站搜尋 "
    "搜尋政績、新聞、政見、里別…… 搜尋資料載入中… "
    "開啟選單 開啟主要選單 關閉主要選單 關閉選單 2026選舉 律師時間表 "
    "分享這一頁 網址已複製 複製分享網址 請選取並複製下方網址。 分享網址 關閉"
)
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


def font_info(payload: bytes, *, include_tables: bool = False) -> dict:
    if not isinstance(payload, bytes) or payload[:4] != b"wOF2":
        raise ValueError("FONT_PAYLOAD_NOT_WOFF2")
    try:
        font = TTFont(BytesIO(payload), recalcBBoxes=False, recalcTimestamp=False)
        result = {
            "codepoints": sorted((font.getBestCmap() or {}).keys()),
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


def dynamic_ui_text(route: str, soup) -> str:
    script_names = set()
    for tag in soup.find_all("script", src=True):
        parsed = urlsplit(str(tag["src"]))
        if not parsed.scheme and not parsed.netloc:
            script_names.add(PurePosixPath(unquote(parsed.path)).name)
    pieces = [SCRIPT_DYNAMIC_TEXT]
    if "digital.js" in script_names and PurePosixPath(route).name.startswith("achievement-"):
        pieces.append(CASE_DYNAMIC_TEXT)
    if "news.js" in script_names:
        pieces.extend((NEWS_DYNAMIC_TEXT, "陳慧文於高雄市議會市政總質詢發言 2024年11月29日，陳慧文於高雄市議會市政總質詢發言。圖／陳慧文議員服務處提供。"))
    if "civic.js" in script_names:
        pieces.append("搜尋政績、新聞、歷屆政見、活動與服務資訊。 顯示本月全部日期 只看今日起的日期 僅顯示今日起的日期")
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
    raw = path.read_bytes()
    soup = BeautifulSoup(raw, "html5lib")
    if soup.html is None or soup.head is None or soup.body is None:
        raise ValueError(f"FONT_ROUTE_MALFORMED_HTML: {route}")
    if soup.html.get("data-huiwen-font-page"):
        raise ValueError(f"FONT_EXISTING_ROUTE_MUST_BE_SKIPPED: {route}")
    if soup.html.get("data-huiwen-font-artifact-route") or STYLE_MARKER in raw.decode("utf-8", "replace"):
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
    visible_text = "\n".join(text_parts + [css_text, dynamic_ui_text(route, soup)])
    characters = {ord(char) for char in visible_text}
    tc_glyphs = tuple(sorted(characters.intersection(tc_cmap)))
    if not tc_glyphs:
        raise ValueError(f"FONT_ROUTE_HAS_NO_TC_GLYPHS: {route}")
    missing = sorted(cp for cp in characters if is_required_character(chr(cp)) and cp not in tc_cmap and cp not in jp_cmap)
    if missing:
        sample = " ".join(f"U+{cp:04X} {chr(cp)}" for cp in missing[:20])
        raise ValueError(f"FONT_ROUTE_HAS_UNCOVERED_REQUIRED_CHARACTERS: {route}: {sample}")
    jp_missing = sorted(cp for cp in characters if is_required_character(chr(cp)) and cp not in tc_cmap and cp in jp_cmap)
    outside_face = sorted(set(jp_missing) - jp_allowed)
    if outside_face:
        sample = " ".join(f"U+{cp:04X} {chr(cp)}" for cp in outside_face[:20])
        raise ValueError(f"FONT_ROUTE_NEEDS_JP_GLYPH_OUTSIDE_EXACT_FACE: {route}: {sample}")
    return {
        "route": route,
        "html": raw,
        "codepoints": tc_glyphs,
        "glyphsetSha256": glyphset_sha256(list(tc_glyphs)),
        "jpFallback": jp_missing,
        "stylesheetPaths": stylesheet_paths,
        "dataTextCharacters": len(visible_text),
    }


def candidate_routes(source_root: Path, artifact_root: Path, public_paths) -> tuple[list[str], list[str]]:
    paths = sorted(set(public_paths))
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
    nested_candidates = [
        path for path in paths
        if ROUTE_RE.fullmatch(PurePosixPath(path).name) and path != PurePosixPath(path).name
    ]
    if nested_candidates:
        raise ValueError("FONT_NESTED_DETAIL_ROUTE_NOT_SUPPORTED: " + ", ".join(nested_candidates[:20]))
    routes = [path for path in paths if path == PurePosixPath(path).name and ROUTE_RE.fullmatch(path)]
    stale = [path for path in routes if path in inactive]
    stale.extend(
        path for path in routes
        if PurePosixPath(path).name.startswith("achievement-")
        and PurePosixPath(path).stem.removeprefix("achievement-") not in public_ids
    )
    if stale:
        raise ValueError("FONT_UNPUBLISHED_OR_UNPROJECTED_ROUTE_IN_PUBLIC_PATHS: " + ", ".join(sorted(set(stale))[:20]))
    eligible = []
    skipped = []
    for route in routes:
        output = artifact_root / route
        if not output.is_file() or output.is_symlink():
            raise ValueError(f"FONT_PUBLIC_ROUTE_MISSING_FROM_ARTIFACT: {route}")
        soup = BeautifulSoup(output.read_bytes(), "html5lib")
        if soup.html and soup.html.get("data-huiwen-font-page"):
            skipped.append(route)
        else:
            eligible.append(route)
    return eligible, skipped


def source_glyphs(source_bytes: bytes) -> tuple[dict[int, str], list[dict]]:
    font = TTFont(BytesIO(source_bytes), recalcBBoxes=False, recalcTimestamp=False)
    cmap = font.getBestCmap() or {}
    axes = [
        {"tag": axis.axisTag, "min": axis.minValue, "default": axis.defaultValue, "max": axis.maxValue}
        for axis in font["fvar"].axes
    ] if "fvar" in font else []
    font.close()
    return cmap, axes


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
    style = (
        f'@font-face{{font-family:"{CORE_FAMILY}";src:url("/{common_path}") format("woff2");font-style:normal;font-weight:250 900;font-display:swap}}'
        f'@font-face{{font-family:"{DELTA_FAMILY}";src:url("/{delta_path}") format("woff2");font-style:normal;font-weight:250 900;font-display:swap}}'
        f':root[data-huiwen-font-artifact-route="{route}"]{{--huiwen-font-family:"{DELTA_FAMILY}","{CORE_FAMILY}","Huiwen Sans TC","Huiwen Sans JP Support",sans-serif}}'
        ':root[data-huiwen-font-artifact-preview="1"]{--huiwen-font-family:"Huiwen Sans TC","Huiwen Sans JP Support",sans-serif}'
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
    if not re.fullmatch(r"(?:achievement|news)-[a-z0-9-]+\.html", route):
        raise ValueError("FONT_ROUTE_ATTRIBUTE_INVALID")
    opening = re.sub(r"\sdata-huiwen-font-artifact-route=(?:\"[^\"]*\"|'[^']*'|[^\s>]+)", "", opening, flags=re.I)
    return opening[:-1] + f' data-huiwen-font-artifact-route="{route}">'


def _wght_contract(info: dict) -> bool:
    return info.get("wght") == [{"tag": "wght", "min": 250.0, "default": 250.0, "max": 900.0}]


def validate_manifest(artifact_root: Path, manifest: dict, candidates: list[str], inactive_routes=None, public_ids=None) -> None:
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
    inactive_routes = set(inactive_routes or ())
    public_ids = None if public_ids is None else set(public_ids)
    for route in routes:
        if route != PurePosixPath(route).name or not ROUTE_RE.fullmatch(route) or route in inactive_routes:
            raise ValueError(f"FONT_MANIFEST_ROUTE_NOT_PUBLIC: {route}")
        if route.startswith("achievement-") and public_ids is not None and PurePosixPath(route).stem.removeprefix("achievement-") not in public_ids:
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
        decoded[path] = set(codepoints)
    common_paths = [path for path in fonts if _woff_path(path, "common")]
    if len(common_paths) != 1:
        raise ValueError("FONT_MANIFEST_COMMON_ASSET_COUNT_INVALID")
    common_path = common_paths[0]
    expected_common = None
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
        if common_set.intersection(delta_set) or common_set.union(delta_set) != set(route_codepoints):
            raise ValueError(f"FONT_MANIFEST_ROUTE_CMAP_CLOSURE_INVALID: {route}")
        if expected_common is None:
            expected_common = set(route_codepoints)
        else:
            expected_common.intersection_update(route_codepoints)
        preloads = row.get("preloads")
        if preloads != [common, delta] or len(preloads) > 2:
            raise ValueError(f"FONT_MANIFEST_PRELOAD_CLOSURE_INVALID: {route}")
        page_path = artifact_root / route
        soup = BeautifulSoup(page_path.read_bytes(), "html5lib")
        if soup.html is None or soup.html.get("data-huiwen-font-artifact-route") != route:
            raise ValueError(f"FONT_MANIFEST_HTML_ROUTE_MARKER_INVALID: {route}")
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
    if expected_common != decoded[common_path]:
        raise ValueError("FONT_MANIFEST_COMMON_IS_NOT_ROUTE_INTERSECTION")


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
    routes, skipped = candidate_routes(source_root, artifact_root, paths)
    specs = [extract_page_spec(artifact_root, route, tc_cmap, jp_allowed, jp_cmap) for route in routes]
    if not specs:
        raise ValueError("FONT_NO_PUBLIC_DETAIL_CANDIDATES")
    common = set(specs[0]["codepoints"])
    for spec in specs[1:]:
        common.intersection_update(spec["codepoints"])
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
            "preloads": preloads,
            "styleSha256": sha256_bytes(style_text.encode("utf-8")),
            "styleBytes": len(style_block.encode("utf-8")),
            "commonBytes": len(written_payloads[common_path]),
            "deltaBytes": len(written_payloads[delta_path]),
            "initialFontBytes": len(written_payloads[common_path]) + len(written_payloads[delta_path]),
            "dataTextCharacters": spec["dataTextCharacters"],
            "jpFallbackCodepoints": spec["jpFallback"],
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
        "compiler": compiler_info,
        "fonts": {path: fonts[path] for path in sorted(fonts)},
        "routes": {route: route_manifest[route] for route in sorted(route_manifest)},
    }
    manifest_bytes = canonical_json(manifest) + b"\n"
    (artifact_root / MANIFEST_NAME).write_bytes(manifest_bytes)
    inactive, public_ids = _inactive_and_public_ids(source_root)
    validate_manifest(artifact_root, manifest, routes, inactive, public_ids)
    elapsed_wall = time.perf_counter() - started_wall
    elapsed_cpu = time.process_time() - started_cpu
    return {
        "manifest": manifest,
        "manifestBytes": manifest_bytes,
        "manifestSha256": sha256_bytes(manifest_bytes),
        "routes": routes,
        "skippedExistingRoutes": skipped,
        "specs": specs,
        "perPageFontBytes": per_page_bytes,
        "uniqueFontAssetCount": len(written_payloads),
        "uniqueFontAssetBytes": sum(len(payload) for payload in written_payloads.values()),
        "commonCodepoints": list(common_glyphs),
        "compileStats": {
            "hits": compiler.hits - before_hits,
            "misses": compiler.misses - before_misses,
        },
        "elapsedWallSeconds": elapsed_wall,
        "elapsedCpuSeconds": elapsed_cpu,
    }


def _copy_warm_inputs(source_artifact: Path, warm_artifact: Path, specs: list[dict], skipped_routes=()) -> None:
    for spec in specs:
        target = warm_artifact / spec["route"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(spec["html"])
        for relative in spec["stylesheetPaths"]:
            source = source_artifact / relative
            target = warm_artifact / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
    for route in skipped_routes:
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
        _copy_warm_inputs(artifact_root, warm_artifact, cold["specs"], cold["skippedExistingRoutes"])
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
    common = set(specs[0]["codepoints"])
    for spec in specs[1:]:
        common.intersection_update(spec["codepoints"])
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
        "samples": results,
        "allUnderTenPercentThreshold": all(row["underTenPercentThreshold"] for row in results),
    }


if __name__ == "__main__":
    raise SystemExit("Import build_artifact_page_fonts from the reviewed public builder.")
