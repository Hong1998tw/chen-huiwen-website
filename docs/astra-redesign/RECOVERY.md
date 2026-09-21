# Recovery

Repository Path: current Git worktree (resolve with `git rev-parse --show-toplevel`).
Branch: astra/huiwen-redesign-202609
Baseline: 5aeddfd1c1517fd35c5ea62627fbd4fac1d739d6

Read CURRENT_STATE.md, CURRENT_STATE.json, README.md, docs/CANONICAL-SOURCE.md, docs/CONTENT-SOURCES.md and docs/MAINTENANCE.md first.

Preview: `python3 -m http.server 8765 --bind 127.0.0.1`
Build and tests: `python3 scripts/quality.py --baseline-ref origin/main`
Browser: existing `tests/donation/*.mjs`; install using `npm ci --ignore-scripts --prefix tests/donation`.

Architecture: Python generated static HTML, vanilla CSS/JS, Leaflet. Thesis pending.
No push, PR, merge, deploy, Notion writes or Drive original changes authorized.
Exact next action: baseline audit and benchmark.
