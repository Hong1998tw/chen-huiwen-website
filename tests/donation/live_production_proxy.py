#!/usr/bin/env python3
"""Tiny live-production fetch proxy for browser QA.

Only proxies HTTPS GET/HEAD requests to the configured production host. Responses
come from the real production edge using the same stable verifier identity as
scripts/verify_production.py. A small in-memory cache avoids re-fetching assets
across viewport passes while keeping the browser URL on the canonical host.
"""
from __future__ import annotations

import argparse
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

VERIFIER_UA = "chen-huiwen-production-verifier/1.3"
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-encoding",
    "content-length", "set-cookie",
}


def build_server(hostname: str, bind: str, port: int) -> ThreadingHTTPServer:
    cache: dict[str, tuple[int, list[tuple[str, str]], bytes]] = {}
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "HuiwenLiveVerifier/1.0"

        def log_message(self, _format: str, *_args) -> None:
            return

        def _send(self, status: int, headers: list[tuple[str, str]], body: bytes) -> None:
            self.send_response(status)
            for key, value in headers:
                if key.lower() not in HOP_BY_HOP:
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Huiwen-Live-Proxy", "1")
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

            request = Request(target, headers={
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
                    with urlopen(request, timeout=25) as response:
                        body = response.read()
                        result = response.status, list(response.headers.items()), body
                        if 200 <= response.status < 400:
                            with lock:
                                cache[target] = result
                        return result
                except HTTPError as exc:
                    body = exc.read()
                    return exc.code, list(exc.headers.items()), body
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
            self._send(status, headers, body)

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
