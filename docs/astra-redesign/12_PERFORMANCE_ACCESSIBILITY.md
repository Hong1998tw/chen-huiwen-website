# Performance, accessibility and SEO

Mobile Lighthouse 13.4.1; default simulated slow 4G / CPU slowdown, cold Chrome, all requests allowed, one run per representative page. Lab evidence, not field Core Web Vitals or statistical baseline improvement. Initial scores:

| Page | Performance | Accessibility | Best practices | SEO |
|---|---:|---:|---:|---:|
| Home | 98 | 100 | 100 | 100 |
| Achievements | 92 | 98 | 100 | 100 |
| Service | 99 | 100 | 100 | 100 |
| Detail | 98 | 100 | 100 | 100 |

Map heading-order warning subsequently corrected (sidebar h2, nested group h3). Final recheck receipt kept separately. Home CLS 0; achievements initial CLS .0054. New production code adds approximately 14KB uncompressed CSS+JS; no production dependencies or external fonts. Portrait lazy and responsive; map retains lazy Leaflet/geometry. Shared generated hash references and service-worker cache version updated.

Semantic heading/source navigation, labels, visible focus, keyboard dialog and menu, text status, 44px controls, reduced-motion, no-JS list fallback and print rules. 390px and text resizing tested. Not a WCAG conformance certification; no real assistive-device session.

All existing indexed route names retained. Canonical/OG/Twitter/JSON-LD/sitemap validators retained. Search rebuilt from final HTML; metadata claims unchanged. 404 keeps noindex and now recovers same-origin at nested paths. No Search Console or remote indexing claim.

## Final acceptance

After heading-order and accessible-name corrections: home 98/100/100/100; achievements 92/100/100/100; service 99/100/100/100; detail 98/100/100/100 (performance/accessibility/best practices/SEO). One cold mobile run per page. CLS: home 0.000086, achievements 0.01066, service/detail 0. No runtime errors; prior label/heading findings resolved. No production service-worker or edge measurement. Raw final receipts are separate from initial measurements.
