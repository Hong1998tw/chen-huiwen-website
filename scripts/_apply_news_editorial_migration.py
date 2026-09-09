#!/usr/bin/env python3
"""One-time migration for 2026-09-07/09-09 multi-source news cards.

Runs only on the feature branch and removes itself through the companion workflow.
"""
from __future__ import annotations

import html
import pathlib
import re
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
NEWS = ROOT / "news.html"
ASSETS = ROOT / "assets"

SEP7_TITLE = "媽祖港橋跨區合體：陳慧文、黃敬雅向通勤市民問早"
SEP9_TITLE = "選戰倒數80天，高雄隊跨區集結；陳慧文參與鳳山團隊路口拜票"

SEP7_TAIPO = "https://line.today/tw/v3/article/JPnLqG3"
SEP7_YAHOO = "https://tw.news.yahoo.com/%E5%80%92%E6%95%B880%E5%A4%A9%E9%81%B8%E6%88%B0%E5%8D%87%E6%BA%AB-%E9%99%B3%E6%85%A7%E6%96%87%E8%B7%A8%E5%8D%80%E6%8C%BA%E9%BB%83%E6%95%AC%E9%9B%85-%E5%AA%BD%E7%A5%96%E6%B8%AF%E6%A9%8B%E5%90%88%E9%AB%94%E6%8B%9C%E7%A5%A8%E6%8B%9A%E6%95%B4%E5%90%88-030426435.html"

UA = "Mozilla/5.0 (compatible; chen-huiwen-website-maintenance/1.0)"


def fetch_bytes(url: str) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read(), resp.headers.get_content_type()


def find_og_image(page: str) -> str | None:
    patterns = [
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
        r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, page, flags=re.I)
        if match:
            return html.unescape(match.group(1))
    return None


def jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    if not data.startswith(b"\xff\xd8"):
        return None
    sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        while i < len(data) and data[i] == 0xFF:
            i += 1
        if i >= len(data):
            break
        marker = data[i]
        i += 1
        if marker in {0xD8, 0xD9}:
            continue
        if i + 2 > len(data):
            break
        length = int.from_bytes(data[i:i + 2], "big")
        if length < 2 or i + length > len(data):
            break
        if marker in sof_markers and length >= 7:
            height = int.from_bytes(data[i + 3:i + 5], "big")
            width = int.from_bytes(data[i + 5:i + 7], "big")
            if width > 0 and height > 0:
                return width, height
        i += length
    return None


def download_sep7_office_photo() -> tuple[str, int, int] | None:
    """Best-effort copy of the lead photo credited by the source to 陳慧文辦公室.

    Only a valid JPEG with readable intrinsic dimensions is accepted. If it
    cannot be retrieved, the card stays text-only rather than using a wrong
    generic/portrait image.
    """
    for article_url in (SEP7_TAIPO, SEP7_YAHOO):
        try:
            page_bytes, _ = fetch_bytes(article_url)
            page = page_bytes.decode("utf-8", errors="ignore")
            image_url = find_og_image(page)
            if not image_url:
                continue
            image_bytes, content_type = fetch_bytes(image_url)
            if content_type != "image/jpeg" or len(image_bytes) < 20_000:
                continue
            dimensions = jpeg_dimensions(image_bytes)
            if not dimensions:
                continue
            target = ASSETS / "news-20260907-mazu-port-bridge.jpg"
            target.write_bytes(image_bytes)
            width, height = dimensions
            return target.relative_to(ROOT).as_posix(), width, height
        except Exception as exc:
            print(f"photo fetch skipped for {article_url}: {exc}")
    return None


def full_reports(items: list[tuple[str, str]]) -> str:
    links = "".join(
        f'<a class="text-link" href="{url}" target="_blank" rel="noopener noreferrer">{html.escape(label)}<span aria-hidden="true"> ↗</span></a>'
        for label, url in items
    )
    return f'<p class="source-note"><strong>完整報導</strong></p><div class="news-source-links" aria-label="完整報導">{links}</div>'


def sep9_card() -> str:
    reports = [
        ("中央社｜議長康裕成號召「高雄隊」　力拚市長當選議會過半", "https://www.cna.com.tw/news/aipl/202609090155.aspx"),
        ("自由時報｜選戰倒數80天賴瑞隆率民進黨高雄隊出動 9日一早採取這招", "https://video.ltn.com.tw/article/6WBfMUtLN0w/PLI7xntdRxhw1rpX3OIi9nX4jeQoPimc9q"),
        ("Newtalk｜決戰80天高雄隊吹響集結號 「隆會做事」連線力拚市長當選、議會過半", "https://newtalk.tw/news/view/2026-09-09/1058781"),
        ("NOWnews今日新聞｜綠營集結高雄隊　力挺賴瑞隆勝選議會過半", "https://www.nownews.com/news/6873545"),
        ("民視新聞網｜民進黨「高雄隊大團結」　賴瑞隆率逾20名議員站路口拜票", "https://www.ftvnews.com.tw/news/detail/2026909U01M1"),
        ("台灣好報｜「市長要贏、議會要過半」康裕成吹號角　民進黨高雄隊決戰80天", "https://news.pchome.com.tw/living/newstaiwandigi/20260909/index-78891821206524279009.html"),
        ("媒事．看新聞｜決戰80天！康裕成議長帶領高雄隊跨區出擊、力拚市長當選議會過半！", "https://times.586.com.tw/2026/09/995002/"),
    ]
    return (
        '<article class="content-card news-report-card" data-record data-news-categories="public">'
        '<div class="card-body"><p class="eyebrow">2026.09.09</p>'
        '<div class="news-topic-list" aria-label="新聞分類"><span class="news-topic">公共參與</span></div>'
        f'<h2>{SEP9_TITLE}</h2>'
        '<p>9月9日上午，高雄市議會議長康裕成與民進黨高雄市長參選人賴瑞隆、立委李昆澤、許智傑，以及20多位現任市議員與議員參選人，在三民、鳳山交界路口進行跨區聯合拜票。陳慧文以鳳山區現任議員身分參與，與張漢忠及議員參選人鄧巧佩、蘇致榮等鳳山團隊成員同場。</p>'
        '<p>活動主軸為選戰倒數80天的跨區集結，團隊宣示爭取市長當選與議會席次過半。公開報導對交叉路口名稱有不同記載，因此官網保留「三民、鳳山交界路口」的範圍描述，不把未釐清的單一路口名稱寫成確定事實。</p>'
        + full_reports(reports)
        + '</div></article>'
    )


def sep7_card(photo: tuple[str, int, int] | None) -> str:
    reports = [
        ("Newtalk｜登記參選後首個上班日 黃敬雅、陳慧文媽祖港橋合體站路口", "https://newtalk.tw/news/view/2026-09-07/1058255"),
        ("太報｜倒數80天選戰升溫！陳慧文跨區挺黃敬雅　媽祖港橋合體拜票拚整合", SEP7_TAIPO),
        ("台灣好報｜戰倒數80天　陳慧文、黃敬雅媽祖港橋合體　跨區女力搶攻通勤票", "https://news.pchome.com.tw/living/newstaiwandigi/20260907/index-78877590476327279009.html"),
        ("說新聞｜登記後首個上班日合體　陳慧文黃敬雅站上媽祖港橋　跨區女力攜手拜票", "https://life.tw/article/%E7%99%BB%E8%A8%98%E5%BE%8C%E9%A6%96%E5%80%8B%E4%B8%8A%E7%8F%AD%E6%97%A5%E5%90%88%E9%AB%94-%E9%99%B3%E6%85%A7%E6%96%87%E9%BB%83%E6%95%AC%E9%9B%85%E7%AB%99%E4%B8%8A%E5%AA%BD%E7%A5%96%E6%B8%AF%E6%A9%8B-%E8%B7%A8%E5%8D%80%E5%A5%B3%E5%8A%9B%E6%94%9C%E6%89%8B-3142125"),
        ("今傳媒｜南方問政連線成員分進合擊 在高雄市各大路口向高雄市民拜票，爭取選民最大的支持！", "https://focusnews.com.tw/2026/09/719357/"),
        ("NOWnews今日新聞｜南方問政成員登記後上班首日　站路口拜票", "https://news.pchome.com.tw/public/nownews/20260907/index-78876001485583207016.html"),
    ]
    figure = ""
    if photo:
        photo_path, width, height = photo
        figure = (
            f'<figure class="news-report-media"><img src="{photo_path}" '
            f'alt="陳慧文與黃敬雅於媽祖港橋路口向通勤市民拜票" width="{width}" height="{height}" loading="lazy" decoding="async">'
            '<figcaption>陳慧文與黃敬雅於媽祖港橋路口向通勤市民拜票。圖／陳慧文辦公室提供。</figcaption></figure>'
        )
    return (
        '<article class="content-card news-report-card" data-record data-news-categories="public transport">'
        + figure
        + '<div class="card-body"><p class="eyebrow">2026.09.07</p>'
        '<div class="news-topic-list" aria-label="新聞分類"><span class="news-topic">公共參與</span><span class="news-topic">交通建設</span></div>'
        f'<h2>{SEP7_TITLE}</h2>'
        '<p>9月7日上午，九合一大選候選人登記截止後首個上班日，鳳山區市議員陳慧文與前鎮小港選區市議員候選人黃敬雅在媽祖港橋路口向通勤市民問早、拜票。</p>'
        '<p>陳慧文表示，媽祖港橋連結鳳山與前鎮，兩區居民在工作、就學、交通與日常生活上的往來密切；這次跨區合體，希望展現相鄰選區彼此合作、共同為地方建設與市民服務努力的態度。她也肯定黃敬雅投入公共服務，期盼兩人在不同選區各自扎根、彼此加油。</p>'
        + full_reports(reports)
        + '</div></article>'
    )


def replace_card(source: str, title: str, replacement: str) -> tuple[str, int]:
    pattern = re.compile(r'<article class="content-card news-report-card"[^>]*>.*?</article>', re.S)
    count = 0

    def repl(match: re.Match[str]) -> str:
        nonlocal count
        card = match.group(0)
        if f'<h2>{title}</h2>' in card:
            count += 1
            return replacement
        return card

    return pattern.sub(repl, source), count


def main() -> None:
    source = NEWS.read_text(encoding="utf-8")
    source = source.replace(
        "一篇報導可能同時屬於多個主題；同一事件原則上整合為一張卡，並保留代表性來源供交叉查核。",
        "一篇報導可能同時屬於多個主題；同一事件原則上整合為一張卡，已查得且有效的相關媒體原文均列於「完整報導」。",
    )

    photo = download_sep7_office_photo()
    if photo:
        print(f"Using rights-cleared Sep 7 office-provided photo: {photo[0]} {photo[1]}x{photo[2]}")
    else:
        print("No rights-cleared Sep 7 binary could be retrieved; card will remain text-only.")

    source, sep9_count = replace_card(source, SEP9_TITLE, sep9_card())
    source, sep7_count = replace_card(source, SEP7_TITLE, sep7_card(photo))
    if sep9_count != 1 or sep7_count != 1:
        raise SystemExit(f"target card match failed: sep9={sep9_count}, sep7={sep7_count}")

    forbidden = [
        "Newtalk、太報及台灣好報等多家媒體均確認這場跨區活動。",
        "中央社、自由時報、Newtalk與NOWnews均報導，陳慧文",
        "陳慧文官網公開形象圖；9月9日活動現場照片",
        "陳慧文官網公開資料照，非9月7日活動現場照",
    ]
    for phrase in forbidden:
        if phrase in source:
            raise SystemExit(f"forbidden legacy wording remains: {phrase}")

    required = [
        "<strong>完整報導</strong>",
        "太報｜倒數80天選戰升溫！陳慧文跨區挺黃敬雅",
        "Newtalk｜登記參選後首個上班日 黃敬雅、陳慧文媽祖港橋合體站路口",
        "中央社｜議長康裕成號召「高雄隊」",
        "民視新聞網｜民進黨「高雄隊大團結」",
    ]
    for phrase in required:
        if phrase not in source:
            raise SystemExit(f"required editorial output missing: {phrase}")

    NEWS.write_text(source, encoding="utf-8")


if __name__ == "__main__":
    main()
