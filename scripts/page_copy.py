"""Instrument public page copy for the authenticated, same-page CMS editor."""
from __future__ import annotations

import hashlib
import html
import re
from html.parser import HTMLParser

EDITABLE = {"h1", "h2", "h3", "h4", "p", "li", "blockquote", "figcaption", "dt", "dd"}
EXCLUDED = {"nav", "header", "footer", "button", "form", "script", "style", "svg", "select", "textarea"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class PageCopy(HTMLParser):
    """Preserve original markup while marking plain-text blocks with stable DOM paths."""

    def __init__(self, source: str, path: str, edits: dict[str, dict] | None = None):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.path = path
        self.edits = edits or {}
        self.stack: list[dict] = []
        self.children: dict[int, dict[str, int]] = {0: {}}
        self.line_offsets = [0]
        for line in source.splitlines(keepends=True):
            self.line_offsets.append(self.line_offsets[-1] + len(line))
        self.ranges: list[tuple[int, int, str]] = []
        self.fields: list[dict[str, str]] = []
        self.in_main = False
        self.count = 0
        self.seen: set[str] = set()

    def get_offset(self) -> int:
        line, col = self.getpos()
        return self.line_offsets[min(line - 1, len(self.line_offsets) - 1)] + col

    def handle_starttag(self, tag, attrs):
        start = self.get_offset()
        raw = self.get_starttag_text()
        inner = start + len(raw)
        parent = self.stack[-1] if self.stack else None
        is_main = tag == "main" or bool(parent and parent["in_main"])
        if tag == "main" and not (parent and parent["in_main"]):
            key = "main"
        elif is_main:
            parent_key = parent["key"] if parent and parent["in_main"] else "main"
            sibling_counts = self.children.setdefault(id(parent) if parent else 0, {})
            sibling_counts[tag] = sibling_counts.get(tag, 0) + 1
            key = f"{parent_key}>{tag}:nth-of-type({sibling_counts[tag]})"
        else:
            key = ""
        excluded = tag in EXCLUDED or bool(parent and parent["excluded"])
        node = {"tag": tag, "key": key, "in_main": is_main, "excluded": excluded,
                "has_element": False, "start": start, "inner": inner, "attrs": dict(attrs)}
        if parent:
            parent["has_element"] = True
        if tag not in VOID:
            self.stack.append(node)
            self.children[id(node)] = {}

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        pos = self.get_offset()
        target = next((node for node in reversed(self.stack) if node["tag"] == tag), None)
        if target is None:
            return
        while self.stack:
            node = self.stack.pop()
            if node is target:
                self.finish_node(node, pos)
                break

    def finish_node(self, node, pos):
        if not (node["in_main"] and not node["excluded"] and not node["has_element"] and node["tag"] in EDITABLE):
            return
        if "contenteditable" in node["attrs"]:
            return
        key = node["key"]
        self.seen.add(key)
        raw_text = self.source[node["inner"]:pos]
        source_text = html.unescape(raw_text)
        visible_hash = digest(source_text)
        attrs = node["attrs"]
        existing_key = attrs.get("data-cms-edit-id")
        existing_source = attrs.get("data-cms-source-hash")
        existing_value = attrs.get("data-cms-value-hash")
        key_changed = bool(existing_key and existing_key != key)
        if key_changed and (existing_key in self.edits or key in self.edits):
            raise ValueError("CMS page structure changed; target identity differs: " + self.path)
        if existing_source and not re.fullmatch(r"[a-f0-9]{64}", existing_source):
            raise ValueError("CMS source marker is invalid: " + self.path)
        if existing_value and not re.fullmatch(r"[a-f0-9]{64}", existing_value):
            raise ValueError("CMS value marker is invalid: " + self.path)
        if key_changed:
            source_hash = visible_hash
        elif existing_source and existing_value and existing_value != visible_hash:
            if key in self.edits:
                raise ValueError("CMS source changed; reload the published page before editing: " + self.path)
            source_hash = visible_hash
        else:
            source_hash = existing_source or visible_hash
        edit = self.edits.get(key)
        rendered = raw_text
        if edit is not None:
            if not isinstance(edit, dict) or edit.get("sourceHash") != source_hash or not isinstance(edit.get("value"), str):
                raise ValueError("CMS source changed; reload the published page before editing: " + self.path)
            value = edit["value"]
            if len(value) > 4000 or any(ord(c) < 32 and c not in "\n\t" for c in value):
                raise ValueError("CMS page copy contains unsupported text: " + self.path)
            rendered = html.escape(value, quote=False)
        value_hash = digest(html.unescape(rendered))
        self.fields.append({"id": key, "sourceHash": source_hash, "valueHash": value_hash})
        raw_tag = self.source[node["start"]:node["inner"]]
        opening = re.sub(
            r'\sdata-cms-(?:edit-id|source-hash|value-hash)=(?:"[^"]*"|\'[^\']*\'|[^\s>]+)',
            "",
            raw_tag,
            flags=re.I,
        )
        self.ranges.append((node["start"], node["inner"], opening))
        if rendered != raw_text:
            self.ranges.append((node["inner"], pos, rendered))
        self.count += 1

    def result(self) -> str:
        self.feed(self.source)
        self.close()
        edits = sorted(self.ranges, key=lambda item: item[0])
        parts = []
        cursor = 0
        for start, end, replacement in edits:
            if start < cursor:
                raise ValueError("Overlapping page copy ranges: " + self.path)
            parts.append(self.source[cursor:start])
            parts.append(replacement)
            cursor = end
        parts.append(self.source[cursor:])
        result = "".join(parts)
        if self.count:
            loader = (
                "<script data-cms-editor-loader>"
                "if(window.self!==window.top&&(document.currentScript?.dataset.cmsEditorEnabled==='true'||new URLSearchParams(location.search).get('cmsEdit')==='1'))"
                "document.write('<scr'+'ipt defer src=\"/cms-page-editor.js\"></scr'+'ipt>');"
                "</script>"
            )
            existing_loader = re.search(r"<script\b[^>]*data-cms-editor-loader[^>]*>.*?</script>", result, re.I | re.S)
            if existing_loader:
                if existing_loader.group(0) == loader:
                    return result
                return result[:existing_loader.start()] + loader + result[existing_loader.end():]
            result = re.sub(r'<script\b[^>]*src=["\']/cms-page-editor\.js(?:\?[^"\']*)?["\'][^>]*>\s*</script>\s*', "", result, count=1, flags=re.I)
            result, count = re.subn(r"</head\s*>", loader + "\n</head>", result, count=1, flags=re.I)
            if count != 1:
                raise ValueError("CMS editor needs a closing head element: " + self.path)
        # Every saved field must still exist and match; stale selectors fail closed.
        if set(self.edits) - self.seen:
            raise ValueError("CMS page structure changed; saved text targets no longer exist: " + self.path)
        return result


def render_with_manifest(
    source: str, path: str, edits: dict[str, dict] | None = None
) -> tuple[str, int, list[dict[str, str]]]:
    parser = PageCopy(source, path, edits)
    result = parser.result()
    return result, parser.count, parser.fields


def render(source: str, path: str, edits: dict[str, dict] | None = None) -> tuple[str, int]:
    result, count, _ = render_with_manifest(source, path, edits)
    return result, count
