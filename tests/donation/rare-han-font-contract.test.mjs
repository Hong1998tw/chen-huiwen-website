import assert from 'node:assert/strict';
import test from 'node:test';
import {allowsRareHanFont, RARE_HAN_FAMILY} from './rare-han-font-contract.mjs';
import {expectedSupplementFallbackFontsForRoute} from './page-font-artifact-network-gate.mjs';

test('only the two pinned Han letters may use the embedded supplement', () => {
  const face = [{isCustomFont:true, familyName:RARE_HAN_FAMILY}];
  assert.equal(allowsRareHanFont(face, '坔涳'), true);
  assert.equal(allowsRareHanFont([{isCustomFont:true,familyName:RARE_HAN_FAMILY+' (Fontations)'}], '坔'), true);
  assert.equal(allowsRareHanFont(face, '中文'), false);
  assert.equal(allowsRareHanFont(face, '坔中'), false);
  assert.equal(allowsRareHanFont([{isCustomFont:false,familyName:RARE_HAN_FAMILY}], '坔'), false);
  assert.equal(allowsRareHanFont([{isCustomFont:true,familyName:'System CJK'}], '坔'), false);
});

test('network exception requires declared separate codepoints and the pinned asset digest', () => {
  const hash='f54454c3ccd0903f631c7e7a639a10805c98addfa689b19c9c8e3e32ebbca156';
  const font={path:'/assets/fonts/huiwen-site-sans/huiwen-rare-han-support-'+hash+'.woff2',sha256:hash};
  const row={codepoints:[0x4e2d],jpFallbackCodepoints:[],supplementFallbackCodepoints:[0x5754]};
  assert.deepEqual(expectedSupplementFallbackFontsForRoute(row,font),[font]);
  assert.deepEqual(expectedSupplementFallbackFontsForRoute({...row,supplementFallbackCodepoints:[0x4e2d]},font),[]);
  assert.deepEqual(expectedSupplementFallbackFontsForRoute({...row,jpFallbackCodepoints:[0x5754]},font),[]);
  assert.deepEqual(expectedSupplementFallbackFontsForRoute(row,{...font,sha256:'0'.repeat(64)}),[]);
  assert.deepEqual(expectedSupplementFallbackFontsForRoute({...row,supplementFallbackCodepoints:[]},font),[]);
});
