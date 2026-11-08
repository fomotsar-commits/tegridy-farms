// The fee-change page's decision, without a chain: decideFee() and tierAfter() from
// scripts/lib/tierFee.mjs. The rehearsal (rehearsal/rehearse-tier-fee.mjs) runs it end to end.
//   node --test "solana/clmm-deploy/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFee, tierAfter } from '../scripts/lib/tierFee.mjs';

const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const WORKSHOP = 'G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu';
const A = '5QHzAqbGk3W8qGRBHCMyWjhLXf8YJcs3yPEh14Ymcwgz';
const B = '6VHowW4pnD4WTGsXhqBp6yxGgC3EExVmYgebSrRNu2tY';
const LOCK = 172_800;
const TIERS = [
  { index: 0, tickSpacing: 120, tradeFeeRate: 10_000, protocolFeeRate: 104_000, fundFeeRate: 56_000 },
  { index: 1, tickSpacing: 60, tradeFeeRate: 2_500, protocolFeeRate: 104_000, fundFeeRate: 56_000 },
];
const cfg = { timeLock: LOCK, binary: { sha256: 'fc'.repeat(32) }, addr: { vault: VAULT, workshop: WORKSHOP }, tiers: TIERS, change: { index: 1, param: 0, from: 2_500, to: 10_000 } };
const read = (want, over = {}) => ({ index: want.index, owner: VAULT, protocolFeeRate: want.protocolFeeRate, tradeFeeRate: want.tradeFeeRate, tickSpacing: want.tickSpacing, fundFeeRate: want.fundFeeRate, fundOwner: WORKSHOP, ...over });
const exact = (want) => ({ want, state: 'exact', got: read(want) });
const other = (want, over) => ({ want, state: 'wrong', got: read(want, over) });
const state = ({ tiers = TIERS.map(exact), proposals = [], member = A, clock = 1_800_000_000, program = { exists: true, sameBuild: true, authority: VAULT } } = {}) => ({
  ms: { threshold: 2, members: [{ key: A, mask: 7 }, { key: B, mask: 7 }], timeLock: LOCK, configAuthority: '11111111111111111111111111111111', transactionIndex: 21 },
  program, tiers, proposals, member, clock,
});
const ours = (status, extra = {}) => ({ index: 22, live: true, ours: true, touches: true, kind: 'vault', proposal: { status, timestamp: 1_800_000_000, approved: [A], ...extra } });
const stops = (d) => d.lines.filter((l) => !l.ok).map((l) => l.w).join(' | ');

test('with both tiers as #19 made them and no proposal, member A may propose the next index', () => {
  const d = decideFee(cfg, state());
  assert.equal(d.action, 'propose', stops(d));
  assert.match(d.lines.at(-1).w, /#22 will be created/);
  assert.ok(d.lines.some((l) => l.ok && /tier 1 charges 0\.25% of each swap now; this proposal sets it to 1%/.test(l.w)));
  assert.ok(d.lines.some((l) => l.ok && /tier 0 is as made: 1% of each swap/.test(l.w)));
});

test('no wallet, or a wallet outside the multisig: nothing to sign', () => {
  assert.match(decideFee(cfg, state({ member: null })).lines.at(-1).w, /connect a member wallet/);
  const d = decideFee(cfg, state({ member: VAULT }));
  assert.equal(d.action, null);
  assert.match(d.lines.at(-1).w, /not a member/);
});

test('once tier 1 reads 1% with everything else as before, it is done', () => {
  const t1 = other(TIERS[1], { tradeFeeRate: 10_000 });
  assert.equal(tierAfter(cfg, t1), true);
  const d = decideFee(cfg, state({ tiers: [exact(TIERS[0]), t1] }));
  assert.equal(d.action, 'done');
});

test('tier 1 at any other value, or 1% with another field changed, stops the page', () => {
  for (const over of [{ tradeFeeRate: 5_000 }, { tradeFeeRate: 10_000, protocolFeeRate: 160_000 }, { tradeFeeRate: 10_000, fundOwner: VAULT }, { tradeFeeRate: 10_000, tickSpacing: 120 }]) {
    const t1 = other(TIERS[1], over);
    assert.equal(tierAfter(cfg, t1), false, JSON.stringify(over));
    const d = decideFee(cfg, state({ tiers: [exact(TIERS[0]), t1] }));
    assert.equal(d.action, null, JSON.stringify(over));
    assert.match(stops(d), /tier 1 reads other values/);
  }
  const gone = decideFee(cfg, state({ tiers: [exact(TIERS[0]), { want: TIERS[1], state: 'absent' }] }));
  assert.equal(gone.action, null);
  assert.match(stops(gone), /tier 1 does not exist/);
});

test('tier 0 changed stops the page, even though the proposal does not touch it', () => {
  const d = decideFee(cfg, state({ tiers: [other(TIERS[0], { tradeFeeRate: 2_500 }), exact(TIERS[1])] }));
  assert.equal(d.action, null);
  assert.match(stops(d), /tier 0 is not as made/);
});

test('a program upgraded since staging, or one the vault does not control, stops the page', () => {
  assert.match(stops(decideFee(cfg, state({ program: { exists: true, sameBuild: false, why: 'its code hashes to ab', authority: VAULT } }))), /NOT the build this folder was made against.*restages/);
  assert.match(stops(decideFee(cfg, state({ program: { exists: true, sameBuild: true, authority: A } }))), /upgrade authority is .* not the vault/);
});

test('a live proposal made outside the page that touches the program stops it; two of ours stop it too', () => {
  const foreign = { index: 20, live: true, ours: false, touches: true, kind: 'vault', proposal: { status: 'Approved', timestamp: 1, approved: [A, B] } };
  const d = decideFee(cfg, state({ proposals: [foreign] }));
  assert.equal(d.action, null);
  assert.match(stops(d), /#20 \(Approved\) touches the range program or a fee tier but is NOT this page's.*Both members cancel it/);
  const twice = decideFee(cfg, state({ proposals: [ours('Active'), { ...ours('Active'), index: 23 }] }));
  assert.equal(twice.action, null);
  assert.match(stops(twice), /two open fee proposals/);
});

test('member A, having proposed, waits; member B approves, which starts the lock', () => {
  const a = decideFee(cfg, state({ proposals: [ours('Active')] }));
  assert.equal(a.action, null);
  assert.match(a.lines.at(-1).w, /#22 has your approval/);
  const b = decideFee(cfg, state({ proposals: [ours('Active')], member: B }));
  assert.equal(b.action, 'approve');
  assert.equal(b.index, 22);
  assert.match(b.lines.at(-1).w, /starts the 48-hour time lock/);
});

test('approved: no execute until the lock is over by the network\'s clock, then the execute', () => {
  const p = ours('Approved', { approved: [A, B] });
  const early = decideFee(cfg, state({ proposals: [p], clock: 1_800_000_000 + LOCK - 1 }));
  assert.equal(early.action, null);
  assert.match(early.lines.at(-1).w, /time lock holds it until/);
  const on = decideFee(cfg, state({ proposals: [p], clock: 1_800_000_000 + LOCK, member: B }));
  assert.equal(on.action, 'execute');
  assert.equal(on.index, 22);
});

test('a time lock other than 48 hours, or another threshold, stops the page', () => {
  const s = state();
  assert.match(stops(decideFee(cfg, { ...s, ms: { ...s.ms, timeLock: 10 } })), /time lock is 10 seconds/);
  assert.match(stops(decideFee(cfg, { ...s, ms: { ...s.ms, threshold: 1 } })), /not 2 of 2/);
});
