#!/usr/bin/env python3
# Read-only live-production fetch proxy used only by Production Browser QA.
from __future__ import annotations

import argparse
import hashlib
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

VERIFIER_UA = "chen-huiwen-production-verifier/1.3"
RUN_CACHE_KEY = os.environ.get("GITHUB_RUN_ID") or f"local-{int(time.time())}"
FILTERED_RESPONSE_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-encoding",
    "content-length", "set-cookie", "speculation-rules", "report-to", "nel",
}


def cache_busted_target(target: str) -> str:
    token = hashlib.sha256(target.encode("utf-8")).hexdigest()[:16]
    separator = "&" if "?" in target else "?"
    return f"{target}{separator}production-verification=browser-{RUN_CACHE_KEY}-{token}"


def normalize_edge_html(headers: list[tuple[str, str]], body: bytes) -> tuple[list[tuple[str, str]], bytes, bool]:
    # HTTP parity validates untouched Production. Browser QA removes only Cloudflare's
    # automation envelope so hosted Chromium can execute the live site-owned scripts.
    content_type = next((value for key, value in headers if key.lower() == "content-type"), "")
    if "text/html" not in content_type.lower():
        return headers, body, False

    text = body.decode("utf-8", "replace")
    original = text
    text = re.sub(
        r"type=(?P<q>[\"'])[^\"']+-text/javascript(?P=q)",
        'type="text/javascript"',
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"<script\b[^>]*\bsrc=(?P<q>[\"'])[^\"']*/cdn-cgi/(?:scripts/[^\"']*cloudflare-static/(?:rocket-loader|email-decode)\.min\.js|challenge-platform/[^\"']*)(?P=q)[^>]*>\s*</script>",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"<script\b(?![^>]*\bsrc=)[^>]*>(?:(?!</script>)[\s\S])*?challenge-platform(?:(?!</script>)[\s\S])*?</script>",
        "",
        text,
        flags=re.IGNORECASE,
    )
    return headers, text.encode("utf-8"), text != original


def build_server(hostname: str, bind: str, port: int) -> ThreadingHTTPServer:
    cache: dict[str, tuple[int, list[tuple[str, str]], bytes]] = {}
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "HuiwenLiveVerifier/1.1"

        def log_message(self, _format: str, *_args) -> None:
            return

        def _send(self, status: int, headers: list[tuple[str, str]], body: bytes, *, normalized: bool = False) -> None:
            self.send_response(status)
            for key, value in headers:
                if key.lower() not in FILTERED_RESPONSE_HEADERS:
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Huiwen-Live-Proxy", "1")
            if normalized:
                self.send_header("X-Huiwen-Edge-Normalized", "cloudflare-browser-envelope")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _fetch(self, target: str) -> tuple[int, list[tuple[str, str]], bytes]:
            with lock:
                cached = cache.get(target)
            if cached is not None:
                return cached

            parsed = urlsplit(target)
            if parsed.scheme != "https" or parsed.hostname != hostname:
                return 403, [("Content-Type", "text/plain; charset=utf-8")], b"forbidden"

            upstream_target = cache_busted_target(target)
            request = Request(upstream_target, headers={
                "User-Agent": VERIFIER_UA,
                "Accept": self.headers.get("Accept", "*/*"),
                "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
                "Accept-Encoding": "identity",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            })
            last_error: Exception | None = None
            for attempt in range(3):
                try:
                    with urlopen(request, timeout=20) as response:
                        body = response.read()
                        result = response.status, list(response.headers.items()), body
                        if 200 <= response.status < 400:
                            with lock:
                                cache[target] = result
                        return result
                except HTTPError as exc:
                    return exc.code, list(exc.headers.items()), exc.read()
                except (URLError, TimeoutError, OSError) as exc:
                    last_error = exc
                    if attempt < 2:
                        time.sleep(0.5 * (attempt + 1))
            message = f"upstream fetch failed: {type(last_error).__name__}".encode()
            return 502, [("Content-Type", "text/plain; charset=utf-8")], message

        def _handle(self) -> None:
            parsed = urlsplit(self.path)
            if parsed.path == "/healthz":
                self._send(200, [("Content-Type", "text/plain; charset=utf-8")], b"ok")
                return
            if parsed.path != "/fetch":
                self._send(404, [("Content-Type", "text/plain; charset=utf-8")], b"not found")
                return
            target = parse_qs(parsed.query).get("url", [""])[0]
            status, headers, body = self._fetch(target)
            headers, body, normalized = normalize_edge_html(headers, body)
            self._send(status, headers, body, normalized=normalized)

        do_GET = _handle
        do_HEAD = _handle

    return ThreadingHTTPServer((bind, port), Handler)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8799)
    args = parser.parse_args()
    build_server(args.host, args.bind, args.port).serve_forever()


if __name__ == "__main__":
    main()
