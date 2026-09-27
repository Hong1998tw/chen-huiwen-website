"""Strict, deterministic rendering of owner-supplied public media links."""
from __future__ import annotations

import html
import re
from urllib.parse import quote, urlsplit, parse_qs


def classify(url: str, kind: str):
    """Return (provider, embed URL). Never accept arbitrary iframe URLs."""
    if not isinstance(url, str) or kind not in {'photo', 'video'}:
        return None
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or '').lower()
        if (parsed.scheme != 'https' or not host or parsed.username or parsed.password
                or parsed.port not in (None, 443) or '.' not in host or ':' in host
                or host in {'docs.google.com', 'notion.so', 'notion.site', 'notion.com'}
                or host.endswith(('.local', '.internal', '.lan', '.home', '.corp', '.notion.so', '.notion.site', '.notion.com'))
                or re.fullmatch(r'[\d.]+', host) or re.search(r'(?:token|api_key|secret|password)=', parsed.query, re.I)):
            return None
        if host == 'drive.google.com':
            match = re.fullmatch(r'/file/d/([A-Za-z0-9_-]{15,})/(?:view|preview)?/?', parsed.path)
            if not match:
                return None
            return 'drive', f'https://drive.google.com/file/d/{match[1]}/preview'
        if host in {'facebook.com', 'www.facebook.com', 'm.facebook.com'}:
            if parsed.path in ('', '/'):
                return None
            target = 'https://www.facebook.com' + parsed.path
            if parsed.query:
                target += '?' + parsed.query
            plugin = 'video' if kind == 'video' else 'post'
            return 'facebook', f'https://www.facebook.com/plugins/{plugin}.php?href={quote(target, safe="")}&show_text=false&width=640'
        if kind == 'video' and host in {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'}:
            video_id = parsed.path.strip('/') if host == 'youtu.be' else parse_qs(parsed.query).get('v', [''])[0]
            if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
                return None
            return 'youtube', f'https://www.youtube-nocookie.com/embed/{video_id}'
        if kind == 'photo' and re.search(r'\.(?:jpe?g|png|webp|avif|gif)$', parsed.path, re.I):
            return 'image', url
        if kind == 'video' and re.search(r'\.(?:mp4|webm)$', parsed.path, re.I):
            return 'video', url
    except ValueError:
        pass
    return None


def render(media: dict) -> str:
    provider, embed = classify(media['url'], media['kind'])
    escaped = lambda value: html.escape(str(value), quote=True)
    if provider == 'image':
        # Declare a 4:3 placeholder box so static quality checks pass and the
        # browser can reserve space before an external image's intrinsic size loads.
        visual = (
            f'<img src="{escaped(embed)}" alt="{escaped(media["alt"])}" '
            'width="1200" height="900" loading="lazy" decoding="async">'
        )
    elif provider == 'video':
        visual = f'<video src="{escaped(embed)}" controls preload="none" aria-label="{escaped(media["alt"])}"></video>'
    else:
        visual = f'<iframe src="{escaped(embed)}" title="{escaped(media["alt"])}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>'
    return (f'<figure class="case-external-media">{visual}<figcaption>{escaped(media["caption"])}'
            f'<span class="case-photo-credit">來源：{escaped(media["credit"])} · '
            f'<a href="{escaped(media["url"])}" target="_blank" rel="noopener noreferrer">開啟原始內容 ↗</a></span>'
            '</figcaption></figure>')
