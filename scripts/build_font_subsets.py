#!/usr/bin/env python3
"""Build route-specific Source Han TC faces and a checked CJK fallback."""
from __future__ import annotations

from python_guard import require_supported_python
require_supported_python()

from hashlib import sha256
from io import BytesIO
from pathlib import Path
import re
import sys
import unicodedata

from bs4 import BeautifulSoup
from fontTools.ttLib import TTFont
from fontTools import subset

ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = ROOT / "assets/fonts/huiwen-site-sans"
GENERATED_DIR = FONT_DIR / "generated"
TC_SOURCE = FONT_DIR / "huiwen-site-sans-tc-20261007.woff2"
JP_SOURCE = FONT_DIR / "source-han-sans-jp-vf-2.005R.woff2"
STYLE_START = "/* HUIWEN_FONT_SUBSETS:start */"
STYLE_END = "/* HUIWEN_FONT_SUBSETS:end */"
PRELOAD_START = "<!-- HUIWEN_FONT_PRELOAD:start -->"
PRELOAD_END = "<!-- HUIWEN_FONT_PRELOAD:end -->"
UPGRADE_START = "<!-- HUIWEN_FONT_UPGRADE:start -->"
UPGRADE_END = "<!-- HUIWEN_FONT_UPGRADE:end -->"

ROUTES = {
    "index.html": (
        "index",
        ("main > .hero", "main > .services", "main > .mobile-actions"),
    ),
    "about.html": (
        "about",
        ("main > .page-head", "main > .about-grid"),
    ),
    "achievements.html": (
        "achievements",
        ("main > .page-head", "main > .map-controls", "main > .civic-view-controls", "main .results-heading"),
    ),
    "vision.html": (
        "vision",
        ("main > .page-head", "main .platform-row:first-of-type details summary"),
    ),
    "news.html": (
        "news",
        ("main > .page-head", "main .news-report-section article:first-of-type"),
    ),
    "news-20260915-special-education-nurse.html": (
        "news-detail",
        ("main > .page-head", "main > .news-article-wrap p:first-of-type"),
    ),
    "political-donation.html": (
        "political-donation",
        ("main > .donation-account-section", "main > .donation-top-links", "main > .donation-jump"),
    ),
    "election.html": (
        "election",
        ("main > .campaign-hero", "main > .campaign-countdown-wrap"),
    ),
}
TEXT_SUFFIXES = {
    ".html", ".css", ".js", ".json", ".jsonc", ".geojson", ".txt",
    ".svg", ".xml", ".webmanifest",
}
DYNAMIC_CORE_TEXT = "搜尋⌕⌘ K天"
CJK_RANGES = (
    (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF),
    (0x20000, 0x2FA1F), (0x30000, 0x323AF),
)


def is_cjk(codepoint: int) -> bool:
    return any(start <= codepoint <= end for start, end in CJK_RANGES)


def required_font_character(codepoint: int) -> bool:
    category = unicodedata.category(chr(codepoint))
    return is_cjk(codepoint) or category[0] in {"L", "M", "N"}


def source_text_paths(root: Path):
    paths = set()
    for pattern in ("*.*",):
        for path in root.glob(pattern):
            if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES:
                paths.add(path)
    for directory in ("data", "templates", "assets"):
        base = root / directory
        if base.exists():
            paths.update(
                path for path in base.rglob("*")
                if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES
            )
    return sorted(paths)


def collect_corpus(root: Path) -> tuple[str, set[int]]:
    pieces = []
    for path in source_text_paths(root):
        try:
            pieces.append(path.read_text(encoding="utf-8"))
        except UnicodeDecodeError as error:
            raise ValueError(f"FONT_CORPUS_ENCODING: {path.relative_to(root)}") from error
    text = "\n".join(pieces)
    return text, {ord(char) for char in text}


def cmap(path: Path) -> dict[int, str]:
    if not path.is_file():
        raise ValueError(f"FONT_SOURCE_MISSING: {path.relative_to(ROOT)}")
    font = TTFont(path)
    return font.getBestCmap() or {}


def validate_corpus(codepoints: set[int], tc_cmap: dict, jp_cmap: dict) -> list[int]:
    unresolved = sorted(
        cp for cp in codepoints
        if required_font_character(cp) and cp not in tc_cmap and cp not in jp_cmap
    )
    if unresolved:
        sample = " ".join(f"U+{cp:04X} {chr(cp)}" for cp in unresolved[:20])
        raise ValueError(f"FONT_MISSING_GLYPHS: {len(unresolved)} unsupported letters/CJK: {sample}")
    return sorted(cp for cp in codepoints if required_font_character(cp) and cp not in tc_cmap and cp in jp_cmap)


def rename_family(font: TTFont, family: str, unique_id: str) -> None:
    names = font["name"]
    family_ids = (1, 4, 16, 21)
    for name_id in family_ids:
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


def subset_bytes(source: Path, codepoints: set[int], family: str, unique_id: str) -> bytes:
    source_cmap = cmap(source)
    supported = sorted(codepoints.intersection(source_cmap))
    if not supported:
        raise ValueError(f"FONT_EMPTY_SUBSET: {family}")
    font = TTFont(source)
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=supported)
    created = font["head"].created
    modified = font["head"].modified
    subsetter.subset(font)
    rename_family(font, family, unique_id)
    font["head"].created = created
    font["head"].modified = modified
    font.recalcTimestamp = False
    font.flavor = "woff2"
    output = BytesIO()
    font.save(output)
    return output.getvalue()


def write_generated(name: str, payload: bytes) -> tuple[str, int]:
    digest = sha256(payload).hexdigest()[:12]
    filename = f"{name}-{digest}.woff2"
    (GENERATED_DIR / filename).write_bytes(payload)
    return filename, len(payload)


def page_text(root: Path, route: str, selectors: tuple[str, ...] | None = None) -> str:
    path = root / route
    if not path.is_file():
        raise ValueError(f"FONT_ROUTE_MISSING: {route}")
    source = path.read_text(encoding="utf-8")
    if selectors is None:
        return source
    soup = BeautifulSoup(source, "html.parser")
    pieces = []
    header = soup.select_one(".topline")
    if header:
        pieces.append(str(header))
    else:
        raise ValueError(f"FONT_CORE_HEADER_MISSING: {route}")
    header = soup.select_one(".site-header")
    if header:
        pieces.append(str(header))
    else:
        raise ValueError(f"FONT_CORE_NAV_MISSING: {route}")
    skip_link = soup.select_one("a.skip-link")
    if skip_link:
        pieces.append(str(skip_link))
    for selector in selectors:
        matches = soup.select(selector)
        if not matches:
            raise ValueError(f"FONT_CORE_SELECTOR_MISSING: {route}: {selector}")
        pieces.extend(str(match) for match in matches)
    pieces.append(DYNAMIC_CORE_TEXT)
    return "\n".join(pieces)


def face(
    family: str,
    filename: str,
    generated: bool = True,
    display: str = "optional",
    unicode_range: str | None = None,
) -> str:
    path = f"generated/{filename}" if generated else filename
    uri = f"/assets/fonts/huiwen-site-sans/{path}"
    coverage = f";unicode-range:{unicode_range}" if unicode_range else ""
    return (
        f'@font-face{{font-family:"{family}";src:url("{uri}") format("woff2");'
        f"font-style:normal;font-weight:250 900;font-display:{display}{coverage}" + "}"
    )


def build_css(root: Path, routes: dict, jp_filename: str | None, jp_fallback: list[int]) -> None:
    lines = [
        STYLE_START,
        face("Huiwen Sans TC", "huiwen-site-sans-tc-20261007.woff2", generated=False, display="swap"),
    ]
    if jp_filename:
        support_coverage = ",".join(f"U+{codepoint:04X}" for codepoint in jp_fallback)
        lines.append(
            face(
                "Huiwen Sans JP Support",
                jp_filename,
                display="swap",
                unicode_range=support_coverage,
            )
        )
    for slug, values in routes.items():
        lines.append(face(f"Huiwen Sans TC {slug} Core", values["core_file"]))
        lines.append(face(f"Huiwen Sans TC {slug} Full", values["full_file"]))
        lines.append(
            f':root[data-huiwen-font-page="{slug}"]'
            f'{{--huiwen-font-family:"Huiwen Sans TC {slug} Core","Huiwen Sans JP Support",sans-serif}}'
        )
        lines.append(
            f':root[data-huiwen-font-page="{slug}"][data-huiwen-font-full="1"]'
            f'{{--huiwen-font-family:"Huiwen Sans TC {slug} Full","Huiwen Sans JP Support",sans-serif}}'
        )
    lines.append(
        ".global-search-dialog,.map-insight-panel,.map-popup,.map-popup-case,"
        ".leaflet-popup-content{font-family:var(--huiwen-global-font-family)}"
    )
    lines.append(STYLE_END)
    block = "\n".join(lines)
    path = root / "styles.css"
    css = path.read_text(encoding="utf-8")
    if STYLE_START in css:
        css = re.sub(
            re.escape(STYLE_START) + r".*?" + re.escape(STYLE_END),
            lambda _: block,
            css,
            count=1,
            flags=re.S,
        )
    else:
        old_lines = css.splitlines(keepends=True)
        if len(old_lines) < 2 or not old_lines[0].startswith("@font-face") or not old_lines[1].startswith("@font-face"):
            raise ValueError("FONT_CSS_SOURCE_FACES_NOT_FOUND")
        css = "".join(old_lines[2:])
        css = block + "\n" + css
    if "--huiwen-global-font-family:" not in css:
        old = '--huiwen-font-family:"Huiwen Sans TC",sans-serif;'
        new = (
            '--huiwen-font-family:"Huiwen Sans TC","Huiwen Sans JP Support",sans-serif;'
            '--huiwen-global-font-family:"Huiwen Sans TC","Huiwen Sans JP Support",sans-serif;'
        )
        if old not in css:
            raise ValueError("FONT_CSS_ROOT_STACK_NOT_FOUND")
        css = css.replace(old, new, 1)
    css, count = re.subn(r":root:lang\(ja\)\{[^}]*\}", "", css, count=1)
    if count > 1:
        raise ValueError("FONT_CSS_JA_RULE_DUPLICATED")
    path.write_text(css, encoding="utf-8")


def write_page_metadata(root: Path, route: str, slug: str, full_family: str, core_filename: str) -> None:
    path = root / route
    html = path.read_text(encoding="utf-8")
    match = re.search(r"<html\b[^>]*>", html, flags=re.I)
    if not match:
        raise ValueError(f"FONT_HTML_ROOT_MISSING: {route}")
    opening = match.group(0)
    attributes = {
        "data-huiwen-font-page": slug,
        "data-huiwen-font-full-family": full_family,
    }
    for key, value in attributes.items():
        opening = re.sub(r"\s" + re.escape(key) + r'="[^"]*"', "", opening, flags=re.I)
        opening = opening[:-1] + f' {key}="{value}">'
    html = html[:match.start()] + opening + html[match.end():]

    preload = (
        f'{PRELOAD_START}<link rel="preload" '
        f'href="/assets/fonts/huiwen-site-sans/generated/{core_filename}" '
        'as="font" type="font/woff2" crossorigin="anonymous">'
        f'{PRELOAD_END}'
    )
    if PRELOAD_START in html:
        html = re.sub(
            re.escape(PRELOAD_START) + r".*?" + re.escape(PRELOAD_END),
            lambda _: preload,
            html,
            count=1,
            flags=re.S,
        )
    else:
        first_stylesheet = re.search(r"<link\b(?=[^>]*\brel=[\"']stylesheet[\"'])[^>]*>", html, flags=re.I)
        if not first_stylesheet:
            raise ValueError(f"FONT_STYLESHEET_NOT_FOUND: {route}")
        html = html[:first_stylesheet.start()] + preload + "\n" + html[first_stylesheet.start():]

    upgrade_script = (
        f"{UPGRADE_START}<script data-huiwen-font-upgrade>"
        "(function(){"
        "var root=document.documentElement,requested=false;"
        "async function upgrade(){"
        "if(requested||!root.dataset.huiwenFontFullFamily)return;"
        "requested=true;"
        "try{"
        "var loaded=await document.fonts.load('400 16px \"'+root.dataset.huiwenFontFullFamily+'\"',document.body.innerText||' ');"
        "if(loaded.length)root.dataset.huiwenFontFull='1';else requested=false;"
        "}catch(error){requested=false;}"
        "}"
        "window.addEventListener('scroll',upgrade,{passive:true});"
        "window.addEventListener('pointerdown',upgrade,{passive:true});"
        "window.addEventListener('focusin',upgrade);"
        "})();</script>"
        f"{UPGRADE_END}"
    )
    if UPGRADE_START in html:
        html = re.sub(
            re.escape(UPGRADE_START) + r".*?" + re.escape(UPGRADE_END),
            lambda _: upgrade_script,
            html,
            count=1,
            flags=re.S,
        )
    else:
        match = re.search(r"</body\s*>", html, flags=re.I)
        if not match:
            raise ValueError(f"FONT_BODY_CLOSE_NOT_FOUND: {route}")
        html = html[:match.start()] + upgrade_script + "\n" + html[match.start():]
    path.write_text(html, encoding="utf-8")


def build(root: Path = ROOT) -> None:
    tc_cmap = cmap(root / TC_SOURCE.relative_to(ROOT))
    jp_cmap = cmap(root / JP_SOURCE.relative_to(ROOT))
    corpus, corpus_codepoints = collect_corpus(root)
    jp_fallback = validate_corpus(corpus_codepoints, tc_cmap, jp_cmap)

    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    for old in GENERATED_DIR.glob("*.woff2"):
        old.unlink()

    jp_filename = None
    if jp_fallback:
        payload = subset_bytes(
            JP_SOURCE,
            set(jp_fallback),
            "Huiwen Sans JP Support",
            "Huiwen Sans JP Support 2.005R",
        )
        jp_filename, jp_bytes = write_generated("huiwen-cjk-support", payload)
        print(f"JP CJK support: {len(jp_fallback)} glyphs, {jp_bytes} bytes")

    page_routes = {}
    for route, (slug, selectors) in ROUTES.items():
        core = page_text(root, route, selectors)
        full = page_text(root, route)
        core_codepoints = {ord(char) for char in core}
        full_codepoints = {ord(char) for char in full}
        core_payload = subset_bytes(
            root / TC_SOURCE.relative_to(ROOT),
            core_codepoints,
            f"Huiwen Sans TC {slug} Core",
            f"Huiwen Sans TC {slug} Core subset",
        )
        full_payload = subset_bytes(
            root / TC_SOURCE.relative_to(ROOT),
            full_codepoints,
            f"Huiwen Sans TC {slug} Full",
            f"Huiwen Sans TC {slug} Full subset",
        )
        core_file, core_bytes = write_generated(f"huiwen-{slug}-core", core_payload)
        full_file, full_bytes = write_generated(f"huiwen-{slug}-full", full_payload)
        page_routes[slug] = {
            "core_file": core_file,
            "full_file": full_file,
            "core_bytes": core_bytes,
            "full_bytes": full_bytes,
            "core_glyphs": len(core_codepoints.intersection(tc_cmap)),
            "full_glyphs": len(full_codepoints.intersection(tc_cmap)),
        }
        write_page_metadata(
            root,
            route,
            slug,
            f"Huiwen Sans TC {slug} Full",
            core_file,
        )

    build_css(root, page_routes, jp_filename, jp_fallback)
    sw_path = root / "sw.js"
    sw_source = sw_path.read_text(encoding="utf-8")
    sw_source = sw_source.replace(
        "const CACHE='huiwen-digital-v14-20261007-source-han-fonts';",
        "const CACHE='huiwen-digital-v15-20261008-route-font-subsets';",
    )
    old_shell_font = re.search(
        r"(['\"])(?:\./assets/fonts/huiwen-site-sans/huiwen-site-sans-tc-20261007\.woff2|"
        r"\./assets/fonts/huiwen-site-sans/generated/[^'\"]+\.woff2)\1",
        sw_source,
    )
    if not old_shell_font:
        raise ValueError("FONT_SERVICE_WORKER_SHELL_FONT_SOURCE_NOT_FOUND")
    shell_entry = (
        old_shell_font.group(1)
        + f"./assets/fonts/huiwen-site-sans/generated/{page_routes['index']['core_file']}"
        + old_shell_font.group(1)
    )
    sw_source = sw_source[:old_shell_font.start()] + shell_entry + sw_source[old_shell_font.end():]
    sw_path.write_text(sw_source, encoding="utf-8")
    digital_path = root / "digital.js"
    digital_source = digital_path.read_text(encoding="utf-8")
    digital_source = digital_source.replace(
        "const SERVICE_WORKER_VERSION = '20260922-service-v13';",
        "const SERVICE_WORKER_VERSION = '20261008-font-route-v14';",
    )
    digital_path.write_text(digital_source, encoding="utf-8")
    if "SERVICE_WORKER_VERSION = '20261008-font-route-v14'" not in digital_source:
        raise ValueError("FONT_SERVICE_WORKER_REGISTRATION_VERSION_NOT_UPDATED")
    if "huiwen-digital-v15-20261008-route-font-subsets" not in (root / "sw.js").read_text(encoding="utf-8"):
        raise ValueError("FONT_SERVICE_WORKER_CACHE_VERSION_NOT_UPDATED")
    if f"generated/{page_routes['index']['core_file']}" not in (root / "sw.js").read_text(encoding="utf-8"):
        raise ValueError("FONT_SERVICE_WORKER_SHELL_FONT_NOT_UPDATED")

    print(
        "Built Source Han TC route fonts: "
        + ", ".join(
            f"{slug} core={items['core_bytes']}B/{items['core_glyphs']} full={items['full_bytes']}B/{items['full_glyphs']}"
            for slug, items in page_routes.items()
        )
    )
    print(f"Validated site glyph corpus: {len(corpus_codepoints)} codepoints, JP fallback {len(jp_fallback)}")


if __name__ == "__main__":
    try:
        build()
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
