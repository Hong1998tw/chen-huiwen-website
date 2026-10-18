# Visual QA

Baseline: 1440×960 and 390×844 screenshots of home, map, detail, service, news, intake, exploration and 404 from clean main. Production home/map separately observed. Cropped native-IAB desktop captures were rejected; full Chromium captures are the review evidence.

Round 1: editorial hierarchy clear; local search and service phone available near entry. Detail source/history links readable. Issues: service hero had an unrelated ornamental circle; profile portrait still requested large high-priority asset after moving below fold; initial feature without a source photograph made the two-column reading area uneven; 404's production base caused unstyled local rendering.

Round 2: removed ornament, lazy low-priority portrait with accurate 104/180px sizes, selected an existing photographed public project with original caption/credit/source link, fixed same-origin nested 404 recovery. No generated/fabricated city image. Original project facts and political wording preserved.

Round 3/final: visually reviewed `artifacts/astra-redesign/screenshots/final-*`: desktop/mobile home, reading, detail, service, map, list, news, intake, exploration and 404. The map has an equivalent record list; source captions and date semantics remain visible. Automated geometry and contrast checks complement visual review; they are not screen-reader certification.

Final map screenshots show loaded OpenStreetMap tiles, actual village geometry and recorded points at both widths. Capture waits for a visible marker rather than the zero-size Leaflet positioning pane. Final home accessible-name correction is nonvisual.

## A-05: repeatable capture and approved-baseline comparison

`tests/donation/visual-qa-policy.json` selects 15 existing routes, including three pages generated from the existing achievement-detail template. Each route is captured at 390×844 and 1440×960, for 30 screenshots. The runner does not generate replacement pages or alter public UI.

The 15 routes are `index.html`, `achievements.html`, `achievement-metro-green-line.html`, `achievement-wende-school-center.html`, `achievement-special-education-support.html`, `news.html`, `news-20260915-special-education-nurse.html`, `activities.html`, `event-campaign-headquarters-opening-2026-10-31.html`, `gallery.html`, `service.html`, `petition.html`, `election.html`, `explore.html` and `404.html`.

CI produces exactly 30 PNG screenshots from the checked-out source in the local capture. A separate Cloudflare run measures the same route/viewport pairs without creating extra screenshots, keeping candidate visual comparisons tied to the current source while retaining production transport evidence.

The two separately labelled runs are:

- `local-http-uncompressed` serves the checked-out source from the existing static runner with compression disabled. Third-party requests are recorded separately and are not included in the same-origin page budget.
- `cloudflare-production-br` opens the public site in Chromium and records network/DOM JSON only. The report marks Cloudflare and Brotli verified only when the document response exposes a Cloudflare response header and `Content-Encoding: br`. This is a read-only browser request; it does not configure Cloudflare.

Each PNG has a JSON record with its route, viewport, source SHA, runner and browser versions, fixed Taiwan timezone/date, fresh-context initial request, font readiness, animation handling, DOM element count, response status, and request list. `PerformanceResourceTiming.transferSize` is recorded separately from CDP `Network.loadingFinished.encodedDataLength`; encoded and decoded resource sizes are never substituted for each other. Third-party Performance Timing may be zero when the origin does not grant timing access, so the CDP encoded byte count is retained separately. The 300,000-byte measurement uses same-origin `transferSize` (including the document request), with a clearly labelled CDP fallback only if Timing reports zero. The JSON also preserves raw transfer and encoded byte totals and the third-party totals.

Capture conditions use fresh contexts with cache and service workers disabled, `zh-TW`, `Asia/Taipei`, light color scheme, reduced motion, device scale factor 1, and a fixed date. The runner waits for the navigation `load` event, `document.fonts.ready`, and visible images to decode, then finishes active animations before taking the viewport screenshot with Playwright animation suppression. It applies no dynamic masks. Local screenshots are always `CAPTURE_ONLY`; Cloudflare runs are `MEASUREMENT_ONLY`. Zero pixel differences or being below a budget cannot turn a capture into a regression pass.

The initial budgets are 300,000 same-origin transfer bytes and 1,500 DOM elements. They are observations until an independent reviewer approves an exact 30-image baseline manifest. Only an `APPROVED` manifest with a separate expected SHA-256, matching source SHA, complete approval record, and verified image hashes can be compared. The compare command writes a per-capture pixel diff PNG, changed-pixel count and ratio, dimensions, transfer/DOM comparison, and a machine-readable report. Its default pixel sensitivity is 0.1 and maximum changed-pixel ratio is 0.5%; a dimension change always fails. It never updates or accepts a baseline.

The candidate exception list is limited to achievements, gallery and event routes. A prior achievements report described 6,380 DOM elements in relation to pagination; that historical value is not a measurement of this checkout and is not embedded as a budget exception. The current CI capture must provide the measured value. Gallery and event values also require fresh evidence. Any exception in an approved manifest must name the exact capture and metric, reproduce the measured value, include the reason, point to its JSON evidence, and state a concrete resolution task. A later capture that brings an excepted metric under its limit marks the baseline `STALE_BASELINE` and requires renewed independent review.

Commands used by CI (and for the next capture-only collection):

```sh
npm ci --ignore-scripts --prefix tests/donation
bash scripts/install_playwright_ci.sh
npm run test:visual-qa --prefix tests/donation
node tests/donation/visual-qa.mjs capture --environment local-http-uncompressed
node tests/donation/visual-qa.mjs capture --environment cloudflare-production-br --base-url https://www.huiwen.tw/
node tests/donation/visual-qa.mjs compare --candidate-manifest tests/donation/results/visual-qa/local-http-uncompressed/manifest.json
```

With no approved baseline, the compare command writes `PENDING` and exits without claiming a pass. After independent approval, CI can receive the manifest path, its exact SHA-256, and source SHA through the three optional `VISUAL_QA_BASELINE_*` repository variables; leaving all three empty keeps comparison pending. Supplying an incomplete or mismatched set is rejected. Browser capture itself runs in the existing GitHub CI job; this worktree does not start a local browser or approve a baseline.
