# Current site audit · 2026-09-22

Scope: live homepage and achievements inspected in browser; remaining route structures read from current main and captured locally at 1440/390. Local capture is not a production proof. Baseline 5aeddfd. Deterministic quality PASS before edits.

| Surface | Observation | Decision |
|---|---|---|
| Home | Portrait/slogan then donation account; service and content discovery below. | REBUILD task-first entry, preserve original slogan/account facts elsewhere on page |
| Navigation | Twelve equally weighted links; search dynamically injected. Mobile menu supports Escape/inert. | EVOLVE visual hierarchy; retain menu/accessibility implementation and stable destinations |
| About | Existing verified profile and public links. | KEEP content, EVOLVE reading system |
| Service / petition | Public contact, reservation instructions, Canva schedule, external allowlisted intake. | EVOLVE immediate service choices and clear preparation; KEEP external intake boundary |
| Achievements | 54 public detail routes; six filters, paginated list, Leaflet, 75 village boundaries. | EVOLVE list/map switch and source-oriented detail navigation |
| Detail | Main narrative, sidebar facts, photos, timeline and source links. | EVOLVE anchors, date semantics, reading measure; KEEP claims and attribution |
| News / press | Distinct source indexes, multi-topic tags, pagination. | KEEP distinction, EVOLVE common editorial styling |
| Activities / gallery | Existing dated public records, image assets. | KEEP content; shared visual system |
| Vision / election / donation | Historical platforms and regulated information already have dedicated routes. | KEEP factual content and URLs; no persuasion optimization |
| Search / explore | Local index from public HTML, keyboard dialog, topic/village cross-content routes. | EVOLVE expose discovery on home and provide public directory fallback |
| Footer / 404 | Public contacts, external services and recovery links. | KEEP destinations, align common reading rhythm |

## Source capability
Python static generation; no framework needed. `data/achievements.json` has stable IDs, categories, village/scope, reviewed status, coordinates, history, sources, image provenance and updated date. Public inclusion uses `is_public`; coordinates are representative points. `updated` is content update, NOT fresh verification. No authoritative 3D geometry or case-status authentication exists.

## Access and privacy
Current Notion maintenance, editorial policy and achievement schema read; private registry rows not imported. Drive `03_工作/網站` metadata read: current/source/docs/releases/archive; legacy bytes are not canonical. Repository has no AGENTS.md/ROUTER.md. User-supplied instructions apply. Original checkout untracked `.ai/` retained. Current remote ref was verified using ls-remote and explicit fetch refspec.

## Risks
Legacy public records contain 11 attribution warnings. No new factual publication or recertification is implied. Third-party iframe behavior depends on provider. Preserve exact public-link allowlist; no public case database or real submission.
