# Production-readiness PR evidence — 2026-09-16

These files are review evidence for this Draft PR. They are not political-content sources and must not be treated as production verification.

## Browser evidence

- Chromium 140: 390, 430, 768, 1024, 1440 px; representative page set; axe WCAG 2.2 AA; zero page errors, console errors, failed requests, HTTP errors, or horizontal overflow in the final run.
- WebKit 26: 390, 768, 1440 px on homepage, about, achievements, news, political donation, service, explore, and 404; final run passed.
- Readiness gate enforces CLS < 0.1 per tested page/viewport.

## Lighthouse lab medians

| Page | Performance before | Performance after | A11y after | Best Practices after | SEO after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Home | 99 | 99 | 100 | 100 | 100 |
| About | 100 | 100 | 100 | 100 | 100 |
| Achievements | 78 | 92 | 100 | 100 | 100 |
| Vision | 99 | 99 | 100 | 100 | 100 |
| News | 98 | 98 | 100 | 100 | 100 |
| News article | 97 | 97 | 100 | 100 | 100 |
| Political donation | 99 | 99 | 100 | 100 | 100 |

Method: default mobile Lighthouse lab settings, cold Chromium per run, three runs per page, median acceptance. These are local candidate measurements and do not include Cloudflare edge behavior or field Core Web Vitals.
