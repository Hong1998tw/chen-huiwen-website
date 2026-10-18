"""Keep the shared site contact strip inside a named landmark."""
from html.parser import HTMLParser
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
VOID_ELEMENTS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}
SECTIONING_ELEMENTS = {"article", "aside", "main", "nav", "section"}


class SharedChromeParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.banner_landmarks = 0
        self.topline_count = 0
        self.named_topline_regions = 0
        self.topline_label = None
        self.topline_text = []
        self.topline_links = []
        self.topline_tag = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if attributes.get("role") == "banner":
            self.banner_landmarks += 1
        elif tag == "header" and not any(parent in SECTIONING_ELEMENTS for parent in self.stack):
            self.banner_landmarks += 1

        if "topline" in attributes.get("class", "").split():
            self.topline_count += 1
            self.topline_tag = tag
            self.topline_label = attributes.get("aria-label")
            if tag == "section" and self.topline_label:
                self.named_topline_regions += 1

        if self.topline_tag:
            if tag == "a" and attributes.get("href"):
                self.topline_links.append(attributes["href"])

        if tag not in VOID_ELEMENTS:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data):
        if self.topline_tag:
            self.topline_text.append(data)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index] == tag:
                del self.stack[index:]
                break
        if tag == self.topline_tag:
            self.topline_tag = None


class SharedToplineLandmarkTests(unittest.TestCase):
    def test_every_shared_page_has_one_banner_and_named_topline_region(self):
        pages = [path for path in ROOT.glob("*.html")
                 if "<!-- shared-header:start -->" in path.read_text()]
        self.assertGreater(len(pages), 0, "No shared-header pages found")

        failures = []
        for path in pages:
            parser = SharedChromeParser()
            parser.feed(path.read_text())
            text = " ".join(" ".join(parser.topline_text).split())
            if parser.banner_landmarks != 1:
                failures.append(f"{path.name}: banner count {parser.banner_landmarks}")
            if parser.topline_count != 1:
                failures.append(f"{path.name}: topline count {parser.topline_count}")
            if parser.named_topline_regions != 1:
                failures.append(
                    f"{path.name}: named topline region count {parser.named_topline_regions}"
                )
            if parser.topline_label != "議員與服務資訊":
                failures.append(f"{path.name}: topline label {parser.topline_label!r}")
            if "高雄市議員 · 鳳山區" not in text or "服務專線" not in text or "07-821-2536" not in text:
                failures.append(f"{path.name}: topline content changed")
            if "tel:+88678212536" not in parser.topline_links:
                failures.append(f"{path.name}: service telephone link changed")

        self.assertFalse(
            failures,
            f"{len(failures)} landmark/content issue(s):\n" + "\n".join(failures[:20]),
        )


if __name__ == "__main__":
    unittest.main()
