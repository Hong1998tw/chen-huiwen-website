# Visual QA

Baseline: 1440×960 and 390×844 screenshots of home, map, detail, service, news, intake, exploration and 404 from clean main. Production home/map separately observed. Cropped native-IAB desktop captures were rejected; full Chromium captures are the review evidence.

Round 1: editorial hierarchy clear; local search and service phone available near entry. Detail source/history links readable. Issues: service hero had an unrelated ornamental circle; profile portrait still requested large high-priority asset after moving below fold; initial feature without a source photograph made the two-column reading area uneven; 404's production base caused unstyled local rendering.

Round 2: removed ornament, lazy low-priority portrait with accurate 104/180px sizes, selected an existing photographed public project with original caption/credit/source link, fixed same-origin nested 404 recovery. No generated/fabricated city image. Original project facts and political wording preserved.

Round 3/final: visually reviewed `artifacts/astra-redesign/screenshots/final-*`: desktop/mobile home, reading, detail, service, map, list, news, intake, exploration and 404. The map has an equivalent record list; source captions and date semantics remain visible. Automated geometry and contrast checks complement visual review; they are not screen-reader certification.

Final map screenshots show loaded OpenStreetMap tiles, actual village geometry and recorded points at both widths. Capture waits for a visible marker rather than the zero-size Leaflet positioning pane. Final home accessible-name correction is nonvisual.

## A-05: repeatable capture and approved-baseline comparison

`tests/donation/visual-qa-policy.json` selects 15 existing routes, including three pages generated from the existing achievement-detail template. Each route is captured at 390×844 and 1440×900, for 30 screenshots. The runner does not generate replacement pages or alter public UI. This A-05 matrix follows the G03/report desktop size; the earlier 1440×960 redesign-review captures above remain historical evidence.

The 15 routes are `index.html`, `achievements.html`, `achievement-metro-green-line.html`, `achievement-wende-school-center.html`, `achievement-special-education-support.html`, `news.html`, `news-20260915-special-education-nurse.html`, `activities.html`, `event-campaign-headquarters-opening-2026-10-31.html`, `gallery.html`, `service.html`, `petition.html`, `election.html`, `explore.html` and `404.html`.

CI produces exactly 30 PNG screenshots from each checkout's source-native Cloudflare publication artifact. The clean Git checkout supplies `sourceGitSHA`; `--public-artifact` supplies the only HTTP server root. A separate Cloudflare run measures the same route/viewport pairs without creating extra screenshots, keeping candidate visual comparisons tied to the current publication while retaining production transport evidence.

The two separately labelled runs are:

- `local-http-uncompressed` serves a verified publication artifact with compression disabled when `--public-artifact` is supplied; the canonical Git-root mode remains available for reference captures and is labelled `git-canonical-root`. A-05 cross-source and baseline comparisons reject mixed source kinds. Third-party requests are recorded separately and are not included in the same-origin page budget.
- `cloudflare-production` opens the public site in Chromium and records network/DOM JSON only. It reads the live `/deployment.json` receipt before and after all 30 cases, recording `sourceCommit` and `publicArtifactDigest` separately from the runner's `checkoutSHA`. A changed receipt marks the run `MIXED_DEPLOYMENT`; the live version is never attributed to the checkout. Each document records its actual `Content-Encoding` and encoded bytes. `br`, `gzip`, identity, and other syntactically valid encodings receive their own environment labels; only a `br` response is labelled Brotli. A non-`br` response is valid evidence and does not fail capture. This is a read-only browser request; it does not configure Cloudflare.

Each PNG has a JSON record with its route, viewport, `checkoutSHA`, runner and browser versions, fixed Taiwan timezone/date, fresh-context initial request, font readiness, animation handling, DOM element count, expected and actual HTTP status, first-party page errors, visible image decode results, and request list. `PerformanceResourceTiming.transferSize` is recorded separately from CDP `Network.loadingFinished.encodedDataLength`; encoded and decoded resource sizes are never substituted for each other. Third-party Performance Timing may be zero when the origin does not grant timing access, so the CDP encoded byte count is retained separately. The 300,000-byte measurement uses same-origin `transferSize` (including the document request), with a clearly labelled CDP fallback only if Timing reports zero. The JSON also preserves raw transfer and encoded byte totals by content encoding and third-party totals. First-party HTTP errors, page errors, failed same-origin requests and visible same-origin images that fail decoding make capture incomplete. Third-party and authentication/blocked-request failures remain separately recorded and do not mask or get counted as local product failures.

Capture conditions use fresh contexts with cache and service workers disabled, `zh-TW`, `Asia/Taipei`, light color scheme, reduced motion, device scale factor 1, and a fixed date. The runner waits for the navigation `load` event, `document.fonts.ready`, and visible images to decode, then finishes active animations before taking the viewport screenshot with Playwright animation suppression. It applies no dynamic masks. Local screenshots are always `CAPTURE_ONLY`; Cloudflare runs are `MEASUREMENT_ONLY`. Zero pixel differences or being below a budget cannot turn a capture into a regression pass.

The initial budgets are 300,000 same-origin transfer bytes and 1,500 DOM elements. They remain observations until an independent reviewer approves an exact 30-image baseline manifest; no over-budget exception becomes a hard gate before that evidence is measured and reviewed. Only an `APPROVED` manifest with a separate expected SHA-256, matching baseline checkout SHA, complete approval record, and verified image and metadata hashes can be compared. The compare command also requires matching environment label, capture scope, and transfer measurement source. It writes a per-capture pixel diff PNG, changed-pixel count and ratio, dimensions, transfer/DOM comparison, and a machine-readable report. Its default pixel sensitivity is 0.1 and maximum changed-pixel ratio is 0.5%; a dimension change always fails. It never updates or accepts a baseline.

The candidate exception list is limited to achievements, gallery and event routes. A prior achievements report described 6,380 DOM elements in relation to pagination; that historical value is not a measurement of this checkout and is not embedded as a budget exception. The current CI capture must provide the measured value. Gallery and event values also require fresh evidence. Any exception in an approved manifest must name the exact capture and metric, reproduce the measured value, include the reason, point to its JSON evidence, and state a concrete resolution task. A later capture that brings an excepted metric under its limit marks the baseline `STALE_BASELINE` and requires renewed independent review.

Commands used by CI (and for the next capture-only collection):

```sh
npm ci --ignore-scripts --prefix tests/donation
bash scripts/install_playwright_ci.sh
npm run test:visual-qa --prefix tests/donation
node tests/donation/visual-qa.mjs capture --environment local-http-uncompressed
node tests/donation/visual-qa.mjs capture --environment cloudflare-production --base-url https://www.huiwen.tw/
node tests/donation/visual-qa.mjs compare --candidate-manifest tests/donation/results/visual-qa/local-http-uncompressed/manifest.json
```

For a publication-artifact screenshot capture, first run the source checkout's own publisher to a separate directory, then pass that directory to the capture runner:

```sh
python scripts/build_cloudflare_public.py --output /tmp/a05-publication
node tests/donation/visual-qa.mjs capture \
  --environment local-http-uncompressed \
  --public-artifact /tmp/a05-publication
```

With no approved baseline configured, the compare command writes `PENDING` and exits without claiming a pass. After an independent review, the approved bundle must be uploaded as the same-repository GitHub Actions artifact named `a05-approved-baseline`, with `manifest.json`, `manifest.sha256`, and exactly 30 root-level PNG/JSON pairs. CI reads `VISUAL_QA_BASELINE_ARTIFACT_ID`, `VISUAL_QA_BASELINE_SHA256`, and `VISUAL_QA_BASELINE_SOURCE_SHA`; this change does not configure any repository variables. The visual-QA job uses `GITHUB_REPOSITORY` plus the numeric artifact ID to call the fixed same-repository GitHub artifact API. Its step-scoped `GITHUB_TOKEN` has `actions:read`; it accepts no arbitrary repository or URL. The download fails closed on missing/expired artifacts, ZIP path/size problems, manifest or image hash mismatches, and incomplete capture sets. If all three variables are empty, comparison remains `PENDING`; if only some are set, the job fails. No baseline is created or approved by this workflow.

A-05 capture and comparison run in a separate bounded 25-minute job so the original 18-minute browser/accessibility gate retains its full test list and deadline. The existing Lighthouse job is unchanged. The A-05 300,000-byte and 1,500-element thresholds are not hard gates before an independently approved, measured baseline exists. Browser capture was not run locally for this change; CI performs the 30 local screenshots and 30 live measurements.
