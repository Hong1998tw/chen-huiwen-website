# Recovery

BUILD STATUS: COMPLETE (release candidate; deployment state is recorded in the release receipt).
Branch: `astra/huiwen-redesign-202609`
Baseline: `5aeddfd1c1517fd35c5ea62627fbd4fac1d739d6`
Verified implementation checkpoint: `31a111db337bd3ca6aa1ac07101e099c920f630e`
Final checkpoint: `git rev-parse HEAD` on the branch; final exact SHA and absolute repository locator are in the delivery package FINAL_RECEIPT.json. This file is part of that final commit.

Repository: resolve `git rev-parse --show-toplevel` from this worktree. The separate delivery report records the absolute path, keeping workstation paths out of public source documentation.

Read CURRENT_STATE.md/json, 05_PRODUCT_THESIS.md, 08_DATA_ARCHITECTURE.md, README.md, docs/CANONICAL-SOURCE.md, docs/CONTENT-SOURCES.md and docs/MAINTENANCE.md. Audit/research/concepts are complete; do not restart them.

## Reproduce

Python environment used: sibling `../qa-venv` with beautifulsoup4 and html5lib. Node v22.19.0. Browser dependencies locked under tests/donation; `npm ci --ignore-scripts --prefix tests/donation` if needed. Playwright Chromium must be installed.

```sh
python3 -m http.server 8766 --bind 127.0.0.1
# separate terminal, same repository
../qa-venv/bin/python scripts/quality.py --baseline-ref origin/main --browser
ROUND=final node tests/donation/astra.mjs
CAPTURE_LABEL=final node tests/donation/astra-capture.mjs
RUNS=1 PAGES=index.html,achievements.html,service.html,achievement-metro-green-line.html LABEL=astra-final node tests/donation/readiness-performance.mjs
```

Build order: build_cases.py → build_platforms.py → build_events.py → build_search.py (invokes civic generation). Source IDs in data/civic-home.json; titles/status/photos come from public achievements. Do not edit generated detail prose independently. CSS shared across main routes; no new production dependency.

Acceptance: quality-complete.log final PASS; qa-final.json 61 PASS; four Lighthouse acceptance rows true. Screenshots and raw receipts live outside deploy source in the delivery package; local artifacts path is ignored.

Bundle is incremental from the exact baseline above, not a complete clone. In an existing repository containing that baseline: `git bundle verify /path/to/huiwen-redesign.bundle`, then fetch the named branch from that local file into a new recovery branch/worktree. Do not reset the original checkout. Verify receipt SHA and checksums first.

Next action: use the release receipt for the current deployment and Notion closeout. No DNS, registry edits or external submissions are implied by this website release.
