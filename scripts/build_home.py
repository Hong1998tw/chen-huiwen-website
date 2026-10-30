#!/usr/bin/env python3
"""Build the homepage from reviewed public service, latest-information and record data."""
from datetime import datetime
from html import escape
from hashlib import sha256
import json
import math
from pathlib import Path
import re
from zoneinfo import ZoneInfo

from build_guides import load_office
from build_service import validate_schedule
from build_shared import link_arrow
import latest_info

ROOT = Path(__file__).resolve().parents[1]
MAP_ASSET = "assets/fengshan-home-map.svg"
MAP_LINK = "achievements.html?case=wende-school-center#achievement-map"
NON_LOCAL_SCOPES = {"全市政策", "跨區服務"}
LINE_URL = "https://line.me/R/ti/p/@yve2766q"
FACEBOOK_URL = "https://www.facebook.com/hwcfs/"
EVENT_VARIANT_MANIFEST = Path("scripts/home-image-variants.json")
SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")
TAIPEI = ZoneInfo("Asia/Taipei")
# Each filter renders at most this many items; the full lists stay on their pages.
LATEST_PER_FILTER = 12
LATEST_INITIAL = 3
LATEST_FILTERS = (("all", "全部"), ("news", "新聞"), ("daily", "日常"), ("activity", "活動"))
LATEST_LIST_LINKS = (
    ("news.html", "媒體報導"), ("press.html", "服務處新聞稿"),
    ("activities.html", "公開行程與活動"), (FACEBOOK_URL, "官方 Facebook"),
)
WEEKDAYS = "一二三四五六日"
EXTERNAL = ' target="_blank" rel="noopener noreferrer"'


def e(value):
    return escape(str(value), quote=True)


def is_external(href):
    return str(href).startswith(("https://", "http://"))


def link_attrs(href):
    return EXTERNAL if is_external(href) else ""


def render_candidate_number(platforms):
    """Project the 2026 ballot number without changing recorded office identity."""
    rows = [row for row in platforms["elections"] if row.get("year") == 2026]
    if len(rows) != 1:
        raise ValueError("Exactly one 2026 platform record required")
    number = rows[0].get("candidateNumber")
    if isinstance(number, bool) or not isinstance(number, int) or number < 1:
        raise ValueError("A confirmed 2026 candidate number is required")
    return f'2026 鳳山區・陳慧文{e(number)}號'


def public_records(root=ROOT):
    rows = json.loads((root / "data/achievements-public.json").read_text())
    if not isinstance(rows, list):
        raise ValueError("Public achievement projection must be an array")
    return rows


CASE_OPTIONS = "data/home-case-options.json"
# Only the fields the CMS homepage editor and its live preview read (app.js, applyHomePreview).
CASE_OPTION_FIELDS = ("id", "title", "summary", "status", "villages", "scope", "categories", "funding", "updated")


def case_options(records):
    return [{key: record[key] for key in CASE_OPTION_FIELDS if key in record} for record in records]


def build_case_options(records, root=ROOT):
    text = json.dumps(case_options(records), ensure_ascii=False, separators=(",", ":")) + "\n"
    target = Path(root) / CASE_OPTIONS
    if not target.exists() or target.read_text(encoding="utf-8") != text:
        target.write_text(text, encoding="utf-8")


def catalog_records(root=ROOT):
    rows = json.loads((root / "data/public-record-catalog.json").read_text())
    if not isinstance(rows, list):
        raise ValueError("Public record catalog must be an array")
    return rows


_SVG = '<svg viewBox="0 0 24 24" width="28" height="28" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{}</svg>'
SERVICE_ICONS = {
    "chat": _SVG.format('<path d="M4 5h16v11H9l-5 4z"/>'),
    # Same handset outline as the shared header phone link.
    "phone": _SVG.format('<path fill="currentColor" stroke="none" d="M6.6 2.8 9.2 2.2a1.5 1.5 0 0 1 1.7.9l1.2 3.1a1.5 1.5 0 0 1-.4 1.7l-1.6 1.3a14 14 0 0 0 5 5l1.3-1.6a1.5 1.5 0 0 1 1.7-.4l3.1 1.2a1.5 1.5 0 0 1 .9 1.7l-.6 2.6a2 2 0 0 1-2 1.6C10 19.1 4.9 14 4.9 7a2 2 0 0 1 1.7-2.2Z"/>'),
    "line": _SVG.format('<rect x="3" y="4" width="18" height="14" rx="5"/><path d="M8 18v3l4-3"/><path d="M8 9v4h2M13 9v4M16 9v4"/>'),
    "legal": _SVG.format('<path d="M6 3h9l3 3v15H6z"/><path d="M9 10h6M9 14h6M9 18h4"/>'),
}


def render_services(office, schedule):
    """Four direct service entries; the lawyer month comes from the canonical schedule."""
    month = int(schedule["month"].split("-")[1])
    entries = (
        ("service.html#contact", "chat", "有事找慧文", "服務處地址與時間", ""),
        (office["phoneUrl"], "phone", "撥打服務處", office["phone"], ""),
        (LINE_URL, "line", "LINE 官方帳號", "線上詢問", EXTERNAL),
        ("service.html#monthly-heading", "legal", "公益法律諮詢", f"{month}月律師時間表",
         f' data-home-legal-month="{e(schedule["month"])}"'),
    )
    links = "".join(
        f'<a class="home-service-entry" href="{e(href)}" data-home-task="{icon}"{attrs}>'
        f'<span class="home-service-icon" aria-hidden="true">{SERVICE_ICONS[icon]}</span>'
        f'<span class="home-service-copy"><strong>{e(label)}</strong><small>{e(note)}</small></span>'
        f'<span class="home-service-arrow" aria-hidden="true">{link_arrow(href)}</span></a>'
        for href, icon, label, note, attrs in entries
    )
    return f'<nav class="wrap home-service-band" id="service" aria-label="找服務">{links}</nav>'


def _variant_sources(source, root):
    """Return verified responsive variants for a reviewed local event image, else None."""
    if not source.as_posix().startswith("assets/events/"):
        return None
    source_file = Path(root) / source
    try:
        manifest = json.loads((Path(root) / EVENT_VARIANT_MANIFEST).read_text(encoding="utf-8"))
        entry = manifest.get("assets", {}).get(source.as_posix())
        if not (manifest.get("schemaVersion") == 1 and isinstance(entry, dict) and
                entry.get("sourceSha256") == sha256(source_file.read_bytes()).hexdigest()):
            return None
        hashes = entry.get("variants")
        if not isinstance(hashes, dict):
            return None
        verified = {"avif": [], "webp": []}
        for width in sorted(hashes, key=int):
            variants = hashes[width]
            if not isinstance(variants, dict):
                return None
            for fmt in ("avif", "webp"):
                expected_hash = variants.get(fmt)
                path = source.with_name(f"{source.stem}-{width}.{fmt}")
                asset = Path(root) / path
                if (not isinstance(expected_hash, str) or not SHA256_PATTERN.fullmatch(expected_hash) or
                        not asset.is_file() or sha256(asset.read_bytes()).hexdigest() != expected_hash):
                    return None
                verified[fmt].append((path.as_posix(), int(width)))
        return verified
    except (AttributeError, OSError, ValueError, TypeError):
        # A missing or stale manifest makes variants ineligible; the reviewed
        # original remains the safe fallback.
        return None


LEAD_SIZES = "(max-width: 760px) calc(100vw - 32px), (max-width: 1272px) 56vw, 700px"


def _responsive_event_picture(image, root=ROOT, eager=False):
    """Reviewed local event image with verified AVIF/WebP variants, else the original only."""
    source = Path(image["src"])
    if source.is_absolute() or ".." in source.parts or not source.as_posix().startswith("assets/events/"):
        raise ValueError("Homepage event image must be a reviewed local event asset")
    if not (Path(root) / source).is_file():
        raise ValueError(f"Homepage event source image is missing: {source.as_posix()}")
    responsive = _variant_sources(source, root)
    sources = fallback = ""
    if responsive:
        srcsets = {fmt: ", ".join(f"{e(path)} {width}w" for path, width in entries) for fmt, entries in responsive.items()}
        sources = (f'<source type="image/avif" srcset="{srcsets["avif"]}" sizes="{LEAD_SIZES}">'
                   f'<source type="image/webp" srcset="{srcsets["webp"]}" sizes="{LEAD_SIZES}">')
        fallback = f' srcset="{srcsets["webp"]}" sizes="{LEAD_SIZES}"'
    loading = ' loading="eager" fetchpriority="high"' if eager else ' loading="lazy"'
    return (f'<picture>{sources}<img src="{e(image["src"])}"{fallback} width="{image["width"]}" '
            f'height="{image["height"]}" alt="{e(image["alt"])}"{loading} decoding="async"></picture>')


def render_thumbnail(item, root, eager):
    thumb = item.get("thumbnail")
    if not thumb:
        return ""
    target = item.get("sourceUrl") or item["url"]
    loading = ' loading="eager" fetchpriority="high"' if eager else ' loading="lazy"'
    fallback = thumb.get("fallback")
    fallback_attrs = ""
    if fallback:
        fallback_attrs = (f' data-latest-fallback="{e(fallback["src"])}"'
                          f' data-latest-fallback-alt="{e(fallback["alt"])}"'
                          f' data-latest-fallback-credit="{e(fallback["credit"])}"')
    if thumb["local"] and thumb["src"].startswith("assets/events/"):
        image = _responsive_event_picture(thumb, root, eager)
    else:
        image = (f'<img src="{e(thumb["src"])}" width="{thumb["width"]}" height="{thumb["height"]}" '
                 f'alt="{e(thumb["alt"])}"{loading} decoding="async"'
                 f'{"" if thumb["local"] else " referrerpolicy=\"no-referrer\""}{fallback_attrs}>')
    media_class = "latest-media latest-media--contain" if item["type"] == "activity" else "latest-media"
    return (
        f'<figure class="{media_class}" data-latest-media>'
        f'<a class="latest-media-link" href="{e(target)}"{link_attrs(target)} tabindex="-1">{image}</a>'
        '<p class="latest-media-fallback" data-latest-media-fallback hidden>圖片暫時無法載入。'
        f'<a href="{e(target)}"{link_attrs(target)}>{"閱讀原文" if is_external(target) else "閱讀內容"} '
        f'{link_arrow(target)}</a></p>'
        f'<figcaption class="latest-credit" data-latest-credit>{e(thumb["credit"])}</figcaption></figure>'
    )


TITLE_TAIL = 5
# Semantic phrases that must not be split across lines (names, titles, offices, campaign and
# council terms, session numbers, numbers with units). Kept generic: no per-headline cuts.
TITLE_PHRASES = (
    "陳慧文", "賴瑞隆", "黃敬雅", "陳其邁", "吳立森", "張博洋",
    "高雄市議員", "高雄市議會", "市議員", "議員", "市長",
    "聯合", "競選總部", "總部", "成立大會", "問政", "優質議員", "市政總質詢", "總質詢", "質詢",
    "鳳山區", "鳳山", "高雄",
)
TITLE_PATTERN = re.compile(
    r"第\s?\d+\s?屆第\s?\d+\s?(?:會期|次定期大會)|第\s?\d+\s?(?:屆|會期)"
    r"|\d+(?:[.,]\d+)*\s?(?:萬元|萬|元|個月|年|月|日|天|週|%|校)"
    + "|" + "|".join(sorted(map(re.escape, TITLE_PHRASES), key=len, reverse=True))
)


def title_ranges(text):
    """Character ranges kept on one line: protected phrases plus the last few characters."""
    ranges = [match.span() for match in TITLE_PATTERN.finditer(text)]
    if len(text) > TITLE_TAIL * 2:
        ranges.append((len(text) - TITLE_TAIL, len(text)))
    merged = []
    for start, end in sorted(ranges):
        if merged and start < merged[-1][1]:  # overlap only; adjacent ranges may still break
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def title_html(text):
    """Headline markup that never splits a protected phrase and never ends with a 1–2 character line."""
    parts, cursor = [], 0
    for start, end in title_ranges(text):
        parts.append(e(text[cursor:start]))
        parts.append(f'<span class="latest-keep">{e(text[start:end])}</span>')
        cursor = end
    parts.append(e(text[cursor:]))
    return "".join(parts)


def format_day(value):
    return value[:10].replace("-", ".")


def format_event_time(value):
    start = datetime.fromisoformat(value).astimezone(TAIPEI)
    return f'{start.year}.{start.month:02d}.{start.day:02d}（{WEEKDAYS[start.weekday()]}）{start:%H:%M}'


def action_label(item):
    if item.get("hasVideo"):
        return "到原始來源觀看影片"
    if item["type"] == "activity":
        return "查看活動"
    if item["kind"] == "服務處新聞稿":
        return "閱讀新聞稿"
    if item.get("sourceUrl") and is_external(item["url"]):
        return "開啟原文"
    return "閱讀全文"


def render_latest_item(item, root, visible, lead):
    target = item["url"]
    if item["type"] == "activity":
        # The website publication time only orders the list; visitors see the event time.
        date_html = (f'<span class="latest-date"><span class="latest-date-label">活動時間</span> '
                     f'<time datetime="{e(item["eventStart"])}">{e(format_event_time(item["eventStart"]))}</time></span>')
    else:
        date_html = (f'<span class="latest-date"><span class="latest-date-label">{e(item["dateLabel"])}</span> '
                     f'<time datetime="{e(item["publishedAt"])}">{e(format_day(item["publishedAt"]))}</time></span>')
    status = ""
    if item.get("eventStatus") and item["eventStatus"] != "scheduled":
        status = f'<span class="latest-status">{e(item["eventStatusLabel"])}</span>'
    elif item["type"] == "activity":
        status = '<span class="latest-status" data-latest-event-badge hidden></span>'
    source = f'<span class="latest-source">{e(item["sourceName"])}</span>' if item.get("sourceName") else ""
    summary = f'<p class="latest-summary">{e(item["summary"])}</p>' if item.get("summary") else ""
    extra = ""
    if item.get("sourceUrl") and item["sourceUrl"] != target:
        extra = (f'<a class="latest-source-link" href="{e(item["sourceUrl"])}"{link_attrs(item["sourceUrl"])}>'
                 f'原始來源：{e(item["sourceName"])} {link_arrow(item["sourceUrl"])}</a>')
    attrs = (f' data-latest-id="{e(item["id"])}" data-latest-type="{e(item["type"])}"'
             f' data-latest-index="{item["naturalIndex"]}"')
    if item.get("pinned"):
        attrs += ' data-latest-pinned=""'
    if item.get("eventStart"):
        attrs += f' data-event-start="{e(item["eventStart"])}"'
    classes = "latest-item" + (" is-lead" if lead else "")
    return (
        f'<article class="{classes}"{attrs}{"" if visible else " hidden"}>'
        + render_thumbnail(item, root, eager=lead)
        + '<div class="latest-copy">'
        f'<p class="latest-meta"><span class="latest-kind">{e(item["kind"])}</span>{source}{date_html}{status}</p>'
        f'<h3 class="latest-title"><a href="{e(target)}"{link_attrs(target)}>{title_html(item["title"])}</a></h3>'
        f'{summary}<p class="latest-actions"><a class="latest-action" href="{e(target)}"{link_attrs(target)}>'
        f'{action_label(item)} {link_arrow(target)}</a>{extra}</p>'
        '</div></article>'
    )


def selected_latest(items):
    """Union of each filter's first items, kept in the one published order."""
    chosen = set()
    for key, _ in LATEST_FILTERS:
        matching = [item for item in items if key == "all" or item["type"] == key]
        chosen.update(item["id"] for item in matching[:LATEST_PER_FILTER])
    return [item for item in items if item["id"] in chosen]


def render_latest(feed, root=ROOT):
    items = selected_latest(feed["items"])
    rows = "".join(render_latest_item(item, root, visible=index < LATEST_INITIAL, lead=index == 0)
                   for index, item in enumerate(items))
    chosen = {item["id"] for item in items}
    # Inert copies of every other item, built from the same renderer: the CMS preview can pin an
    # older item exactly as the next build will render it. Template content is not in the DOM.
    reserve = "".join(render_latest_item(item, root, visible=False, lead=False)
                      for item in feed["items"] if item["id"] not in chosen)
    tabs = "".join(
        f'<button type="button" role="tab" id="latest-tab-{key}" aria-controls="latest-panel" '
        f'aria-selected="{"true" if key == "all" else "false"}" tabindex="{"0" if key == "all" else "-1"}" '
        f'data-latest-filter="{key}">{label}</button>'
        for key, label in LATEST_FILTERS
    )
    lists = "".join(f'<a href="{e(href)}"{link_attrs(href)}>{e(label)} {link_arrow(href)}</a>'
                    for href, label in LATEST_LIST_LINKS)
    return (
        '<section class="wrap home-latest" id="latest" aria-labelledby="home-latest-heading" data-home-latest>'
        # Earlier homepage anchors (#recent, #opening) keep pointing at the latest information.
        '<span class="home-anchor" id="hero-title"></span><span class="home-anchor" id="recent"></span>'
        '<span class="home-anchor" id="home-recent-heading"></span><span class="home-anchor" id="opening"></span>'
        '<div class="home-latest-head"><h1 id="home-latest-heading">最新資訊</h1>'
        f'<div class="home-latest-tabs" role="tablist" aria-label="最新資訊分類" hidden>{tabs}</div></div>'
        '<div class="home-latest-panel" id="latest-panel" role="tabpanel" aria-labelledby="latest-tab-all">'
        f'<div class="home-latest-items{"" if items and items[0].get("thumbnail") else " is-text-only"}" data-latest-items>{rows}</div>'
        f'<div class="home-latest-empty" data-latest-empty hidden>'
        '<p class="home-latest-empty-message">目前尚未收錄日常貼文，可到官方 Facebook 查看。</p>'
        f'<a class="latest-action" href="{FACEBOOK_URL}"{EXTERNAL}>官方 Facebook {link_arrow(FACEBOOK_URL)}</a></div>'
        + (f'<template data-latest-reserve>{reserve}</template>' if reserve else '') +
        '<p class="visually-hidden" data-latest-status aria-live="polite"></p>'
        '<button type="button" class="home-latest-more" data-latest-more hidden>查看更多</button>'
        '</div>'
        f'<p class="home-latest-lists"><span>完整列表：</span>{lists}</p>'
        '</section>'
    )


def featured_project(root=ROOT):
    config = json.loads((root / "data/civic-home.json").read_text())
    records = {row["id"]: row for row in public_records(root)}
    record = records.get(config["featured"])
    if record is None:
        raise ValueError("Homepage feature must reference a public achievement")
    return record, config.get("summaries", {}).get(record["id"]) or record.get("summary", "")


def render_featured_project(root=ROOT):
    record, summary = featured_project(root)
    url = f'achievement-{record["id"]}.html'
    place = "、".join(record.get("villages", [])) or record.get("scope", "地區未載")
    return (
        f'<article class="home-featured-project" data-home-featured-project="{e(record["id"])}">'
        '<span class="home-featured-pin" aria-hidden="true"></span>'
        f'<div class="home-featured-copy"><p class="home-featured-kicker">地方專題・{e(place)}</p>'
        f'<h3><a href="{e(url)}">{e(record["title"])}</a></h3>'
        f'<p class="home-featured-summary">{e(summary)}</p></div>'
        f'<p class="home-featured-status"><span aria-hidden="true"></span>{e(record.get("status") or "階段未載")}</p>'
        f'<a class="home-featured-history" href="{e(url)}">歷程與來源 {link_arrow(url)}</a></article>'
    )


def _geometry_polygons(geometry):
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates") or []
    if kind == "Polygon":
        return [coordinates]
    if kind == "MultiPolygon":
        return coordinates
    raise ValueError(f"Unsupported village boundary geometry: {kind}")


def _point_in_ring(lon, lat, ring):
    inside = False
    previous = ring[-1]
    for current in ring:
        x1, y1 = previous[:2]
        x2, y2 = current[:2]
        if ((y1 > lat) != (y2 > lat)) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
        previous = current
    return inside


def _point_in_feature(lon, lat, feature):
    for polygon in _geometry_polygons(feature["geometry"]):
        if not polygon or not _point_in_ring(lon, lat, polygon[0]):
            continue
        if not any(_point_in_ring(lon, lat, hole) for hole in polygon[1:]):
            return True
    return False


def local_coordinate_records(records, features):
    """Keep only existing public coordinates inside an official Fengshan boundary."""
    fengshan = [feature for feature in features if feature.get("properties", {}).get("district") == "鳳山區"]
    result = []
    for record in records:
        if record.get("district") != "鳳山區" or record.get("scope") in NON_LOCAL_SCOPES:
            continue
        coordinates = record.get("coordinates")
        if not isinstance(coordinates, list) or len(coordinates) != 2:
            continue
        lat, lon = coordinates
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
               for value in (lat, lon)):
            continue
        if any(_point_in_feature(lon, lat, feature) for feature in fengshan):
            result.append(record)
    return result


def _distance_to_segment(point, start, end):
    dx, dy = end[0] - start[0], end[1] - start[1]
    if dx == 0 and dy == 0:
        return math.hypot(point[0] - start[0], point[1] - start[1])
    ratio = max(0, min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)))
    return math.hypot(point[0] - (start[0] + ratio * dx), point[1] - (start[1] + ratio * dy))


def _simplify(points, tolerance):
    if len(points) <= 4:
        return points
    open_points = points[:-1] if points[0] == points[-1] else points
    keep = {0, len(open_points) - 1}
    stack = [(0, len(open_points) - 1)]
    while stack:
        first, last = stack.pop()
        maximum, index = 0.0, None
        for current in range(first + 1, last):
            distance = _distance_to_segment(open_points[current], open_points[first], open_points[last])
            if distance > maximum:
                maximum, index = distance, current
        if index is not None and maximum > tolerance:
            keep.update((index,))
            stack.extend(((first, index), (index, last)))
    simplified = [open_points[index] for index in sorted(keep)]
    if len(simplified) < 3:
        simplified = open_points[:3]
    return simplified + [simplified[0]]


def render_home_map_svg(records, geojson):
    if not geojson.get("license") or not geojson.get("sourceUrl"):
        raise ValueError("Fengshan village boundary must include license and source attribution")
    features = [feature for feature in geojson.get("features", [])
                if feature.get("properties", {}).get("district") == "鳳山區"]
    if not features:
        raise ValueError("Fengshan village boundary features are missing")
    polygons = [polygon for feature in features for polygon in _geometry_polygons(feature["geometry"])]
    source_points = [point for polygon in polygons for ring in polygon for point in ring]
    lon_values = [point[0] for point in source_points]
    lat_values = [point[1] for point in source_points]
    center_lat = sum(lat_values) / len(lat_values)
    cosine = math.cos(math.radians(center_lat))
    projected = [(point[0] * cosine, point[1]) for point in source_points]
    min_x, max_x = min(x for x, _ in projected), max(x for x, _ in projected)
    min_y, max_y = min(lat_values), max(lat_values)
    width, height, margin = 600.0, 460.0, 18.0
    scale = min((width - 2 * margin) / (max_x - min_x), (height - 2 * margin) / (max_y - min_y))
    offset_x = (width - (max_x - min_x) * scale) / 2
    offset_y = (height - (max_y - min_y) * scale) / 2

    def xy(lon, lat):
        return (offset_x + (lon * cosine - min_x) * scale,
                height - offset_y - (lat - min_y) * scale)

    path_elements = []
    for feature in features:
        path_data = []
        for polygon in _geometry_polygons(feature["geometry"]):
            for ring in polygon:
                points = [xy(point[0], point[1]) for point in ring]
                simplified = _simplify(points, 0.8)
                path_data.append("M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in simplified) + " Z")
        path_elements.append(f'<path d="{" ".join(path_data)}"/>')

    locations = local_coordinate_records(records, features)
    marker_elements = []
    for record in locations:
        lat, lon = record["coordinates"]
        x, y = xy(lon, lat)
        marker_elements.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.2"/>')
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 460" role="img" '
        'aria-labelledby="map-title map-description">'
        '<title id="map-title">鳳山區里界與公開紀錄座標</title>'
        '<desc id="map-description">里界來自內政部國土測繪中心村里界圖；圓點僅使用公開紀錄已有的鳳山區座標。</desc>'
        f'<metadata>里界資料來源：{e(geojson["sourceUrl"])}；授權：{e(geojson["license"])}。</metadata>'
        '<rect width="600" height="460" fill="#e9eee6"/>'
        '<g fill="#f7f6ef" stroke="#789080" stroke-width="0.8" fill-rule="evenodd" '
        'stroke-linejoin="round" vector-effect="non-scaling-stroke">'
        + "".join(path_elements)
        + '</g><g fill="#173f33" stroke="#f7f6ef" stroke-width="1.4">'
        + "".join(marker_elements)
        + "</g></svg>"
    )


def local_village_options(catalog, root=ROOT):
    """Fengshan villages that have at least one record in the formal 2,657-record catalogue."""
    fengshan = {row["name"] for row in json.loads((Path(root) / "data/villages.json").read_text())
                if row.get("district") == "鳳山區"}
    return sorted({village for record in catalog for village in record.get("villages", []) if village in fengshan})


def render_home_progress(root=ROOT):
    records = public_records(root)
    catalog = catalog_records(root)
    full = [row for row in catalog if row.get("recordFormat") == "full"]
    short = [row for row in catalog if row.get("recordFormat") == "short"]
    if len(full) != len(records) or len(full) + len(short) != len(catalog):
        raise ValueError("Public record catalog must separate full records and short records")
    geojson = json.loads((root / "assets/fengshan-villages.geojson").read_text())
    villages = local_village_options(catalog, root)
    village_options = "".join(f'<option value="v:{e(village)}">{e(village)}</option>' for village in villages)
    return (
        '<section class="wrap home-progress" id="progress" aria-labelledby="home-progress-heading">'
        '<span class="home-anchor" id="home-local-progress"></span><span class="home-anchor" id="home-local-heading"></span>'
        '<div class="home-progress-head"><div class="home-progress-title">'
        '<h2 id="home-progress-heading">查地方進度</h2><p>依里別或議題查詢公開紀錄</p></div>'
        '<form class="home-village-form" action="achievements.html#case-results" method="get" role="search">'
        '<label for="home-village">選擇里別</label>'
        '<div class="home-village-controls"><select id="home-village" name="village" '
        'aria-describedby="home-village-help"><option value="">選擇里別</option>'
        + village_options
        + '</select><button class="home-village-submit" type="submit">查看紀錄 →</button></div>'
        '<small id="home-village-help">選擇後前往建設與進度頁，可再依主題與進度篩選。</small>'
        '<noscript><small>未啟用 JavaScript 時，完整文字紀錄仍可在建設與進度頁查看。</small></noscript>'
        '</form></div>'
        + render_featured_project(root)
        + '<div class="home-progress-facts">'
        '<figure class="home-map-preview">'
        f'<a href="{e(MAP_LINK)}" aria-label="在互動地圖查看公開紀錄；也可使用上方里別選單或文字紀錄">'
        f'<img src="{MAP_ASSET}" width="600" height="460" loading="lazy" decoding="async" '
        'alt="鳳山區里界示意圖；圓點只標示公開紀錄已有的鳳山區座標。"></a>'
        f'<figcaption>里界資料：<a href="{e(geojson["sourceUrl"])}"{EXTERNAL}>內政部國土測繪中心村里界圖</a>，'
        f'{e(geojson["license"])}。圓點為公開紀錄已有座標。</figcaption></figure>'
        '<a class="home-map-text-link" href="achievements.html#case-results">'
        f'不使用地圖也可直接查閱全部公開紀錄 {link_arrow("achievements.html#case-results")}</a>'
        '</div></section>'
    )


def render_more(candidate_number):
    links = (
        ("council-records.html", "議會公開紀錄", "依會期與日期查詢質詢紀錄"),
        ("about.html", "認識慧文", "經歷、理念與服務處"),
        ("vision.html", "政見原文與追蹤", "歷屆政見與辦理情形"),
        ("election.html", "2026 選舉資訊", candidate_number),
    )
    items = "".join(f'<li><a href="{href}"><strong>{e(title)}</strong><span>{note}</span></a></li>'
                    for href, title, note in links)
    return ('<section class="wrap home-more" id="council" aria-labelledby="home-more-heading">'
            '<span class="home-anchor" id="home-council-heading"></span>'
            f'<h2 id="home-more-heading">更多資訊</h2><ul>{items}</ul></section>')


def render_contact(office):
    hours = "".join(
        f"<dt>{e(label)}</dt><dd>{e(value).replace('、', '<br>')}</dd>"
        for label, value in office["hours"]
    )
    return (
        '<section class="contact-section civic-service-desk" id="contact" aria-labelledby="contact-heading">'
        '<div class="wrap contact-grid"><div><p class="kicker">有事找慧文</p>'
        '<h2 id="contact-heading">先說說，<br>你遇到什麼事。</h2>'
        f'<a class="big-phone" href="{e(office["phoneUrl"])}">{e(office["phone"])}</a>'
        f'<p>{e(office["address"])}</p>'
        f'<a class="source" href="service.html#contact">完整聯絡資訊與地圖導航 {link_arrow("service.html#contact")}</a></div>'
        f'<div><dl aria-label="服務時間">{hours}</dl>'
        '<p>公益律師諮詢採預約制。請先來電確認日期、時段與名額。</p>'
        '<small>來訪前，請先向服務處確認當日服務與預約安排。</small></div>'
        '</div></section>'
    )


def build(root=ROOT):
    office = load_office(root)
    schedule = validate_schedule(json.loads((root / "data/legal-schedule.json").read_text()))
    records = public_records(root)
    geojson = json.loads((root / "assets/fengshan-villages.geojson").read_text())
    map_path = root / MAP_ASSET
    map_path.write_text(render_home_map_svg(records, geojson), encoding="utf-8")
    feed = latest_info.build(root)
    build_case_options(records, root)
    body = (root / "templates/home-main.html").read_text().strip()
    platforms = json.loads((root / "data/platforms.json").read_text())
    replacements = [
        ("HOME_SERVICES", render_services(office, schedule)),
        ("HOME_LATEST", render_latest(feed, root)),
        ("HOME_PROGRESS", render_home_progress(root)),
        ("HOME_MORE", render_more(render_candidate_number(platforms))),
        ("HOME_CONTACT", render_contact(office)),
    ]
    for key, value in replacements:
        marker = "{{" + key + "}}"
        if body.count(marker) != 1:
            raise ValueError("Exactly one homepage section marker required: " + key)
        body = body.replace(marker, value)
    if "{{" in body:
        raise ValueError("Unresolved homepage template marker")
    page = root / "index.html"
    content, count = re.subn(r"<main\b.*?</main>", lambda _: body, page.read_text(), count=1, flags=re.S)
    if count != 1:
        raise ValueError("Homepage main region is missing")
    page.write_text(content)
    print("Built homepage from latest information, service and public record sources")


if __name__ == "__main__":
    build()
