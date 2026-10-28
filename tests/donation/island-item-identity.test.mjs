import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../island/dot-code-2/island-data-adapter.js', import.meta.url), 'utf8');
const { createIndex, resolveItemIndex } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('reviewed geography and evidence stages survive display unchanged', () => {
  const item = { id: 'stable', i: 'P01', t: '鳳山區排水改善', s: '部分已完成，整段進度待確認。',
    h: [['2023-09-01', '評估優化設施，施工情形待確認']] };
  const [display] = createIndex({ islands: [{ id: 'P01' }], items: [item] }).items;
  assert.equal(display.title, '鳳山區排水改善');
  assert.equal(display.summary, '部分已完成，整段進度待確認。');
  assert.equal(display.timeline[0].text, '評估優化設施，施工情形待確認');
});

test('retired links follow stable aliases after reordering and fail safely on broken aliases', () => {
  const data = { meta: { itemAliases: { retired: 'previous', previous: 'current', loop: 'loop', dangling: 'missing' } },
    items: [{ id: 'other' }, { id: 'current' }] };
  const before = JSON.stringify(data);
  assert.equal(resolveItemIndex(data, 'retired'), 1);
  assert.equal(resolveItemIndex({ ...data, items: [...data.items].reverse() }, 'retired'), 0);
  for (const id of ['loop', 'dangling', '__proto__', '']) assert.equal(resolveItemIndex(data, id), -1);
  assert.equal(JSON.stringify(data), before);
});
