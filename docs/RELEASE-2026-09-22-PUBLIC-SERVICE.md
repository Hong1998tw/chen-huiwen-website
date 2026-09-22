# Public service audit improvements — 2026-09-22

Status: PR #71 deployed at 1eefc6f16021eebf3b8f40a7de83811d80cf5a7d; final production test correction pending.

Scope: user approved audit rows 1–4 and 6–10. Row 5 (online petition destination, permissions, intake and privacy process) is excluded. The existing petition main content and external Notion URL must remain byte-identical to baseline; shared navigation and asset versions may change.

Baseline / rollback: `8319451a6e104dbebe5ca2a4b359185247abd90a` (PR #70). Branch: `fix/public-service-audit-20260922`.

- Homepage retains portrait at the top and adds direct service / construction actions.
- Five native disclosure navigation groups, service first; desktop one open group, mobile expanded groups, keyboard/Escape/focus/inert handling retained.
- Service-intent search entries and correct source-text highlighting offsets.
- Accessible 2026-09 legal schedule transcription, 13 date/time rows visually read from the public Canva original on 2026-09-22. This is a dated schedule, not live availability; original diagram and phone confirmation remain. No attorney identities were transcribed.
- Results-first achievements with progressively disclosed filters, reduced tags and distinct initial topics.
- Latest recorded milestone separated from content editing date. Direct milestone source only when sourceDate matches; otherwise the complete source list. Source dates visible in detail pages.
- Original 2026 platform wording retained. Related public records and missing accountability details clearly labeled without inventing promises or claiming fulfillment.
- About page links to documented public hearings, council questioning and follow-up cases.
- Existing forest / paper palette, serif headings, consistent modest corners, lighter metadata and compact mobile spacing.

Verification checkpoint: seven validators and deterministic rebuild, 53 unit + 4 event tests, 41 full-site browser checks, 25 new public-service checks, six-width sticky navigation (26 checks), lifecycle including 200% text/no-JS, digital/P0/governance/election suites pass. Five-width readiness 60/60. Seven-page mobile Lighthouse Performance 97/99/91/98/98/95/98; Accessibility, Best Practices and SEO all 100 (single local run each, lab evidence). Visual review completed at 390 and 1440 px; do not infer field CWV or physical iPhone proof. Tests that assumed donation-first flat navigation are updated to the approved grouped service-first contract; map tests explicitly select the map, and new tests must assert list-first behavior.

Next: finish visual QA, deterministic quality, browser/accessibility and performance checks; inspect diff; commit/PR/CI/merge; verify Pages and live production independently; archive evidence and update canonical Notion record with native read-back. Do not mark the excluded intake issue resolved.

PR #71 first CI attempt found missing baseline history in the shallow browser checkout and achievements Lighthouse median 89. The checkout now fetches comparison history. The 111 KB map dataset loads separately from readable static cards; a failed fetch preserves all 54 records. Three subsequent local achievements Lighthouse runs score 94/94/94 with all other categories 100. Five viewport map readiness and WebKit sticky navigation pass. Production parity includes the generated dataset, and live browser tests explicitly reveal advanced controls and select map view. Final head CI remains the merge gate.

Post-merge Production HTTP parity passed in GitHub, but the live service test still required the old rules-before-image layout. The follow-up changes only tests: assert the accessible schedule precedes rules and the phone target remains at least 44 px. Fixed-date tests now change Date without freezing loader timers and wait for the schedule enhancement. All website bytes are unchanged in this follow-up.
