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

test('every homepage rule is scoped to the homepage', async () => {
  const rules = parseRules(await read('home.css'));
  assert.ok(rules.length > 50);
  for (const rule of rules) for (const selector of rule.selectors)
    assert.match(selector, /^(?:\.home-redesign\b|body\.homepage-v2\b)/, `home.css selector stays scoped: ${selector}`);
});

test('selected layout rules: four-entry service band, image-left lead and stacked phone layout', async () => {
  const rules = parseRules(await read('home.css'));
  assertDeclarations(ruleFor(rules, '.home-redesign .home-service-band'), {display: 'grid', 'grid-template-columns': 'repeat(4, minmax(0, 1fr))', background: 'var(--peach)'}, 'service band');
  assertDeclarations(ruleFor(rules, '.home-redesign .home-service-band', 'max-width: 760px'), {'grid-template-columns': 'repeat(2, minmax(0, 1fr))'}, 'phone service band');
  assertDeclarations(ruleFor(rules, '.home-redesign .latest-item.is-lead .latest-media'), {float: 'left'}, 'desktop lead image');
  assertDeclarations(ruleFor(rules, '.home-redesign .latest-item.is-lead .latest-media', 'max-width: 760px'), {float: 'none'}, 'phone lead image');
  assertDeclarations(ruleFor(rules, '.home-redesign .home-latest-tabs button[aria-selected="true"]'), {color: 'var(--deep)', 'font-weight': '800'}, 'selected tab');
  assertDeclarations(ruleFor(rules, '.home-redesign .latest-media.is-failed .latest-media-link'), {display: 'none'}, 'failed thumbnail hides the broken image');
});
