# Visual QA

Baseline: 1440×960 and 390×844 screenshots of home, map, detail, service, news, intake, exploration and 404 from clean main. Production home/map separately observed. Cropped native-IAB desktop captures were rejected; full Chromium captures are the review evidence.

Round 1: editorial hierarchy clear; local search and service phone available near entry. Detail source/history links readable. Issues: service hero had an unrelated ornamental circle; profile portrait still requested large high-priority asset after moving below fold; initial feature without a source photograph made the two-column reading area uneven; 404's production base caused unstyled local rendering.

Round 2: removed ornament, lazy low-priority portrait with accurate 104/180px sizes, selected an existing photographed public project with original caption/credit/source link, fixed same-origin nested 404 recovery. No generated/fabricated city image. Original project facts and political wording preserved.

Round 3/final: visually reviewed `artifacts/astra-redesign/screenshots/final-*`: desktop/mobile home, reading, detail, service, map, list, news, intake, exploration and 404. The map has an equivalent record list; source captions and date semantics remain visible. Automated geometry and contrast checks complement visual review; they are not screen-reader certification.

Final map screenshots show loaded OpenStreetMap tiles, actual village geometry and recorded points at both widths. Capture waits for a visible marker rather than the zero-size Leaflet positioning pane. Final home accessible-name correction is nonvisual.
