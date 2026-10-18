"""Keep the first exact long paragraph in a single rendered case page."""
import re
import unicodedata


MIN_DUPLICATE_LENGTH = 40


def normalize_paragraph(text):
    """Normalize Unicode and whitespace without erasing factual qualifiers."""
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFC', str(text))).strip()


class ParagraphDeduper:
    """Track long paragraph text in document order for one rendered page."""

    def __init__(self):
        self._seen = set()

    def keep(self, text):
        normalized = normalize_paragraph(text)
        if len(normalized) <= MIN_DUPLICATE_LENGTH:
            return True
        if normalized in self._seen:
            return False
        self._seen.add(normalized)
        return True
