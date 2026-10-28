#!/usr/bin/env python3
"""Independent live production verification for www.huiwen.tw.

Cloudflare may intentionally transform HTML at the edge (for example email
obfuscation or Rocket Loader), so HTML is verified semantically instead of by
raw byte equality. Canonical same-origin CSS/JS assets and static files still
require exact hash parity.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
import shutil
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE_URL = "https://www.huiwen.tw/"
CORE_PAGES = (
    "index.html",
    "about.html",
    "election.html",
    "achievements.html",
    "vision.html",
    "news.html",
    "press.html",
    "activities.html",
    "service.html",
    "service-guides.html",
    "service-print.html",
    "updates.html",
    "achievement-after-school-care.html",
    "achievement-bade-detention.html",
    "petition.html",
    "political-donation.html",
    "terms.html",
    "achievement-metro-green-line.html",
    "achievement-wende-school-center.html",
    "achievement-school-case-review.html",
)
STATIC_FILES = (
    "robots.txt",
    "llms.txt",
    "updates.xml",
    "sitemap.xml",
    "manifest.webmanifest",
    "data/election-2026.json",
    "data/achievements.json",
    "data/achievements-public.json",
    "data/achievement-map.json",
    "data/platforms.json",
    "data/search-index.json",
    "data/events.json",
    "data/site-profile.json",
    "island/island-data.json",
    "sw.js",
    "page-font-manifest.json",
    "publication-manifest.json",
    "offline.html",
    "assets/fengshan-villages.geojson",
    "assets/fengshan-home-map.svg",
    "assets/legal/portrait.webp",
    "assets/home-portrait-384.avif",
    "assets/home-portrait-480.avif",
    "assets/home-portrait-640.avif",
    "assets/home-portrait-1004.avif",
    "assets/home-portrait-384.webp",
    "assets/home-portrait-480.webp",
    "assets/home-portrait-640.webp",
    "assets/events/campaign-opening-20261031-landscape-480.avif",
    "assets/events/campaign-opening-20261031-landscape-800.avif",
    "assets/events/campaign-opening-20261031-landscape-1087.avif",
    "assets/events/campaign-opening-20261031-landscape-480.webp",
    "assets/events/campaign-opening-20261031-landscape-800.webp",
    "assets/events/campaign-opening-20261031-landscape-1087.webp",
    "assets/events/campaign-opening-20261031-landscape.jpg",
    "assets/vendor/leaflet.css",
    "small-q.css",  # Loaded after window load; still required by the live snapshot.
    "assets/vendor/leaflet.js",
)
MIN_TEXT_COVERAGE = 0.95
BINARY_SUFFIXES = frozenset({
    ".avif", ".gif", ".ico", ".jpeg", ".jpg", ".mp4", ".otf", ".pdf",
    ".png", ".ttf", ".webm", ".webp", ".woff", ".woff2",
})


def normalize_space(value: str) -> str:
    return " ".join(value.split())


def decode_cfemail(value: str) -> str | None:
    """Decode Cloudflare Email Address Obfuscation's data-cfemail payload."""
    try:
        encoded = bytes.fromhex(value)
        if len(encoded) < 2:
            return None
        key = encoded[0]
        return bytes(byte ^ key for byte in encoded[1:]).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.lang = None
        self.title_parts: list[str] = []
        self.in_title = False
        self.canonical = None
        self.description = None
        self.local_assets: set[str] = set()
        self.visible_fragments: list[str] = []
        self._hidden_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        data = dict(attrs)
        if tag in {"script", "style", "template", "noscript"}:
            self._hidden_depth += 1
        if tag == "html":
            self.lang = data.get("lang")
        elif tag == "title":
            self.in_title = True
        elif tag == "link":
            rel = (data.get("rel") or "").lower().split()
            href = data.get("href")
            if "canonical" in rel:
                self.canonical = href
            if "stylesheet" in rel and href:
                self._add_asset(href)
        elif tag == "meta":
            if (data.get("name") or "").lower() == "description":
                self.description = data.get("content")
        elif tag == "script" and data.get("src"):
            self._add_asset(data["src"])

        # Cloudflare replaces visible email addresses with a placeholder and a
        # reversible data-cfemail payload. Rehydrate the original address for
        # semantic source comparison while still allowing the injected markup.
        cfemail = data.get("data-cfemail")
        if not self._hidden_depth and cfemail:
            decoded = decode_cfemail(cfemail)
            if decoded:
                self.visible_fragments.append(decoded)

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False
        if tag in {"script", "style", "template", "noscript"} and self._hidden_depth:
            self._hidden_depth -= 1

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)
        if not self._hidden_depth:
            text = normalize_space(data)
            if text:
                self.visible_fragments.append(text)

    def _add_asset(self, raw: str) -> None:
        url = urlsplit(raw)
        if url.scheme or url.netloc or not url.path:
            return
        path = url.path.lstrip("/")
        if path and not path.startswith("../") and not path.startswith("cdn-cgi/"):
            self.local_assets.add(path)

    @property
    def title(self) -> str:
        return "".join(self.title_parts).strip()

    @property
    def visible_text(self) -> str:
        return normalize_space(" ".join(self.visible_fragments))


class CriticalParser(HTMLParser):
    """Exact public-service facts, independent of broad prose coverage.

    Classes identify source-owned fact blocks. Text, times and link destinations
    are compared, while harmless Cloudflare email obfuscation is normalized.
    This is not fact checking: it proves the deployed facts match reviewed source.
    """
    CLASSES = {'footer-grid', 'contact-card', 'hours-card', 'schedule-text',
               'donation-account', 'donation-period', 'home-account',
               'civic-service-desk', 'campaign-keydates', 'case-latest', 'case-facts'}
    IDS = {'campaign-number-draw', 'campaign-vote-date', 'campaign-election-source'}
    VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}

    def __init__(self):
        super().__init__()
        self.stack = []
        self.facts = {}
        self.contact_links = []
        self.structured_data = []

    def append_text(self, text):
        for frame in self.stack:
            if frame['key']:
                frame['parts'].append(text)

    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        href = data.get('href', '')
        decoded = decode_cfemail(data.get('data-cfemail', ''))
        if href.startswith('/cdn-cgi/l/email-protection#'):
            address = decode_cfemail(href.split('#', 1)[1])
            if address:
                href = 'mailto:' + address
        if href.startswith(('tel:', 'mailto:')):
            self.contact_links.append(href)
        markers = sorted(self.CLASSES.intersection(data.get('class', '').split()))
        if data.get('id') in self.IDS:
            markers.append('#' + data['id'])
        if tag == 'time':
            markers.append('time:' + data.get('datetime', ''))
        if href.startswith('tel:'):
            markers.append('telephone:' + href)
        key = '|'.join(markers)
        if href and any(frame['key'] for frame in self.stack):
            self.append_text('href=' + href)
        if tag in self.VOID:
            self.append_text(' ')
            return
        self.stack.append({'tag': tag, 'key': key, 'parts': [],
                           'cfemail': bool(decoded), 'jsonld': tag == 'script' and data.get('type') == 'application/ld+json',
                           'json': []})
        if decoded:
            self.append_text(decoded)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in self.VOID:
            return
        index = next((i for i in range(len(self.stack)-1, -1, -1) if self.stack[i]['tag'] == tag), None)
        if index is None:
            return
        for frame in self.stack[index:]:
            if frame['key']:
                self.facts.setdefault(frame['key'], []).append(normalize_space(' '.join(frame['parts'])))
            if frame['jsonld']:
                try:
                    self.structured_data.append(json.dumps(json.loads(''.join(frame['json'])), ensure_ascii=False, sort_keys=True))
                except ValueError:
                    self.structured_data.append('INVALID_JSON_LD')
        del self.stack[index:]

    def handle_data(self, data):
        if self.stack and self.stack[-1]['jsonld']:
            self.stack[-1]['json'].append(data)
        if any(frame['tag'] in ('script', 'style') or frame['cfemail'] for frame in self.stack):
            return
        self.append_text(data)

    def contract(self):
        return {'facts': {key: sorted(values) for key, values in sorted(self.facts.items())},
                'contactLinks': sorted(self.contact_links), 'structuredData': sorted(self.structured_data)}


def critical_contract(html):
    parser = CriticalParser()
    parser.feed(html)
    return parser.contract()


def critical_differences(local_html, remote_html):
    local, remote = critical_contract(local_html), critical_contract(remote_html)
    # Report only field labels, never echo changed account/contact values.
    return [key for key in local if local[key] != remote[key]]


def canonical_bytes(local_path):
    # Public JSON is generated from canonical source through the same explicit
    # allowlist used by the artifact builder. Compare the edge response with
    # that projection, never with raw editorial metadata.
    from build_public import PUBLIC_DATA_PROJECTIONS, encoded, project_public_data

    if local_path in PUBLIC_DATA_PROJECTIONS:
        return encoded(project_public_data(ROOT)[local_path])

    if local_path == 'sw.js':
        # The deployment worker is an artifact-only derivative. Rebuild the
        # same reviewed projection to obtain its expected bytes; never trust a
        # remote or arbitrary publication manifest to certify the worker.
        from build_public import build

        with tempfile.TemporaryDirectory(prefix='.verify-sw-', dir=ROOT) as temporary:
            artifact = Path(temporary) / 'public'
            build(ROOT, artifact)
            return (artifact / 'sw.js').read_bytes()

    # The legacy public JSON URL serves sanitized achievement data after the
    # artifact cutover. Never compare it to, or snapshot it from, raw source.
    path = ROOT / ('data/achievements-public.json' if local_path == 'data/achievements.json' else local_path)
    return path.read_bytes()


def normalize_text_bytes(data: bytes) -> bytes:
    text = data.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    return text.rstrip().encode("utf-8")


def is_binary_path(path: str) -> bool:
    return Path(path).suffix.lower() in BINARY_SUFFIXES


def digest(data: bytes, *, binary: bool = False) -> str:
    if binary:
        canonical = data
    else:
        try:
            canonical = normalize_text_bytes(data)
        except UnicodeDecodeError:
            # Font and other binary callers may not have a path available to
            # select the explicit binary mode. Invalid UTF-8 remains byte exact.
            canonical = data
    return hashlib.sha256(canonical).hexdigest()


def source_parity(local_path: str, local: bytes, remote: bytes, *, binary: bool = False) -> bool:
    """Keep exact SHA-256 equality for the derived worker and binary assets."""
    if local_path == 'sw.js':
        return hashlib.sha256(local).digest() == hashlib.sha256(remote).digest()
    return digest(local, binary=binary) == digest(remote, binary=binary)


def source_sha256(local_path: str, data: bytes, *, binary: bool = False) -> str:
    if local_path == 'sw.js':
        return hashlib.sha256(data).hexdigest()
    return digest(data, binary=binary)


def visible_text_coverage(local: PageParser, remote: PageParser) -> float:
    fragments = [fragment for fragment in local.visible_fragments if len(fragment) >= 4]
    if not fragments:
        return 1.0
    remote_text = remote.visible_text
    total = sum(len(fragment) for fragment in fragments)
    matched = sum(len(fragment) for fragment in fragments if fragment in remote_text)
    return matched / total if total else 1.0


def remote_path(local_path: str) -> str:
    return "/" if local_path == "index.html" else "/" + local_path


def fetch(base_url: str, path: str, cache_key: str, timeout: int) -> tuple[int, str, bytes]:
    target = urljoin(base_url, path.lstrip("/"))
    separator = "&" if "?" in target else "?"
    target = f"{target}{separator}production-verification={cache_key}"
    request = Request(
        target,
        headers={
            "User-Agent": "chen-huiwen-production-verifier/1.3",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        return response.status, response.geturl(), response.read()


def verification_cache_key(local: bytes, run_cache_key: str, attempt: int, *, binary: bool = False) -> str:
    """Use canonical text or exact binary bytes in the per-run cache key."""
    return f"{digest(local, binary=binary)[:16]}-{run_cache_key}-{attempt}"


class VerificationInterrupted(BaseException):
    def __init__(self, signum):
        self.signum = signum


class VerificationProgress:
    """Observation only: never decides whether a production check passes.

    The primary report is partial until a full attempt returns. Atomic sibling
    files retain earlier attempts and the latest phase/path even on cancellation.
    New diagnostics contain source-owned paths, field names and exception types,
    never response text, contact values, or arbitrary exception messages.
    """
    def __init__(self, report_path=None, *, enabled=True):
        self.report_path = Path(report_path) if report_path else None
        self.enabled = enabled
        self.lock = threading.RLock()
        self.started = time.monotonic()
        self.history = []
        self.events = []
        self.attempt = 0
        self.attempt_finalized = False
        self.active = {}
        self.phases = {}
        self.checks = []
        self.failures = []
        self.font_results = {}
        self.failed_paths = set()
        self.errors = []
        self.interrupted = False
        self.interrupted_checks = []
        self.final_result = None
        self.checkpoint_interval = 1.0
        self.last_checkpoint = float('-inf')
        self.started_path_phases = set()
        self.failure_details = {}
        self.persisted_failure_paths = set()
        self.annotated_paths = set()
        self.stop_checkpoint = threading.Event()
        self.checkpoint_thread = None

    def _attempt_path(self):
        path = self.report_path
        return path.with_name(f"{path.stem}.attempt-{self.attempt:03d}{path.suffix}")

    @staticmethod
    def _write(path, payload):
        path.parent.mkdir(parents=True, exist_ok=True)
        # Lock serializes this writer; replace keeps readers from seeing half JSON.
        temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
        with temporary.open("w", encoding="utf-8") as stream:
            stream.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)

    def _payload(self):
        # Existing failures are source-generated labels. Store only the source
        # path prefix here; no changed contact/account values or raw error text.
        failed = set(self.failed_paths)
        for failure in self.failures:
            path = failure.partition(":")[0]
            if re.fullmatch(r"[A-Za-z0-9_./-]+", path):
                failed.add(path)
        status = "FAILED_PARTIAL" if self.failures or failed or self.errors else "PENDING"
        return {
            "status": status, "complete": False, "attempt": self.attempt,
            "elapsedSeconds": round(time.monotonic() - self.started, 3),
            "interrupted": self.interrupted, "interruptedDuring": self.interrupted_checks,
            "activeChecks": list(self.active.values()), "phases": self.phases,
            "checked": len(self.checks),
            "failedPaths": sorted(failed), "errorTypes": self.errors,
            "failureDetails": list(self.failure_details.values()),
            "completedFontChecks": len(self.font_results),
            "attemptHistory": self.history,
            "recentEvents": self.events[-200:],
            "note": "Partial observation cannot certify production parity or PASS.",
        }

    def _failure_paths(self):
        paths = set(self.failed_paths)
        for failure in self.failures:
            path = failure.partition(":")[0]
            if self._safe_path(path):
                paths.add(path)
        return paths

    @staticmethod
    def _safe_path(path):
        return (isinstance(path, str) and len(path) <= 512 and
                re.fullmatch(r"[A-Za-z0-9_./-]+", path) and
                not path.startswith("/") and ".." not in Path(path).parts)

    def _annotate_failure(self, path, detail):
        if (os.environ.get("GITHUB_ACTIONS") != "true" or not self._safe_path(path) or
                path in self.annotated_paths or len(self.annotated_paths) >= 10):
            return
        self.annotated_paths.add(path)
        kind = detail.get("errorType", "CheckFailed")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,99}", kind):
            kind = "CheckFailed"
        code = detail.get("http")
        suffix = f" HTTP {code}" if type(code) is int and 100 <= code <= 599 else ""
        # Both fields are allowlisted identifiers; no response/exception prose.
        print(f"::warning file={path},title=Production verification::{path}: {kind}{suffix}", flush=True)

    def _checkpoint(self, *, force=False, attempt_receipt=False):
        if not self.report_path:
            return
        now = time.monotonic()
        if not force and now - self.last_checkpoint < self.checkpoint_interval:
            return
        payload = self._payload()
        progress_path = self.report_path.with_name(self.report_path.stem + ".progress.json")
        self._write(progress_path, payload)
        self._write(self.report_path, payload)
        if attempt_receipt and self.attempt and not self.attempt_finalized:
            self._write(self._attempt_path(), payload)
        self.last_checkpoint = time.monotonic()
        self.persisted_failure_paths = self._failure_paths()

    def _start_checkpoint_clock(self):
        if not self.enabled or not self.report_path or self.checkpoint_thread:
            return
        def clock():
            while not self.stop_checkpoint.is_set():
                # Refresh even while one HTTP/local-contract call is blocked.
                with self.lock:
                    remaining = self.checkpoint_interval - (time.monotonic() - self.last_checkpoint)
                if self.stop_checkpoint.wait(max(.01, remaining)):
                    return
                with self.lock:
                    if not self.stop_checkpoint.is_set():
                        self._checkpoint()
        self.checkpoint_thread = threading.Thread(target=clock, name="verification-checkpoint", daemon=True)
        self.checkpoint_thread.start()

    def emit(self, event, *, force=False, **fields):
        if not self.enabled:
            return
        with self.lock:
            row = {"event": event, "attempt": self.attempt,
                   "elapsedSeconds": round(time.monotonic() - self.started, 3),
                   "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), **fields}
            self.events.append(row)
            print("production-verification-progress " + json.dumps(row, ensure_ascii=False), flush=True)
            failures = self._failure_paths()
            new_failures = failures - self.persisted_failure_paths
            for path in sorted(new_failures):
                self._annotate_failure(path, self.failure_details.get(path, {}))
            critical = event in {"attempt-start", "attempt-end", "phase-start", "phase-end",
                                 "phase-error", "check-failure", "interrupted", "interrupted-check"}
            # Ordinary paths do not serialize a full report on every event.
            self._checkpoint(force=force or critical or bool(new_failures),
                             attempt_receipt=event in {"attempt-start", "attempt-end", "interrupted",
                                                       "interrupted-check", "phase-error"})

    def fetch_failure(self, phase, path, exc):
        if not self.enabled:
            return
        with self.lock:
            detail = {"phase": phase, "path": path, "errorType": type(exc).__name__}
            if isinstance(exc, HTTPError) and type(exc.code) is int and 100 <= exc.code <= 599:
                detail["http"] = exc.code
            self.failure_details[path] = detail
            self.failed_paths.add(path)
            if phase not in {"font_assets", "font_routes"}:
                self.emit("check-failure", **detail)

    def start_attempt(self, attempt):
        with self.lock:
            self.attempt = attempt
            self.attempt_finalized = False
            self.started_path_phases = set()
            self.failure_details, self.persisted_failure_paths = {}, set()
            self.attempt_started = time.monotonic()
            self.active, self.phases = {}, {}
            self.checks, self.failures, self.font_results = [], [], {}
            self.failed_paths, self.errors = set(), []
            self.emit("attempt-start")
            self._start_checkpoint_clock()

    def bind(self, checks, failures):
        self.checks, self.failures = checks, failures

    def start_phase(self, phase, total=None):
        with self.lock:
            self.phases[phase] = {"state": "running", "total": total,
                                  "completed": 0, "started": time.monotonic(),
                                  "startedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds")}
            self.emit("phase-start", phase=phase, total=total)

    def end_phase(self, phase):
        with self.lock:
            row = self.phases[phase]
            if phase == "local_contract":
                row["completed"] = 1
            row.update(state="interrupted" if self.interrupted else ("failed_partial" if row["state"] == "failed_partial" else "completed"),
                       endedAt=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                       durationSeconds=round(time.monotonic() - row["started"], 3))
            self.emit("phase-end", phase=phase, durationSeconds=row["durationSeconds"])

    @contextmanager
    def check(self, phase, path):
        if not self.enabled:
            yield
            return
        key = f"{phase}:{path}"
        started = time.monotonic()
        with self.lock:
            self.active[key] = {"phase": phase, "path": path,
                                "startedElapsedSeconds": round(started - self.started, 3)}
            first_path = phase not in self.started_path_phases
            self.started_path_phases.add(phase)
            self.emit("check-start", phase=phase, path=path, force=first_path)
        error = None
        try:
            yield
        except BaseException as exc:
            error = type(exc).__name__
            with self.lock:
                if isinstance(exc, (KeyboardInterrupt, VerificationInterrupted)):
                    self.interrupted = True
                    self.interrupted_checks.append({"phase": phase, "path": path})
                    self.emit("interrupted-check", phase=phase, path=path, errorType=error)
                else:
                    self.errors.append(error)
                    self.failed_paths.add(path)
            raise
        finally:
            with self.lock:
                self.active.pop(key, None)
                row = self.phases.get(phase)
                if row:
                    row["completed"] += 1
                self.emit("check-end", phase=phase, path=path,
                          durationSeconds=round(time.monotonic() - started, 3), errorType=error)

    def observe(self, phase, get_path):
        def decorate(function):
            if not self.enabled:
                return function
            def wrapped(item):
                path = get_path(item)
                with self.check(phase, path):
                    result = function(item)
                    with self.lock:
                        self.font_results[(phase, path)] = result["status"]
                        if result["status"] != "Passed":
                            self.failed_paths.add(path)
                            detail = self.failure_details.setdefault(path, {"phase": phase, "path": path, "errorType": "CheckFailed"})
                            if type(result.get("http")) is int and 100 <= result["http"] <= 599:
                                detail["http"] = result["http"]
                            self.emit("check-failure", **detail)
                    return result
            return wrapped
        return decorate

    def exception(self, phase, exc):
        with self.lock:
            self.errors.append(type(exc).__name__)
            for row in self.phases.values():
                if row["state"] == "running":
                    row.update(state="failed_partial", endedAt=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                               durationSeconds=round(time.monotonic() - row["started"], 3))
            self.emit("phase-error", phase=phase, errorType=type(exc).__name__)

    def interrupt(self, signum=None):
        with self.lock:
            self.interrupted = True
            self.interrupted_checks.extend(dict(row) for row in self.active.values())
            for row in self.phases.values():
                if row["state"] == "running":
                    row.update(state="interrupted", endedAt=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                               durationSeconds=round(time.monotonic() - row["started"], 3))
            # Persist before stack unwinding / ThreadPoolExecutor shutdown waits.
            self.emit("interrupted", signal=signum)

    def finish_attempt(self, result):
        with self.lock:
            self.history.append({"attempt": self.attempt, "status": result["status"],
                                 "durationSeconds": round(time.monotonic() - self.attempt_started, 3),
                                 "failedPaths": self._payload()["failedPaths"]})
            self.emit("attempt-end", status=result["status"],
                      durationSeconds=self.history[-1]["durationSeconds"],
                      failedPaths=self.history[-1]["failedPaths"])
            if self.report_path:
                self._write(self._attempt_path(), diagnostic_payload(result))
            self.attempt_finalized = True

    def finish(self, result):
        self.stop_checkpoint.set()
        if self.report_path:
            with self.lock:
                self._write(self.report_path, diagnostic_payload(result))
                payload = self._payload()
                payload.update(status=result["status"], complete=result["status"] in {"Passed", "Failed"})
                self._write(self.report_path.with_name(self.report_path.stem + ".progress.json"), payload)
        return result


def diagnostic_payload(result):
    """Redact contact-like values only in diagnostic prose, not assertions/hash data."""
    def redact(text):
        text = re.sub(r"[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[email redacted]", text)
        return re.sub(r"(?<![A-Za-z0-9])(?:\+886[- ]?|0)(?:9\d{2}[- ]?\d{3}[- ]?\d{3}|[2-8][- ]?\d{3,4}[- ]?\d{4})(?![A-Za-z0-9])", "[phone redacted]", text)
    def visit(value, key=None):
        if isinstance(value, dict):
            return {k: visit(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [visit(v, key) for v in value]
        return redact(value) if key == "failures" and isinstance(value, str) else value
    return visit(result)


def verify_once(base_url: str, timeout: int, run_cache_key: str, attempt: int,
                snapshot_dir: Path | None = None, artifact_root: Path = Path("_site"),
                *, progress: VerificationProgress | None = None) -> dict:
    progress = progress or VerificationProgress(enabled=False)
    checks: list[dict] = []
    failures: list[str] = []
    progress.bind(checks, failures)
    assets: set[str] = set()
    base_host = urlsplit(base_url).hostname
    scripts_path = str(ROOT / "scripts")
    if scripts_path not in __import__("sys").path:
        __import__("sys").path.insert(0, scripts_path)
    import page_font_contract
    progress.start_phase("local_contract", 1)
    try:
        contract = page_font_contract.validate_artifact_contract(artifact_root, ROOT)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        progress.exception("local_contract", exc)
        progress.end_phase("local_contract")
        return {
            "status": "Failed", "baseUrl": base_url, "checked": 0,
            "failures": ["local publication/page-font contract failed: " + str(exc)],
            "checks": [], "fontRoutes": [], "fontAssets": [],
        }
    progress.end_phase("local_contract")
    publication_files = contract["publication"]["files"]
    if snapshot_dir:
        if snapshot_dir.exists():
            shutil.rmtree(snapshot_dir)
        snapshot_dir.mkdir(parents=True, exist_ok=True)

    def save_snapshot(path: str, body: bytes) -> None:
        if not snapshot_dir:
            return
        destination = snapshot_dir / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(body)

    progress.start_phase("core_static", len(CORE_PAGES) + len(STATIC_FILES))
    for local_path in list(CORE_PAGES) + list(STATIC_FILES):
        with progress.check("core_static", local_path):
            source_path = Path(artifact_root) / local_path
            if local_path not in publication_files and local_path not in {"publication-manifest.json"}:
                failures.append(f"{local_path}: not present in emitted publication manifest")
                continue
            if not source_path.is_file():
                failures.append(f"{local_path}: missing from emitted public artifact")
                continue

            local = source_path.read_bytes()
            if local_path != "publication-manifest.json" and hashlib.sha256(local).hexdigest() != publication_files[local_path]:
                failures.append(f"{local_path}: local bytes differ from emitted publication manifest")
                continue
            binary = is_binary_path(local_path)
            cache_key = verification_cache_key(local, run_cache_key, attempt, binary=binary)
            try:
                status, final_url, remote = fetch(base_url, remote_path(local_path), cache_key, timeout)
            except (HTTPError, URLError, TimeoutError, OSError) as exc:
                progress.fetch_failure("core_static", local_path, exc)
                failures.append(f"{local_path}: fetch failed ({type(exc).__name__})")
                checks.append({"path": local_path, "status": "Failed", "stage": "fetch"})
                continue

            same_host = urlsplit(final_url).hostname == base_host
            raw_parity = source_parity(local_path, local, remote, binary=binary)
            if status == 200 and same_host:
                save_snapshot(local_path, remote)

            if local_path.endswith(".html"):
                local_parser = PageParser()
                local_parser.feed(local.decode("utf-8-sig", errors="replace"))
                remote_parser = PageParser()
                remote_parser.feed(remote.decode("utf-8-sig", errors="replace"))
                assets.update(local_parser.local_assets)

                page_failures: list[str] = []
                if status != 200:
                    page_failures.append(f"HTTP {status}")
                if not same_host:
                    page_failures.append("redirected away from production host")
                if remote_parser.lang != "zh-Hant-TW":
                    page_failures.append("live lang is not zh-Hant-TW")
                if not remote_parser.title or remote_parser.title != local_parser.title:
                    page_failures.append("live title mismatch")
                if remote_parser.description != local_parser.description:
                    page_failures.append("live description mismatch")
                if remote_parser.canonical != local_parser.canonical:
                    page_failures.append("live canonical mismatch")

                missing_assets = sorted(local_parser.local_assets - remote_parser.local_assets)
                if missing_assets:
                    page_failures.append("canonical asset references missing: " + ", ".join(missing_assets))

                critical = critical_differences(local.decode('utf-8-sig'), remote.decode('utf-8-sig'))
                if critical:
                    page_failures.append('critical public facts differ: ' + ', '.join(critical))

                coverage = visible_text_coverage(local_parser, remote_parser)
                if coverage < MIN_TEXT_COVERAGE:
                    page_failures.append(
                        f"visible text coverage {coverage:.3f} below {MIN_TEXT_COVERAGE:.2f}"
                    )

                checks.append(
                    {
                        "path": local_path,
                        "status": "Passed" if not page_failures else "Failed",
                        "http": status,
                        "sameHost": same_host,
                        "rawSourceParity": raw_parity,
                        "edgeTransformed": not raw_parity,
                        "visibleTextCoverage": round(coverage, 4),
                        "expectedAssetsPresent": not missing_assets,
                        "criticalFactsMatch": not critical,
                        "localSha256": source_sha256(local_path, local, binary=binary),
                        "remoteSha256": source_sha256(local_path, remote, binary=binary),
                    }
                )
                failures.extend(f"{local_path}: {failure}" for failure in page_failures)
                continue

            parity = raw_parity
            checks.append(
                {
                    "path": local_path,
                    "status": "Passed" if status == 200 and same_host and parity else "Failed",
                    "http": status,
                    "sameHost": same_host,
                    "sourceParity": parity,
                    "localSha256": source_sha256(local_path, local, binary=binary),
                    "remoteSha256": source_sha256(local_path, remote, binary=binary),
                }
            )
            if status != 200:
                failures.append(f"{local_path}: HTTP {status}")
            if not same_host:
                failures.append(f"{local_path}: redirected away from production host")
            if not parity:
                failures.append(f"{local_path}: production body differs from canonical source")

    progress.end_phase("core_static")

    progress.start_phase("referenced_assets", len(assets))
    for asset in sorted(assets):
        with progress.check("referenced_assets", asset):
            source_path = Path(artifact_root) / asset
            if not source_path.is_file():
                failures.append(f"{asset}: referenced asset missing from emitted public artifact")
                continue
            local = source_path.read_bytes()
            if asset not in publication_files or hashlib.sha256(local).hexdigest() != publication_files[asset]:
                failures.append(f"{asset}: local bytes differ from emitted publication manifest")
                continue
            binary = is_binary_path(asset)
            cache_key = verification_cache_key(local, run_cache_key, attempt, binary=binary)
            try:
                status, final_url, remote = fetch(base_url, "/" + asset, cache_key, timeout)
            except (HTTPError, URLError, TimeoutError, OSError) as exc:
                progress.fetch_failure("referenced_assets", asset, exc)
                failures.append(f"{asset}: fetch failed ({type(exc).__name__})")
                checks.append({"path": asset, "status": "Failed", "stage": "fetch"})
                continue

            same_host = urlsplit(final_url).hostname == base_host
            parity = digest(local, binary=binary) == digest(remote, binary=binary)
            if status == 200 and same_host:
                save_snapshot(asset, remote)
            checks.append(
                {
                    "path": asset,
                    "status": "Passed" if status == 200 and same_host and parity else "Failed",
                    "http": status,
                    "sameHost": same_host,
                    "sourceParity": parity,
                    "localSha256": digest(local, binary=binary),
                    "remoteSha256": digest(remote, binary=binary),
                }
            )
            if status != 200:
                failures.append(f"{asset}: HTTP {status}")
            if not same_host:
                failures.append(f"{asset}: redirected away from production host")
            if not parity:
                failures.append(f"{asset}: production body differs from canonical source")

    progress.end_phase("referenced_assets")

    font_assets = []
    @progress.observe("font_assets", lambda item: item[0])
    def check_font_asset(item):
        path, row = item
        local_path = Path(artifact_root) / path
        local = local_path.read_bytes()
        cache_key = verification_cache_key(local, run_cache_key, attempt, binary=True)
        try:
            status, final_url, remote = fetch(base_url, "/" + path, cache_key, timeout)
            same_host = urlsplit(final_url).hostname == base_host
            page_font_contract.validate_font_bytes(path, remote, row)
            ok = status == 200 and same_host
            return {"path": path, "status": "Passed" if ok else "Failed", "http": status,
                    "sameHost": same_host, "expectedSha256": row["sha256"],
                    "remoteSha256": hashlib.sha256(remote).hexdigest(), "bytes": len(remote),
                    "failures": [] if ok else ["HTTP status or production host mismatch"]}
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
            progress.fetch_failure("font_assets", path, exc)
            return {"path": path, "status": "Failed", "failures": [type(exc).__name__ + ": " + str(exc)]}

    progress.start_phase("font_assets", len(contract["fonts"]))
    with ThreadPoolExecutor(max_workers=12) as pool:
        font_assets = list(pool.map(check_font_asset, sorted(contract["fonts"].items())))
    progress.end_phase("font_assets")
    failures.extend(f"{item['path']}: {error}" for item in font_assets for error in item["failures"])

    @progress.observe("font_routes", lambda route: route)
    def check_font_route(route):
        local = (Path(artifact_root) / route).read_bytes()
        cache_key = verification_cache_key(local, run_cache_key, attempt)
        try:
            status, final_url, remote = fetch(base_url, remote_path(route), cache_key, timeout)
            same_host = urlsplit(final_url).hostname == base_host
            page_font_contract.validate_route_html(route, remote, contract["routes"][route])
            ok = status == 200 and same_host
            return {"path": route, "status": "Passed" if ok else "Failed", "http": status,
                    "sameHost": same_host, "failures": [] if ok else ["HTTP status or production host mismatch"]}
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
            progress.fetch_failure("font_routes", route, exc)
            return {"path": route, "status": "Failed", "failures": [type(exc).__name__ + ": " + str(exc)]}

    progress.start_phase("font_routes", len(contract["fontRoutes"]))
    with ThreadPoolExecutor(max_workers=12) as pool:
        font_routes = list(pool.map(check_font_route, contract["fontRoutes"]))
    progress.end_phase("font_routes")
    failures.extend(f"{item['path']}: {error}" for item in font_routes for error in item["failures"])

    result = {
        "status": "Passed" if not failures else "Failed",
        "baseUrl": base_url,
        "checked": len(checks),
        "failures": failures,
        "checks": checks,
        "fontAssets": font_assets,
        "fontRoutes": font_routes,
    }
    if snapshot_dir:
        snapshot_paths = sorted(
            str(path.relative_to(snapshot_dir))
            for path in snapshot_dir.rglob("*")
            if path.is_file()
        )
        (snapshot_dir / "_snapshot.json").write_text(
            json.dumps({
                "status": result["status"],
                "baseUrl": base_url,
                "attempt": attempt,
                "runCacheKey": run_cache_key,
                "paths": snapshot_paths,
            }, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--attempts", type=int, default=1)
    parser.add_argument("--delay", type=int, default=20)
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument("--report")
    parser.add_argument("--snapshot-dir")
    parser.add_argument("--artifact-root", type=Path, default=Path("_site"),
                        help="Exact emitted public artifact whose publication and page-font manifests are verified")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/") + "/"
    run_cache_key = os.environ.get("GITHUB_RUN_ID") or str(time.time_ns())
    snapshot_dir = Path(args.snapshot_dir).resolve() if args.snapshot_dir else None
    progress = VerificationProgress(args.report)
    # Keep the same network settings/checks/retries; observation is independent.
    handlers = {}
    def interrupted(signum, _frame):
        progress.interrupt(signum)
        raise VerificationInterrupted(signum)
    if threading.current_thread() is threading.main_thread():
        for signum in (signal.SIGTERM, signal.SIGINT):
            handlers[signum] = signal.signal(signum, interrupted)
    result = {}
    exit_code = 1
    try:
        for attempt in range(1, max(args.attempts, 1) + 1):
            progress.start_attempt(attempt)
            result = verify_once(base_url, args.timeout, run_cache_key, attempt,
                                 snapshot_dir, args.artifact_root, progress=progress)
            result["attempt"] = attempt
            progress.finish_attempt(result)
            if result["status"] == "Passed":
                break
            if attempt < args.attempts:
                progress.emit("retry-delay-start", delaySeconds=max(args.delay, 0))
                time.sleep(max(args.delay, 0))
                progress.emit("retry-delay-end")
        exit_code = 0 if result.get("status") == "Passed" else 1
    except (KeyboardInterrupt, VerificationInterrupted) as exc:
        progress.interrupt(getattr(exc, "signum", None))
        result = progress._payload()
        exit_code = 128 + getattr(exc, "signum", signal.SIGINT)
    except Exception as exc:
        progress.exception("verification", exc)
        result = progress._payload()
        exit_code = 1
    finally:
        for signum, handler in handlers.items():
            signal.signal(signum, handler)
    progress.finish(result)
    print(json.dumps(diagnostic_payload(result), ensure_ascii=False, indent=2), flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
