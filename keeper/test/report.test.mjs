import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, summarize } from '../src/report.js';

const A = 'buy-here-sell-outside';
const B = 'buy-outside-sell-here';
const at = (mmss) => `2026-10-16T00:${mmss}Z`;
const row = (mmss, over) => ({ t: at(mmss), pool: 'BAYLA/SOL', coin: 'SOL', gapPct: 1, direction: null, wouldTrade: false, ...over });
const pay = (mmss, profit, over = {}) => row(mmss, { gapPct: 3, direction: A, wouldTrade: true, confirmedProfit: profit, ...over });
const p = (rows) => summarize(rows).get('BAYLA/SOL');

test('a stretch that would have paid counts once, at its best confirmed profit', () => {
  const rows = [row('00:00', {}), pay('00:30', 0.001), pay('01:00', 0.0016), pay('01:30', 0.0012), row('02:00', {}), pay('02:30', 0.002, { gapPct: -4, direction: B })];
  const s = p(rows);
  assert.equal(s.episodes, 2);
  assert.ok(Math.abs(s.made - 0.0036) < 1e-12);
  assert.equal(s.maxGap, -4);
});

test('a look outside the fees that does not pay keeps the stretch open; only coming back inside closes it', () => {
  const rows = [
    pay('00:00', 0.002),
    row('00:30', { gapPct: 2.5, direction: A, reason: 'a real quote at the planned size says it would not pay' }),
    pay('01:00', 0.0021),
    { t: at('01:30'), pool: 'BAYLA/SOL', unread: true, what: 'x', detail: 'y' },
    pay('02:00', 0.0019),
  ];
  const s = p(rows);
  assert.equal(s.episodes, 1, 'one gap that never closed is one stretch');
  assert.ok(Math.abs(s.made - 0.0021) < 1e-12);
  // Flipping side opens a new stretch.
  assert.equal(p([...rows, pay('02:30', 0.001, { gapPct: -3, direction: B })]).episodes, 2);
});

test('a stretch that reaches the size cap later is still reported as a floor', () => {
  const rows = [pay('00:00', 0.0002), pay('00:30', 0.03, { capped: true }), pay('01:00', 0.03, { capped: true })];
  const text = describe(summarize(rows));
  assert.match(text, /One late trade at each stretch's biggest gap could have taken about 0\.030000 SOL \(at least: 1 stretch\(es\) hit the size cap\): what a stranger can take, not the keeper\./);
});

test('the treasury figure is what a live keeper takes: each stretch at its first paying look, never its peak', () => {
  // A gap that drifts from paying 0.0002 to 0.03: a live keeper fixes it at 00:00.
  const rows = [pay('00:00', 0.0002), pay('00:30', 0.01), pay('01:00', 0.03, { capped: true }), row('01:30', {}), pay('02:00', 0.0005, { capped: true })];
  const s = p(rows);
  assert.ok(Math.abs(s.live - 0.0007) < 1e-12, `live ${s.live}`);
  assert.ok(Math.abs(s.made - 0.0305) < 1e-12, `peak ${s.made}`);
  const text = describe(summarize(rows));
  assert.match(text, /A live keeper fixes each at its first paying look: about 0\.000700 SOL for the treasury \(at least: 1 first fix\(es\) hit the size cap\)/);
  assert.doesNotMatch(text, /0\.030500 SOL for the treasury/);
});

test('unread looks are never "no gap": an all-unread pool says nothing is known', () => {
  const unread = (mmss) => ({ t: at(mmss), pool: 'BAYLA/SOL', unread: true, what: 'x', detail: 'y' });
  const text = describe(summarize([unread('00:00'), unread('00:30')]));
  assert.match(text, /No look could be read, so nothing is known about its gap/);
  assert.doesNotMatch(text, /Biggest gap|would not have paid/);
  const mixed = describe(summarize([row('00:00', { gapPct: 2 }), unread('00:30')]));
  assert.match(mixed, /Biggest gap among the 1 looks it could read: \+2\.00%/);
  assert.match(mixed, /would not have paid in any look it could read; 1 were unread/);
});

test('hours the keeper was not running are said, not counted as watching', () => {
  const rows = [row('00:00', {}), row('00:30', {}), { ...row('00:00', {}), t: '2026-10-16T20:00:00Z' }];
  const text = describe(summarize(rows));
  assert.match(text, /ran about 0\.0 h \(not running for about 20\.0 h of the 20\.0 h\)/);
});

test('the size check says whether it fit, maybe did not, failed, or had nothing to measure', () => {
  const text = describe(summarize([
    pay('00:00', 0.001, { size: { bytes: 1100, fits: true, accountsOk: true } }),
    pay('00:30', 0.001, { size: { bytes: 1300, fits: false, accountsOk: true, upperBound: true } }),
    pay('01:00', 0.001, { size: { bytes: 1400, fits: false, accountsOk: true } }),
    pay('01:30', 0.001, { size: { unread: 'KEEPER_TAKER is not an address' } }),
  ]));
  assert.match(text, /fit 1 time\(s\), too big 1 time\(s\), maybe too big 1 time\(s\) \(an upper bound\); largest 1400 of 1232 bytes/);
  assert.match(text, /The size check failed 1 time\(s\); last: KEEPER_TAKER is not an address/);
  assert.match(describe(summarize([row('00:00', {})])), /no correction paid, so nothing was measured/);
  assert.match(describe(summarize([pay('00:00', 0.001, { size: { notChecked: 'needs JUPITER_API_KEY and KEEPER_TAKER' } })])), /not checked \(needs JUPITER_API_KEY/);
});

test('paused and unsteady looks are not counted, and a jump is counted once', () => {
  const rows = [
    row('00:00', { gapPct: 9, direction: A, paused: true, bigMove: true, reason: 'paused' }),
    row('00:30', { gapPct: 9, direction: A, paused: true, bigMove: true, reason: 'paused' }),
    row('01:00', { gapPct: 3, direction: A, unsteady: true }),
  ];
  const s = p(rows);
  assert.equal(s.made, 0);
  assert.equal(s.jumps, 1, 'one jump seen by two looks is one jump');
  const text = describe(summarize(rows));
  assert.match(text, /2 look\(s\) were not counted because pump\.fun's price had just jumped/);
  assert.match(text, /1 look\(s\) were not counted because the outside price moved while it was read/);
});

test('a fee-owner change and a re-pointed pool are reported in capitals', () => {
  const text = describe(summarize([row('00:00', { leak: true }), { t: at('00:30'), pool: 'BAYLA/SOL', unread: true, repointed: true, what: 'our pool', detail: 'x' }]));
  assert.match(text, /THE FEE OWNERS WERE NOT THE AGREED SPLIT \(venue to our vault, island to its Workshop\) in 1 look/);
  assert.match(text, /THE POOL WAS RE-POINTED/);
});
