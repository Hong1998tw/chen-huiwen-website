# Homepage small Q companion

The owner-approved five-pose AI cartoon is one consistent visual identity: idle, wave, nod, happy and guide. These are illustrations with finite CSS movement, not documentary photos or complete hand-drawn animation. Keep the same face, hair, light-blue shirt and proportions for future uses; do not regenerate a replacement without approval.

## Automatic homepage behavior

The owner's October 2, 2026 direction removes visitor settings and action selection. The public component has no settings panel or action chooser. Only a small accessible dismiss button remains; dismissal lasts for the current page visit, without storage or a restore toolbar.

- First time the companion is visible: wave for 1.8 seconds, once, then static idle.
- First eligible view of the existing projects section (30% intersection): guide for 2.4 seconds, once, then idle. The unchanged source pose is mirrored only in CSS to point inward from the desktop right corner.
- Explicit click of an existing homepage topic filter: nod for 1.5 seconds, then idle.
- First eligible view of the existing contact section (30% intersection): happy for 1.7 seconds, once, then idle. This is a friendly closing gesture, not a claim that a service request was submitted.
- All gestures share a 12-second minimum interval. Suppressed gestures are not queued. Idle never loops. Every gesture is shorter than 5 seconds.
- Reduced motion keeps static idle. Leaving the companion's viewport or hiding the browser tab returns to idle; hidden/background gestures do not run. Open navigation/native dialogs conceal the companion; print excludes it.

## Placement and boundaries

Desktop image is 128 CSS px in the right corner. Up to 780px wide, the 96px character sits in normal flow after the hero; it never overlays service copy or the mobile service bar. Contextual gestures are suppressed while that inline companion is offscreen. No audio, tracking, storage, third-party requests or data collection. Other routes remain unchanged.

The same five transparent 320px WebP files total 89,946 bytes. Load only the selected pose; load the companion stylesheet after primary window load, before revealing the character. If initial style/image loading fails or JavaScript is disabled, the companion remains absent and the main site works.

## Source and verification

An initially hidden aside in index.html is outside generated regions and is relocated after the hero by progressive enhancement. The existing public artifact allowlist explicitly includes small-q.js and small-q.css. verify_production.py explicitly fetches and hash-verifies the deferred CSS before live-snapshot browser QA. CMS keeps its existing text/structured-content scope, without arbitrary script injection or a new publisher.

Run node --check small-q.js, existing canonical quality/build and full-site CI, and tests/donation/small-q.mjs. Focused browser coverage includes four widths, finite automatic entry/guide/filter/closing behavior, no visitor settings, dismissal, reduced motion, image failure, no JavaScript and non-home exclusion. Complete same-SHA deployment and production verification before final release receipt. Rollback uses a revert PR through existing checks; preserve the canonical artwork archive separately from website runtime.
