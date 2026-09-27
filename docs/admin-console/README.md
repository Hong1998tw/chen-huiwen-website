# Editorial Operations Console QA

The screenshots in `screenshots/` were captured from a local authenticated Worker + D1 test fixture. They are not Production captures. The fixture uses actual frontend assets and API routes, an owner Access test assertion, and local publication records. The public-page iframe and homepage data are deterministic browser fixtures so the test never mutates Production.

Required views: `desktop-dashboard.png`, `desktop-content.png`, `desktop-seo.png`, `desktop-publishing.png`, `desktop-activity.png`, `mobile-content-390.png`, `mobile-page-drawer-390.png`, and `mobile-editor-390.png`. Additional `viewport-*.png` files record 390 × 844, 430 × 932, 768 × 1024 and 1440 × 900 runs.

Run `CMS_BROWSER=1 CMS_SCREENSHOTS=../docs/admin-console/screenshots node tests/integration.mjs` from `admin/` to reproduce. This test checks page search and selection, tab switching, drawer close and focus return, command search and Escape, iframe sandbox, dirty state, release stages, overflow and sticky toolbar. It also runs axe WCAG 2A/AA and 2.1 A/AA tags on dashboard and content at 390 and 1440 pixels. `editor-order.mjs` covers keyboard-compatible ordering, compact dates, draft save, and event change review; `home-order.mjs` covers homepage story ordering and page change review.

The release chain reads the publisher's explicit layer values when available. Missing layer data displays `NOT CHECKED`, and `BLOCKED` Native verification does not imply a pass. The source-health count is a count of entered public URLs; it does not attest that a linked claim is true. HSTS was **NOT OBSERVED** in anonymous `admin.huiwen.tw` and `www.huiwen.tw` response headers on 2026-09-27; no edge configuration was changed.
