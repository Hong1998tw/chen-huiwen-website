import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/validation.ts';

const event = {name:'公開活動',start:'2026-10-31T15:50:00+08:00',sourceUrl:'https://www.huiwen.tw/activities.html',verifiedAt:'2026-10-02',status:'scheduled'};
test('unannounced ends are normalized, while invalid ends and missing starts are rejected', () => {
  for (const end of [undefined, null, '']) assert.equal(validate('events',{...event,end}).end,null);
  assert.equal(validate('events',{...event,end:'2026-10-31T17:00:00+08:00'}).end,'2026-10-31T17:00:00+08:00');
  for (const end of [false,0,[],{},'bad','2026-02-31T17:00:00+08:00','2026-10-31T15:00:00+08:00','2026-10-31T16:00:00'])
    assert.throws(()=>validate('events',{...event,end}));
  assert.throws(()=>validate('events',{...event,start:null,end:null}));
});
