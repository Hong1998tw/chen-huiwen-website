# Functional QA

Baseline deterministic quality passed before edits. Final command receipts stored in local artifact bundle; this document records scope, not remote CI status.

- Data/build: schema, IDs, all local links/anchors, metadata, JSON-LD, sitemap, generated-content two-build equality, public copy and exact private-link allowlist.
- Unit mutation checks: unpublished home ID rejected; canonical title changes propagate escaped into home; existing broken-link/schema/private-URL/stale-output rejection retained.
- Existing browser suites: browser, digital-civic, p0, achievement-governance, election-mode, lifecycle.
- New civic browser suite: 14 routes at 1440/390, zero horizontal overflow and axe WCAG A/AA issues; search, list/map preservation, locate restoration, reading anchors, nested 404 same-origin style/navigation/search, 200% text.
- Existing lifecycle: 320/390/768/1280/1440 no-JS reflow, reduced-motion, blocked search fallback, typo normalization, image-failure service access and mobile focus/menu.

Resolved test/environment findings: legacy homepage H1/portrait-size assertions replaced with task-first hierarchy + retained-profile assertions; absolute/root-relative destinations verified semantically; three test runners used URL.pathname as filesystem cwd, fixed to fileURLToPath for spaces/Chinese paths. 404 validators now resolve root-relative URLs without filesystem-root confusion, and still reject nonexistent destinations.

External links: Python urllib could not establish transport; no certificate bypass. Native curl followed redirects with normal TLS and returned 200 for Canva, LINE, public intake, Google Maps and Facebook. Official photo source fetched independently through web tool. HTTP reachability does not prove submissions, appointment availability or iframe success. No forms or payment submitted.

Final fixes found by full regression: service contact grid now permits shrinking and long-address wrapping at 200% text; homepage election link uses its visible text as accessible name. Prior failed logs were intermediate findings, not acceptance receipts. Final acceptance requires the complete quality command plus final civic report.
