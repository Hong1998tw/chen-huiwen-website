import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

function splitSelectors(value) {
  const selectors = [];
  let current = '';
  let depth = 0;
  for (const character of value) {
    if (character === '(' || character === '[') depth++;
    if (character === ')' || character === ']') depth--;
    if (character === ',' && depth === 0) {
      selectors.push(current.trim());
      current = '';
    } else current += character;
  }
  if (current.trim()) selectors.push(current.trim());
  return selectors;
}

function declarationsFrom(body) {
  const declarations = new Map();
  for (const item of body.split(';')) {
    const separator = item.indexOf(':');
    if (separator < 1) continue;
    declarations.set(item.slice(0, separator).trim().toLowerCase(), item.slice(separator + 1).trim());
  }
  return declarations;
}

function parseRules(source, media = []) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor);
    if (open < 0) break;
    const header = css.slice(cursor, open).trim();
    let depth = 1;
    let close = open + 1;
    while (close < css.length && depth > 0) {
      if (css[close] === '{') depth++;
      else if (css[close] === '}') depth--;
      close++;
    }
    assert.equal(depth, 0, `CSS rule is closed: ${header}`);
    const body = css.slice(open + 1, close - 1);
    if (/^@(media|supports)\b/i.test(header)) rules.push(...parseRules(body, [...media, header]));
    else if (header && !header.startsWith('@')) rules.push({header, selectors: splitSelectors(header), declarations: declarationsFrom(body), media});
    cursor = close;
  }
  return rules;
}

function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+/g) ?? []).length;
  const attributes = (selector.match(/\[[^\]]+\]/g) ?? []).length;
  const pseudoClasses = (selector.match(/:(?!:)[\w-]+/g) ?? []).length;
  const pseudoElements = (selector.match(/::[\w-]+/g) ?? []).length;
  const residue = selector
    .replace(/#[\w-]+/g, ' ')
    .replace(/\.[\w-]+/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/:{1,2}[\w-]+(?:\([^)]*\))?/g, ' ')
    .replace(/[>+~*]/g, ' ');
  const elements = (residue.match(/(?:^|\s)[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes + attributes + pseudoClasses, elements + pseudoElements];
}

function compareSpecificity(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function classesIn(selector) {
  return [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
}

function ruleFor(rules, selector, mediaNeedle = '') {
  return rules.find(rule => rule.selectors.includes(selector) && rule.media.join(' ').includes(mediaNeedle));
}

function assertDeclarations(rule, expected, label) {
  assert.ok(rule, `${label} rule exists`);
  for (const [property, value] of Object.entries(expected)) {
    assert.equal(rule.declarations.get(property), value, `${label} ${property}`);
  }
}

test('homepage CSS is loaded after the legacy mobile and civic stylesheets', async () => {
  const html = await read('index.html');
  const hrefs = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)]
    .map(match => match[0].match(/\bhref=["']([^"']+)/i)?.[1])
    .filter(Boolean);
  const links = hrefs.map(href => new URL(href, 'https://local.test/').pathname.split('/').at(-1));
  const homeIndex = links.indexOf('home.css');
  assert.ok(homeIndex > -1, 'homepage stylesheet is linked');
  assert.ok(links.indexOf('mobile.css') > -1 && links.indexOf('mobile.css') < homeIndex);
  assert.ok(links.indexOf('civic.css') > -1 && links.indexOf('civic.css') < homeIndex);
  assert.equal(homeIndex, links.length - 1, 'home.css remains the final linked stylesheet');
  const homeHref = hrefs.find(href => new URL(href, 'https://local.test/').pathname.endsWith('/home.css'));
  const css = await read('home.css');
  assert.equal(new URL(homeHref, 'https://local.test/').searchParams.get('v'), createHash('sha256').update(css).digest('hex').slice(0, 12), 'homepage stylesheet version matches its source hash');
});

test('scoped hero rules reset legacy grid placement and mobile display behavior', async () => {
  const css = await read('home.css');
  const rules = parseRules(css);
  const baseHero = ruleFor(rules, '#main.home-redesign .hero');
  const baseCopy = ruleFor(rules, '#main.home-redesign .hero-copy');
  const basePortrait = ruleFor(rules, '#main.home-redesign .hero-portrait');
  const baseTasks = ruleFor(rules, '#main.home-redesign .home-task-paths');
  const baseLawyer = ruleFor(rules, '#main.home-redesign .home-lawyer-link');
  const mobileLawyer = ruleFor(rules, '#main.home-redesign .home-lawyer-link', 'max-width: 780px');
  const hero = ruleFor(rules, '#main.home-redesign .hero', 'max-width: 780px');
  const copy = ruleFor(rules, '#main.home-redesign .hero-copy', 'max-width: 780px');
  const copyChildren = ruleFor(rules, '#main.home-redesign .hero-copy > *', 'max-width: 780px');
  const kicker = ruleFor(rules, '#main.home-redesign .hero > .hero-copy > .kicker', 'max-width: 780px');
  const title = ruleFor(rules, '#main.home-redesign .hero > .hero-copy > h1', 'max-width: 780px');
  const intro = ruleFor(rules, '#main.home-redesign .hero > .hero-copy > .hero-intro', 'max-width: 780px');
  const actions = ruleFor(rules, '#main.home-redesign .hero > .hero-copy > .hero-actions', 'max-width: 780px');
  const portrait = ruleFor(rules, '#main.home-redesign .hero-portrait', 'max-width: 780px');
  const caption = ruleFor(rules, '#main.home-redesign .hero-portrait figcaption', 'max-width: 780px');
  const frame = ruleFor(rules, '#main.home-redesign .portrait-frame');
  const baseImage = ruleFor(rules, '#main.home-redesign .portrait-frame img');
  const desktopHero = ruleFor(rules, '#main.home-redesign .hero', 'min-width: 781px');
  const desktopNarrowHero = ruleFor(rules, '#main.home-redesign .hero', 'max-width: 900px');
  const desktopFrame = ruleFor(rules, '#main.home-redesign .portrait-frame', 'min-width: 781px');
  const desktopImage = ruleFor(rules, '#main.home-redesign .portrait-frame img', 'min-width: 781px');
  const desktopCaption = ruleFor(rules, '#main.home-redesign .hero-portrait figcaption', 'min-width: 781px');
  const mobileImageRules = rules.filter(rule => rule.selectors.includes('#main.home-redesign .portrait-frame img')
    && rule.media.join(' ').includes('max-width: 780px'));
  const compactHero = ruleFor(rules, '#main.home-redesign .hero', 'max-height: 800px');
  const compactPortrait = ruleFor(rules, '#main.home-redesign .hero-portrait', 'max-height: 800px');
  const compactMobileHero = rules.find(rule => rule.selectors.includes('#main.home-redesign .hero')
    && rule.media.join(' ').includes('max-width: 780px')
    && rule.media.join(' ').includes('max-height: 360px'));
  const compactMobilePortrait = rules.find(rule => rule.selectors.includes('#main.home-redesign .hero-portrait')
    && rule.media.join(' ').includes('max-width: 780px')
    && rule.media.join(' ').includes('max-height: 360px'));
  const narrowHero = ruleFor(rules, '#main.home-redesign .hero', 'max-width: 300px');
  const narrowPortrait = ruleFor(rules, '#main.home-redesign .hero-portrait', 'max-width: 300px');

  assertDeclarations(baseHero, {
    display: 'grid',
    'grid-template-rows': 'auto auto auto',
    'grid-template-areas': '"copy portrait" "tasks tasks" "lawyer lawyer"',
    gap: 'clamp(24px, 4vw, 54px) clamp(32px, 7vw, 88px)',
    'padding-top': 'clamp(30px, 4vw, 54px)',
  }, 'desktop hero');
  assertDeclarations(baseCopy, {
    display: 'block',
    'grid-area': 'copy',
    'grid-column': 'copy-start / copy-end',
    'grid-row': 'copy-start / copy-end',
  }, 'desktop hero copy');
  assertDeclarations(basePortrait, {
    'grid-area': 'portrait',
    'grid-column': 'portrait-start / portrait-end',
    'grid-row': 'portrait-start / portrait-end',
    width: 'min(100%, 380px)',
    height: 'auto',
    'min-height': '0',
  }, 'desktop portrait');
  assertDeclarations(baseTasks, {
    'grid-area': 'tasks',
    'grid-column': 'tasks-start / tasks-end',
    'grid-row': 'tasks-start / tasks-end',
  }, 'desktop service cards');
  const desktopTasks = ruleFor(rules, '#main.home-redesign .home-task-paths', 'min-width: 781px');
  assertDeclarations(desktopTasks, { 'margin-top': '0' }, 'desktop task cards clear the legacy top margin');
  const civicRules = parseRules(await read('civic.css'));
  const legacyTaskMargins = civicRules.flatMap(rule => rule.selectors
    .filter(selector => classesIn(selector).includes('home-task-paths'))
    .filter(() => rule.declarations.has('margin-block') || rule.declarations.has('margin-top'))
    .map(selector => ({rule, selector})));
  const civicDefaultMargin = legacyTaskMargins.find(({rule}) => rule.declarations.get('margin-block') === '22px 8px');
  const civicMobileMargin = legacyTaskMargins.find(({rule}) => rule.declarations.get('margin-top') === '14px'
    && rule.media.join(' ').includes('max-width:780px'));
  assert.ok(civicDefaultMargin, 'the earlier civic stylesheet has the 22px default task-card margin');
  assert.ok(civicMobileMargin, 'the earlier civic mobile rule keeps its 14px task-card margin');
  assert.ok(compareSpecificity(specificity(desktopTasks.selectors[0]), specificity(civicDefaultMargin.selector)) > 0,
    `the scoped desktop override outranks prior civic rule ${civicDefaultMargin.selector}`);
  assertDeclarations(baseLawyer, {
    'grid-area': 'lawyer',
    'grid-column': 'lawyer-start / lawyer-end',
    'grid-row': 'lawyer-start / lawyer-end',
  }, 'desktop lawyer link');
  assertDeclarations(mobileLawyer, { margin: '0' }, 'mobile lawyer link clears the desktop overlap margin');
  assertDeclarations(hero, {
    'grid-template-columns': 'minmax(0, 1fr) minmax(0, 1fr)',
    'grid-template-rows': 'auto auto auto auto auto auto',
    'grid-template-areas': '"eyebrow portrait" "title portrait" "intro intro" "actions actions" "tasks tasks" "lawyer lawyer"',
    'row-gap': '12px',
    'column-gap': '14px',
    'padding-top': '8px',
  }, 'mobile hero');
  assertDeclarations(copy, {
    display: 'contents',
    'grid-area': 'auto',
    'grid-column': 'auto',
    'grid-row': 'auto',
  }, 'mobile hero copy');
  assertDeclarations(copyChildren, { 'grid-area': 'auto', 'grid-column': 'auto', 'grid-row': 'auto' }, 'legacy child placement reset');
  assertDeclarations(kicker, { 'grid-area': 'eyebrow', margin: '0' }, 'mobile hero eyebrow');
  assertDeclarations(title, { 'grid-area': 'title', margin: '0', 'font-size': 'clamp(1.875rem, 9.5vw, 3rem)' }, 'mobile hero title');
  assertDeclarations(intro, { 'grid-area': 'intro', 'max-width': 'none', margin: '0' }, 'mobile hero introduction');
  assertDeclarations(actions, { 'grid-area': 'actions' }, 'mobile hero actions');
  assertDeclarations(portrait, {
    'grid-area': 'portrait',
    'grid-column': 'portrait-start / portrait-end',
    'grid-row': 'portrait-start / portrait-end',
    display: 'block',
    position: 'relative',
    width: '100%',
    height: 'auto',
    'min-height': '0',
    'max-width': '190px',
    margin: '0',
    'justify-self': 'end',
    'align-self': 'start',
  }, 'mobile portrait reset');
  assert.equal(frame.declarations.get('aspect-ratio'), '1.04', 'mobile portrait frame keeps the established authored ratio before its mobile override');
  assertDeclarations(desktopHero, {
    '--hero-portrait-reference-base': 'calc(42.78vw - 29.44px)',
    '--hero-portrait-reference-width': 'min(380px, var(--hero-portrait-reference-base))',
    '--hero-portrait-frame-width': 'min(602.3px, calc(66.4545vw - 33.73px))',
    'grid-template-columns': 'minmax(0, 1fr) minmax(0, var(--hero-portrait-frame-width))',
    'row-gap': '16px',
    'column-gap': 'clamp(24px, 3.75vw, 54px)',
    'padding-top': '16px',
  }, 'desktop natural-silhouette reference geometry');
  assertDeclarations(desktopNarrowHero, { 'column-gap': '18px' }, 'desktop 781-900px title column stays wide enough for the full first line');
  assertDeclarations(desktopFrame, { 'aspect-ratio': '1.047', 'border-radius': '0', background: 'transparent' }, 'desktop portrait silhouette frame');
  assert.equal(ruleFor(rules, '#main.home-redesign .portrait-frame', 'max-height: 800px')?.declarations.get('aspect-ratio'), '1.15', 'short desktop frame keeps the face ROI inside the viewport-safe silhouette crop');
  assert.equal(frame.declarations.get('overflow'), 'hidden', 'portrait frame clips only the permitted lower image area');
  assert.equal(baseImage.declarations.get('object-fit'), 'contain', 'mobile still displays the complete contain-fitted source image');
  assertDeclarations(desktopImage, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: 'var(--hero-portrait-reference-width)',
    height: 'auto',
    'aspect-ratio': '1.04',
    transform: 'translate(calc(-69.1695% + 6px), calc(-31.8725% + 6px)) scale(3)',
    'transform-origin': '0 0',
    'object-position': '50% 50%',
  }, 'desktop three-times source-content portrait close-up');
  assertDeclarations(desktopCaption, { position: 'absolute', 'clip-path': 'inset(50%)' }, 'desktop caption remains accessible without a visual color band');
  assert.equal(mobileImageRules.some(rule => rule.declarations.has('transform')), false, 'mobile portrait stays unscaled');
  assertDeclarations(baseImage, { width: '100%', height: '100%', 'max-width': 'none', 'max-height': 'none' }, 'mobile image dimensions stay tied to the original portrait frame');
  assert.equal(ruleFor(rules, '#main.home-redesign .portrait-frame', 'max-width: 780px')?.declarations.get('aspect-ratio'), '2 / 3', 'mobile portrait frame uses the source portrait ratio');
  assertDeclarations(caption, { display: 'block', position: 'absolute', 'clip-path': 'inset(50%)' }, 'mobile caption remains visually hidden but available to assistive technology');
  assertDeclarations(narrowHero, {
    'grid-template-columns': 'minmax(0, 1fr)',
    'grid-template-areas': '"eyebrow" "title" "portrait" "intro" "actions" "tasks" "lawyer"',
  }, 'narrow text-zoom reflow');
  assertDeclarations(narrowPortrait, { width: 'min(100%, 260px)', 'max-width': '260px', 'justify-self': 'center' }, 'narrow portrait reflow');
  assertDeclarations(compactHero, { '--hero-portrait-reference-width': 'min(320px, var(--hero-portrait-reference-base))', '--hero-portrait-frame-width': '513.1px', 'row-gap': '12px', 'padding-top': '12px' }, 'short desktop hero uses its historical compact reference');
  assertDeclarations(compactPortrait, { width: 'var(--hero-portrait-frame-width)', 'max-width': 'none' }, 'short desktop portrait keeps the natural silhouette width');
  assertDeclarations(compactMobileHero, { 'row-gap': '12px', 'padding-top': '12px' }, 'short mobile hero');
  assertDeclarations(compactMobilePortrait, {
    width: 'min(100%, 100px)',
    'max-width': '100px',
    'justify-self': 'end',
  }, 'short mobile portrait remains right aligned');
});

test('canonical portrait sizes match the generated homepage image source', async () => {
  const template = await read('templates/home-main.html');
  const built = await read('index.html');
  const source = html => html.match(/<figure class="portrait hero-portrait">[\s\S]*?<source\b[^>]*sizes="([^"]+)"/i)?.[1];
  const alt = html => html.match(/<figure class="portrait hero-portrait">[\s\S]*?<img\b[^>]*alt="([^"]+)"/i)?.[1];
  const expectedSizes = '(max-width: 780px) and (max-height: 360px) 100px, (max-width: 300px) calc(100vw - 40px), (max-width: 620px) min(calc(50vw - 27px), 190px), (max-width: 780px) min(calc(50vw - 39px), 190px), 1140px';

  assert.equal(source(template), expectedSizes, 'canonical template preserves mobile sizing and requests three-times desktop pixels');
  assert.equal(source(built), expectedSizes, 'generated homepage preserves mobile sizing and requests three-times desktop pixels');
  assert.equal(alt(template), alt(built), 'the source and generated portrait keep identical alternative text');
});

test('homepage selectors outrank every earlier legacy hero layout declaration', async () => {
  const html = await read('index.html');
  const links = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)]
    .map(match => match[0].match(/\bhref=["']([^"']+)/i)?.[1])
    .filter(Boolean)
    .map(href => new URL(href, 'https://local.test/').pathname.split('/').at(-1));
  const homeIndex = links.indexOf('home.css');
  const legacyRules = (await Promise.all(links.slice(0, homeIndex).map(async path => parseRules(await read(path)))))
    .flat();

  const checks = [
    {selector: '#main.home-redesign .hero', tokens: ['hero', 'hero-grid'], properties: ['display', 'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'gap', 'column-gap']},
    {selector: '#main.home-redesign .hero-copy', tokens: ['hero-copy'], properties: ['display', 'grid-area', 'grid-column', 'grid-row', 'padding', 'position']},
    {selector: '#main.home-redesign .hero-copy > *', tokens: ['hero-copy'], properties: ['grid-area', 'grid-column', 'grid-row']},
    {selector: '#main.home-redesign .hero-portrait', tokens: ['hero-portrait'], properties: ['display', 'grid-area', 'grid-column', 'grid-row', 'width', 'height', 'min-height', 'max-width', 'margin', 'position']},
    {selector: '#main.home-redesign .portrait-frame img', tokens: ['hero-portrait'], properties: ['display', 'width', 'height', 'max-width', 'max-height', 'aspect-ratio', 'object-fit']},
  ];

  for (const check of checks) {
    assert.match(check.selector, /^#main\.home-redesign\b/, 'home overrides stay scoped to the redesigned main element');
    const homeSpecificity = specificity(check.selector);
    const legacy = legacyRules.flatMap(rule => rule.selectors
      .filter(selector => check.tokens.some(token => classesIn(selector).includes(token)))
      .filter(selector => [...rule.declarations.keys()].some(property => check.properties.includes(property)))
      .map(selector => ({selector, specificity: specificity(selector)})));
    assert.ok(legacy.length, `${check.selector} has prior legacy declarations to guard against`);
    for (const rule of legacy) {
      assert.ok(compareSpecificity(homeSpecificity, rule.specificity) >= 0,
        `${check.selector} must beat earlier ${rule.selector}`);
    }
  }
});
