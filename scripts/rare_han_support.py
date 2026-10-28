"""Pinned, OFL-licensed two-glyph addition; the TC and JP sources stay intact."""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen

FAMILY = "Huiwen Sans Rare Han Support"
CODEPOINTS = frozenset({0x5754, 0x6DB3})
FONT_SHA256 = "f54454c3ccd0903f631c7e7a639a10805c98addfa689b19c9c8e3e32ebbca156"
FONT_REL = "assets/fonts/huiwen-site-sans/huiwen-rare-han-support-" + FONT_SHA256 + ".woff2"
LICENSE_REL = "assets/fonts/huiwen-site-sans/rare-han-support-OFL.txt"
PROVENANCE_REL = "assets/fonts/huiwen-site-sans/rare-han-support-provenance.json"
LICENSE_SHA256 = "4695fa6dfb6bf178c7509de9214bb61310fa19ac3920639b860a7cb2c1ddb390"
PROVENANCE_SHA256 = "f654fb875ed64dfd72f94566a5f72a61e26ce6fcb940751db6d3ee6bb592b535"
SOURCE_SHA256 = "52565cb369de5f51320250820ae71e259ec58974663b1a5d4de28e0728e4cf52"
PUBLIC_FILES = (FONT_REL, LICENSE_REL, PROVENANCE_REL)


def _bytes(root, relative):
    base = Path(root).resolve()
    path = base / relative
    if path.is_symlink() or not path.is_file() or base not in path.resolve().parents:
        raise ValueError("FONT_RARE_SUPPORT_SOURCE_MISSING_OR_UNSAFE: " + relative)
    return path.read_bytes()


def verified_cmap(root):
    payload = _bytes(root, FONT_REL)
    license_bytes = _bytes(root, LICENSE_REL)
    provenance_bytes = _bytes(root, PROVENANCE_REL)
    if sha256(payload).hexdigest() != FONT_SHA256:
        raise ValueError("FONT_RARE_SUPPORT_HASH_MISMATCH")
    if sha256(license_bytes).hexdigest() != LICENSE_SHA256:
        raise ValueError("FONT_RARE_SUPPORT_LICENSE_MISMATCH")
    if sha256(provenance_bytes).hexdigest() != PROVENANCE_SHA256:
        raise ValueError("FONT_RARE_SUPPORT_PROVENANCE_MISMATCH")
    provenance = json.loads(provenance_bytes)
    if provenance["source"]["sha256"] != SOURCE_SHA256:
        raise ValueError("FONT_RARE_SUPPORT_ORIGINAL_SOURCE_MISMATCH")
    font = TTFont(BytesIO(payload), recalcBBoxes=False, recalcTimestamp=False)
    try:
        cmap = font.getBestCmap() or {}
        if (set(cmap) != CODEPOINTS or "fvar" in font
                or font["OS/2"].usWeightClass != 400
                or font["name"].getDebugName(1) != FAMILY):
            raise ValueError("FONT_RARE_SUPPORT_CMAP_OR_STATIC_FACE_INVALID")
        glyphset = font.getGlyphSet()
        for name in cmap.values():
            pen = BoundsPen(glyphset)
            glyphset[name].draw(pen)
            if pen.bounds is None or pen.bounds[0] >= pen.bounds[2] or pen.bounds[1] >= pen.bounds[3]:
                raise ValueError("FONT_RARE_SUPPORT_EMPTY_OUTLINE")
        return dict(cmap)
    finally:
        font.close()


def parse_face(root, css):
    faces = re.findall(r'@font-face\s*\{[^}]*font-family\s*:\s*["\']' + re.escape(FAMILY) + r'["\'][^}]*\}', css, re.I)
    if not faces:
        return set(), {}
    if len(faces) != 1:
        raise ValueError("FONT_RARE_SUPPORT_FACE_AMBIGUOUS")
    face = faces[0]
    ranges = re.search(r"unicode-range\s*:\s*([^;}]+)", face, re.I)
    source = re.search(r'src\s*:\s*url\(\s*(["\']?)([^"\')]+)\1\s*\)', face, re.I)
    weight = re.search(r"font-weight\s*:\s*([^;}]+)", face, re.I)
    if not ranges or not source or not weight or weight.group(1).strip() != "400":
        raise ValueError("FONT_RARE_SUPPORT_FACE_CONTRACT_INVALID")
    parts = [part.strip() for part in ranges.group(1).split(",")]
    if any(not re.fullmatch(r"U\+[0-9A-Fa-f]{4,6}", part) for part in parts):
        raise ValueError("FONT_RARE_SUPPORT_RANGE_NOT_EXACT")
    declared = {int(part[2:], 16) for part in parts}
    if declared != CODEPOINTS or len(parts) != len(CODEPOINTS):
        raise ValueError("FONT_RARE_SUPPORT_RANGE_INVALID")
    parsed = urlsplit(source.group(2))
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or parsed.path.lstrip("/") != FONT_REL:
        raise ValueError("FONT_RARE_SUPPORT_SOURCE_PATH_INVALID")
    cmap = verified_cmap(root)
    return declared, cmap


def provenance(root):
    verified_cmap(root)
    return {"font": FONT_REL, "sha256": FONT_SHA256, "sourceSha256": SOURCE_SHA256,
            "license": LICENSE_REL, "licenseSha256": LICENSE_SHA256,
            "provenance": PROVENANCE_REL, "provenanceSha256": PROVENANCE_SHA256,
            "codepoints": sorted(CODEPOINTS), "family": FAMILY, "weight": 400}
