#!/usr/bin/env python3
# Serve a verified, short-lived live Production snapshot to Chromium QA.
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

FILTERED_RESPONSE_HEADERS = {
    "content-length", "content-encoding", "speculation-rules", "report-to", "nel",
}
FINGERPRINTED_ASSET = re.compile(r"^(?P<prefix>.+)\.(?P<sha256>[0-9a-f]{64})(?P<suffix>\.[^/]+)$")


def normalize_edge_html(body: bytes) -> tuple[bytes, bool]:
    # HTTP parity already validated these untouched live bytes. For browser QA, remove
    # only Cloudflare-owned automation wrappers so site-owned scripts execute directly.
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
    return text.encode("utf-8"), text != original


def content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    overrides = {
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".geojson": "application/geo+json; charset=utf-8",
        ".webmanifest": "application/manifest+json; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
    }
    if suffix in overrides:
        return overrides[suffix]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def resolve_snapshot_asset(
    root: Path,
    relative: str,
    verified_paths: set[str] | frozenset[str],
) -> tuple[Path, bytes] | None:
    if (
        not relative
        or "\\" in relative
        or Path(relative).is_absolute()
        or any(part in {"", ".", ".."} for part in relative.split("/"))
    ):
        raise ValueError("invalid snapshot path")

    expected_sha256 = None
    match = FINGERPRINTED_ASSET.fullmatch(relative)
    snapshot_path = relative
    if match:
        expected_sha256 = match.group("sha256")
        alias = f"{match.group('prefix')}{match.group('suffix')}"
        if relative not in verified_paths:
            if alias not in verified_paths:
                return None
            snapshot_path = alias
    elif relative not in verified_paths:
        return None

    resolved_root = root.resolve()
    candidate = (resolved_root / snapshot_path).resolve()
    try:
        candidate.relative_to(resolved_root)
    except ValueError:
        return None
    if not candidate.is_file():
        return None

    body = candidate.read_bytes()
    if expected_sha256 and hashlib.sha256(body).hexdigest() != expected_sha256:
        return None
    return candidate, body


def build_server(hostname: str, snapshot_dir: Path, bind: str, port: int) -> ThreadingHTTPServer:
    root = snapshot_dir.resolve()
    manifest_path = root / "_snapshot.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"missing live snapshot manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("status") != "Passed":
        raise RuntimeError("live snapshot was not produced by a Passed HTTP parity check")
    manifest_paths = manifest.get("paths")
    if not isinstance(manifest_paths, list) or any(not isinstance(path, str) for path in manifest_paths):
        raise RuntimeError("live snapshot manifest has no valid verified path list")
    verified_paths = frozenset(manifest_paths)

    class Handler(BaseHTTPRequestHandler):
        server_version = "HuiwenLiveSnapshot/1.0"

        def log_message(self, _format: str, *_args) -> None:
            return

        def _send(self, status: int, body: bytes, mime: str = "text/plain; charset=utf-8", *, normalized: bool = False) -> None:
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Huiwen-Live-Snapshot", "1")
            if normalized:
                self.send_header("X-Huiwen-Edge-Normalized", "cloudflare-browser-envelope")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _handle(self) -> None:
            parsed_request = urlsplit(self.path)
            if parsed_request.path == "/healthz":
                self._send(200, b"ok")
                return
            if parsed_request.path != "/fetch":
                self._send(404, b"not found")
                return

            target = parse_qs(parsed_request.query).get("url", [""])[0]
            parsed = urlsplit(target)
            if parsed.scheme != "https" or parsed.hostname != hostname:
                self._send(403, b"forbidden")
                return

            relative = parsed.path.lstrip("/") or "index.html"
            try:
                resolved = resolve_snapshot_asset(root, relative, verified_paths)
            except ValueError:
                self._send(403, b"invalid path")
                return
            if resolved is None:
                self._send(404, b"snapshot path missing")
                return

            candidate, body = resolved
            normalized = False
            if candidate.suffix.lower() == ".html":
                body, normalized = normalize_edge_html(body)
            self._send(200, body, content_type(candidate), normalized=normalized)

        do_GET = _handle
        do_HEAD = _handle

    return ThreadingHTTPServer((bind, port), Handler)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--snapshot-dir", required=True)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8799)
    args = parser.parse_args()
    build_server(args.host, Path(args.snapshot_dir), args.bind, args.port).serve_forever()


if __name__ == "__main__":
    main()
