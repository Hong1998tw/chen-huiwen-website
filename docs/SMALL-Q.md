# Homepage small Q companion

This additive homepage-only component uses the five owner-approved AI-generated cartoon poses from the October 2, 2026 preview: idle, wave, nod, happy, guide. These are cartoon illustrations, not documentary photos or a complete hand-drawn animation. The original portrait, approved public copy and all other page layouts remain unchanged.

`index.html` owns an empty, initially hidden aside outside generated main and shared chrome. `small-q.js` progressively enhances it after the primary window load. It loads one 320px WebP pose at a time; the five image files total under 100 KiB. No third-party requests, sounds, tracking, storage, credentials or service submission are added.

Desktop figure: 128 CSS px. Narrow viewport: 96 CSS px, in normal page flow just after the hero so it never obscures service text or the fixed service bar. Controls offer five actions, pause and collapse; a collapsed companion can be restored. Reduced-motion produces static poses. Open navigation and native dialogs conceal the companion, background tabs pause motion, and print hides it. Without JavaScript or if the initial image fails, the companion stays hidden and site content remains available.

The scripts and stylesheet are explicitly listed in the existing public artifact allowlist. Existing source generation and content-addressed script/style versions apply. CMS retains text/structured-content scope; it does not gain arbitrary script injection or a new authoring/publishing path.

Checks: `node --check small-q.js`, existing deterministic quality/build and full-site CI, plus `node tests/donation/small-q.mjs` for 320/390/768/1440 widths, all actions, repeat click, pause/collapse, keyboard Escape, mobile service-bar separation, reduced motion, no JavaScript and non-home exclusion. Review fresh screenshots and same-SHA deployment/production receipts before marking the release verified. Rollback removes this additive component via a revert PR through the existing release path; do not weaken CI or change hosting/access.
