import assert from 'node:assert/strict';
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
  const links = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)]
    .map(match => match[0].match(/\bhref=["']([^"']+)/i)?.[1])
    .filter(Boolean)
    .map(href => new URL(href, 'https://local.test/').pathname.split('/').at(-1));
  const homeIndex = links.indexOf('home.css');
  assert.ok(homeIndex > -1, 'homepage stylesheet is linked');
  assert.ok(links.indexOf('mobile.css') > -1 && links.indexOf('mobile.css') < homeIndex);
  assert.ok(links.indexOf('civic.css') > -1 && links.indexOf('civic.css') < homeIndex);
  assert.equal(homeIndex, links.length - 1, 'home.css remains the final linked stylesheet');
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
  const compactHero = ruleFor(rules, '#main.home-redesign .hero', 'max-height: 800px');
  const compactPortrait = ruleFor(rules, '#main.home-redesign .hero-portrait', 'max-height: 800px');
  const narrowHero = ruleFor(rules, '#main.home-redesign .hero', 'max-width: 300px');
  const narrowPortrait = ruleFor(rules, '#main.home-redesign .hero-portrait', 'max-width: 300px');

  assertDeclarations(baseHero, {
    display: 'grid',
    'grid-template-rows': 'auto auto auto',
    'grid-template-areas': '"copy portrait" "tasks tasks" "lawyer lawyer"',
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
  assertDeclarations(baseLawyer, {
    'grid-area': 'lawyer',
    'grid-column': 'lawyer-start / lawyer-end',
    'grid-row': 'lawyer-start / lawyer-end',
  }, 'desktop lawyer link');
  assertDeclarations(mobileLawyer, { margin: '0' }, 'mobile lawyer link clears the desktop overlap margin');
  assertDeclarations(hero, {
    'grid-template-columns': 'minmax(0, 1fr) minmax(0, .62fr)',
    'grid-template-rows': 'auto auto auto auto auto auto',
    'grid-template-areas': '"eyebrow portrait" "title portrait" "intro intro" "actions actions" "tasks tasks" "lawyer lawyer"',
    'row-gap': '18px',
    'column-gap': '14px',
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
    'max-width': 'none',
    margin: '0',
    'justify-self': 'stretch',
    'align-self': 'start',
  }, 'mobile portrait reset');
  assert.equal(frame.declarations.get('aspect-ratio'), '1.04', 'desktop portrait frame keeps its established ratio');
  assert.equal(ruleFor(rules, '#main.home-redesign .portrait-frame', 'max-width: 780px')?.declarations.get('aspect-ratio'), '2 / 3', 'mobile portrait frame uses the source portrait ratio');
  assertDeclarations(caption, { display: 'block', position: 'absolute', 'clip-path': 'inset(50%)' }, 'mobile caption remains visually hidden but available to assistive technology');
  assertDeclarations(narrowHero, {
    'grid-template-columns': 'minmax(0, 1fr)',
    'grid-template-areas': '"eyebrow" "title" "portrait" "intro" "actions" "tasks" "lawyer"',
  }, 'narrow text-zoom reflow');
  assertDeclarations(narrowPortrait, { width: 'min(100%, 260px)', 'max-width': '260px', 'justify-self': 'center' }, 'narrow portrait reflow');
  assertDeclarations(compactHero, { 'row-gap': '20px', 'padding-top': '24px' }, 'short desktop hero');
  assertDeclarations(compactPortrait, { width: 'min(100%, 320px)' }, 'short desktop portrait');
});

test('canonical portrait sizes match the generated homepage image source', async () => {
  const template = await read('templates/home-main.html');
  const built = await read('index.html');
  const source = html => html.match(/<figure class="portrait hero-portrait">[\s\S]*?<source\b[^>]*sizes="([^"]+)"/i)?.[1];
  const alt = html => html.match(/<figure class="portrait hero-portrait">[\s\S]*?<img\b[^>]*alt="([^"]+)"/i)?.[1];
  const expectedSizes = '(max-width: 300px) calc(100vw - 40px), (max-width: 620px) calc(38.3vw - 20px), (max-width: 780px) calc(38.3vw - 30px), 380px';

  assert.equal(source(template), expectedSizes, 'canonical template describes the new mobile portrait width');
  assert.equal(source(built), expectedSizes, 'generated homepage uses the canonical mobile portrait width');
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
