# Implementation log

2026-09-22 / CP-06 first runnable implementation:
- Added static task-first homepage, visible local search, service desk and generated public reading selection.
- `data/civic-home.json` stores stable IDs only; `build_civic.py` rejects non-public selections and derives every preview from canonical achievement records.
- Existing build_search entry now completes shared civic asset versioning before indexing final HTML. No hosting/dependency change.
- Added explicit map+list/list-only controls, preserving query and restoring map on locate.
- Generated detail pages now offer source/history anchors and content update date distinct from fact verification.
- Service page routes users to existing contact, consultation and intake entries.
- Shared editorial layer applies to all main public routes. Original political wording retained in smaller profile context; donations, election and external intake unchanged.
- Baseline and candidate deterministic quality PASS: 51 unit tests plus 4 event tests, all validators and two-build consistency.
- Browser, axe and mobile round in progress. No production effect.
