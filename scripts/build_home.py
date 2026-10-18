#!/usr/bin/env python3
"""Build the approved homepage from reviewed public service, event and case data."""
from collections import Counter
from datetime import datetime
from html import escape
import json
import math
from pathlib import Path
import re
from urllib.parse import quote
from zoneinfo import ZoneInfo

from achievement_metadata import latest_history_event
from build_events import validate as validate_event
from build_guides import load_office
from build_service import validate_schedule

ROOT = Path(__file__).resolve().parents[1]
FEATURED_EVENT = "campaign-headquarters-opening-2026-10-31"
MAP_ASSET = "assets/fengshan-home-map.svg"
MAP_LINK = "achievements.html?case=wende-school-center#achievement-map"
NON_LOCAL_SCOPES = {"全市政策", "跨區服務"}
STATUS_ORDER = ("已完成", "持續追蹤", "爭取規劃", "政策實施")
LINE_URL = "https://line.me/R/ti/p/@yve2766q"


def e(value):
    return escape(str(value), quote=True)


def public_records(root=ROOT):
    rows = json.loads((root / "data/achievements-public.json").read_text())
    if not isinstance(rows, list):
        raise ValueError("Public achievement projection must be an array")
    return rows


def render_services(office, schedule):
    """Render only the three task cards and a short, source-based lawyer link."""
    month = int(schedule["month"].split("-")[1])
    return (
        '<nav class="home-task-paths" aria-label="首頁常用任務">'
        '<a href="service.html#contact" data-home-task="service">'
        '<span>民眾服務</span><strong>服務處聯絡資訊</strong>'
        '<small>地址、服務時間與諮詢</small></a>'
        '<a href="achievements.html#case-results" data-home-task="local">'
        '<span>地方進度</span><strong>查找公開紀錄</strong>'
        '<small>依里別與辦理階段查看</small></a>'
        '<a href="council-records.html" data-home-task="records">'
        '<span>議會問政</span><strong>查詢議會紀錄</strong>'
        '<small>質詢紀錄與官方資料</small></a>'
        '</nav>'
        f'<p class="home-lawyer-link">本月公益律師： '
        f'<a href="service.html#monthly-heading" data-home-legal-month="{e(schedule["month"])}">'
        f'{month}月時間表 →</a></p>'
    )


def _responsive_event_picture(image):
    source = Path(image["src"])
    widths = (480, 800, image["width"])
    avif = ", ".join(
        f"{e(source.with_name(source.stem + '-' + str(width) + '.avif').as_posix())} {width}w"
        for width in widths
    )
    webp = ", ".join(
        f"{e(source.with_name(source.stem + '-' + str(width) + '.webp').as_posix())} {width}w"
        for width in widths
    )
    sizes = (
        "(max-width: 620px) calc(100vw - 40px), "
        "(max-width: 780px) calc(100vw - 64px), "
        "(max-width: 900px) calc((100vw - 64px - 28px) / 3), "
        "(max-width: 1244px) calc((100vw - 64px - 40px) / 3), 380px"
    )
    return (
        f'<picture><source type="image/avif" srcset="{avif}" sizes="{sizes}">'
        f'<source type="image/webp" srcset="{webp}" sizes="{sizes}">'
        f'<img src="{e(image["src"])}" srcset="{webp}" sizes="{sizes}" '
        f'width="{image["width"]}" height="{image["height"]}" '
        f'alt="{e(image["alt"])}" loading="lazy" decoding="async"></picture>'
    )


def render_event(events):
    event = next((item for item in events if item["id"] == FEATURED_EVENT), None)
    if event is None:
        return (
            '<article class="home-recent-event" id="opening">'
            '<p class="meta">公開行程</p><h3>近期公開行程與活動</h3>'
            '<a class="source" href="activities.html">查看公開行程與活動 →</a></article>'
        )
    validate_event(event)
    start = datetime.fromisoformat(event["start"]).astimezone(ZoneInfo("Asia/Taipei"))
    url = "event-" + event["id"] + ".html"
    status = {
        "scheduled": "公開行程",
        "rescheduled": "行程時間已更改",
        "cancelled": "活動已取消",
    }[event.get("status", "scheduled")]
    change = f'<p class="home-recent-copy">{e(event["changeNote"])}</p>' if event.get("changeNote") else ""
    photo = _responsive_event_picture(event["images"][0]) if event.get("images") else ""
    registration = event.get("registration") or "參與方式請以主辦單位公告為準。"
    return (
        f'<article class="home-recent-event" id="opening" data-home-event="{e(event["id"])}">'
        f'<div class="home-recent-art home-recent-art--event">{photo}</div>'
        f'<div class="home-recent-card-copy"><p class="meta">{status}</p>'
        f'<p class="event-date"><time datetime="{e(event["start"])}">'
        f'{start.month}月{start.day}日 · 星期{"一二三四五六日"[start.weekday()]} · {start:%H:%M}</time></p>'
        f'<h3><a href="{e(url)}">{e(event["name"])}</a></h3>'
        f'<p class="event-location">{e(event.get("location", ""))}</p>{change}'
        f'<p class="home-recent-copy">{e(registration)}</p>'
        f'<a class="source" href="{e(url)}">完整行程與活動圖卡 →</a></div></article>'
    )


def render_recent_local(root=ROOT):
    config = json.loads((root / "data/civic-home.json").read_text())
    records = {row["id"]: row for row in public_records(root)}
    record = records.get(config["featured"])
    if record is None:
        raise ValueError("Homepage feature must reference a public achievement")
    summary = config.get("summaries", {}).get(record["id"]) or record.get("summary", "")
    place = "、".join(record.get("villages", [])) or record.get("scope", "地區未載")
    latest = latest_history_event(record.get("history") or [])
    date_text = latest.get("date", "日期未載") if latest else "日期未載"
    category = (record.get("categories") or ["地方專題"])[0]
    return (
        f'<article class="home-recent-local" data-home-local-record="{e(record["id"])}">'
        f'<div class="home-recent-art home-recent-art--local"><span>{e(category)}</span>'
        f'<span>{e(place)}</span></div><div class="home-recent-card-copy">'
        f'<p class="meta">地方專題</p>'
        f'<h3><a href="achievement-{e(record["id"])}.html">{e(record["title"])}</a></h3>'
        f'<p class="home-recent-copy">{e(summary)}</p>'
        f'<p class="home-recent-meta">{e(record.get("status") or "階段未載")} · 最新收錄 {e(date_text)}</p>'
        f'<a class="source" href="achievement-{e(record["id"])}.html">'
        f'閱讀這件地方事與資料來源 →</a></div></article>'
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


def render_home_progress(root=ROOT):
    records = public_records(root)
    geojson = json.loads((root / "assets/fengshan-villages.geojson").read_text())
    counts = Counter(record.get("status", "") for record in records if record.get("status"))
    ordered_statuses = [status for status in STATUS_ORDER if status in counts]
    ordered_statuses.extend(sorted(set(counts) - set(ordered_statuses)))
    villages = sorted({
        village
        for record in records
        if record.get("district") == "鳳山區" and record.get("scope") not in NON_LOCAL_SCOPES
        for village in record.get("villages", [])
    })
    stat_links = []
    for status in ordered_statuses:
        url = "achievements.html?status=" + quote(status, safe="") + "#case-results"
        stat_links.append(
            f'<li><a href="{url}" data-home-status="{e(status)}">'
            f'<span>{e(status)}</span><strong>{counts[status]}</strong></a></li>'
        )
    village_options = "".join(
        f'<option value="v:{e(village)}">{e(village)}</option>' for village in villages
    )
    return (
        '<section class="section home-local-progress" id="home-local-progress" '
        'aria-labelledby="home-local-heading"><div class="wrap">'
        '<div class="home-local-heading"><p class="kicker">鳳山地方進度</p>'
        '<h2 id="home-local-heading">公開紀錄，依里別查看</h2>'
        '<p>從公開資料查看不同辦理階段，或依里別找相關紀錄。</p></div>'
        '<div class="home-local-layout"><div class="home-local-stats">'
        '<a class="home-total-stat" href="achievements.html#case-results" data-home-stat="total">'
        f'<strong>{len(records)}</strong><span>筆公開紀錄</span></a>'
        '<ul class="home-status-stats" aria-label="依辦理階段查看紀錄">'
        + "".join(stat_links)
        + '</ul><a class="home-village-coverage" href="achievements.html#case-results" '
        'data-home-stat="villages"><strong>' + str(len(villages)) + '</strong>'
        '<span>個里有公開紀錄</span><small>這是資料涵蓋里數，非鳳山行政里總數。</small></a>'
        '</div><div class="home-local-discovery"><figure class="home-map-preview">'
        '<a href="' + e(MAP_LINK) + '" aria-label="在互動地圖查看公開紀錄；也可使用下方里別選單或文字紀錄">'
        f'<img src="{MAP_ASSET}" width="600" height="460" loading="lazy" decoding="async" '
        'alt="鳳山區里界示意圖；圓點只標示公開紀錄已有的鳳山區座標。">'
        '</a><figcaption>里界資料：<a href="' + e(geojson["sourceUrl"]) + '" target="_blank" '
        'rel="noopener noreferrer">內政部國土測繪中心村里界圖</a>，'
        + e(geojson["license"])
        + ". "
        ' 圓點為公開紀錄已有座標。</figcaption></figure>'
        '<form class="home-village-form" action="achievements.html#case-results" method="get" role="search">'
        '<label for="home-village">依里別查詢公開紀錄</label>'
        '<div class="home-village-controls"><select id="home-village" name="village" '
        'aria-describedby="home-village-help"><option value="">選擇里別</option>'
        + village_options
        + '</select><button class="home-village-submit" type="submit">查看紀錄</button>'
        '<button class="home-village-reset" type="reset">清除選擇</button></div>'
        '<small id="home-village-help">選擇後前往既有紀錄頁；可用鍵盤操作，清除選擇不需 JavaScript。</small>'
        '<noscript><small>未啟用 JavaScript 時，完整文字紀錄仍可在建設與進度頁查看。</small></noscript>'
        '</form><a class="home-map-text-link" href="achievements.html#case-results">'
        '不使用地圖也可直接查閱全部公開紀錄 →</a></div></div></div></section>'
    )


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
        '<a class="source" href="service.html#contact">完整聯絡資訊與地圖導航 →</a></div>'
        f'<div><dl aria-label="服務時間">{hours}</dl>'
        '<p>公益律師諮詢採預約制。請先來電確認日期、時段與名額。</p>'
        '<small>來訪前，請先向服務處確認當日服務與預約安排。</small></div>'
        '</div></section>'
    )


def build(root=ROOT):
    office = load_office(root)
    schedule = validate_schedule(json.loads((root / "data/legal-schedule.json").read_text()))
    events = json.loads((root / "data/events.json").read_text())["events"]
    records = public_records(root)
    geojson = json.loads((root / "assets/fengshan-villages.geojson").read_text())
    map_path = root / MAP_ASSET
    map_path.write_text(render_home_map_svg(records, geojson), encoding="utf-8")
    body = (root / "templates/home-main.html").read_text().strip()
    replacements = [
        ("HOME_PHONE_URL", e(office["phoneUrl"])),
        ("HOME_SERVICES", render_services(office, schedule)),
        ("HOME_EVENT", render_event(events)),
        ("HOME_LOCAL", render_recent_local(root)),
        ("HOME_PROGRESS", render_home_progress(root)),
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
    print("Built homepage from current public achievement, service and event sources")


if __name__ == "__main__":
    build()
