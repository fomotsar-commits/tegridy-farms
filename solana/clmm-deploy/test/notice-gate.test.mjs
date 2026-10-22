// The tier page's notice gate, without a chain: decide() and noticeEnds() from scripts/lib/tiers.mjs.
// The rehearsal (rehearsal/rehearse.mjs, T10-T15) covers the gate end to end with a notice counted in
// days. These cover a notice that names its own date (cfg.notice.notBefore, the owner's ruling of
// 2026-10-22: "update the promise date" after #19's second approval came through the Squads app).
//   node --test "solana/clmm-deploy/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, noticeEnds } from '../scripts/lib/tiers.mjs';

const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const A = '5QHzAqbGk3W8qGRBHCMyWjhLXf8YJcs3yPEh14Ymcwgz';
const B = '6VHowW4pnD4WTGsXhqBp6yxGgC3EExVmYgebSrRNu2tY';
const LOCK = 172_800;
const T = (iso) => Date.parse(iso) / 1000;
const LINE = '- Notice, updated: range pools get two fee tiers, 1% and 0.25% of each swap, no sooner than 2026-10-23 14:00 UTC (it said seven days from 2026-10-21). Of each fee, 84% stays with the liquidity providers whose range is in use, 10.4% goes to memetics.finance and 5.6% to Jungle Bay Island.';

const cfg = (notice) => ({
  timeLock: LOCK, binary: { sha256: 'fc'.repeat(32) }, addr: { vault: VAULT }, stagedAt: '2026-10-22T03:00:00Z',
  notice: { line: LINE, days: 7, files: ['CHANGELOG.md'], ...notice },
});
// The notice went public 2026-10-22 04:00; it was checked a minute before each clock below.
const record = (clock) => ({ line: LINE, seenAt: '2026-10-22T04:00:00Z', continuousSince: '2026-10-22T03:58:00Z', live: true, checkedAt: new Date((clock - 60) * 1000).toISOString().replace('.000', '') });
const state = ({ clock, status = 'Approved', approvedAt = T('2026-10-21T13:45:21Z'), approved = [B, A], member = A }) => ({
  ms: { threshold: 2, members: [{ key: A, mask: 7 }, { key: B, mask: 7 }], timeLock: LOCK, configAuthority: '11111111111111111111111111111111', transactionIndex: 19 },
  program: { exists: true, sameBuild: true, authority: VAULT },
  tiers: [{ state: 'absent', want: { index: 0 } }, { state: 'absent', want: { index: 1 } }],
  proposals: [{ index: 19, live: true, ours: true, touches: true, kind: 'vault', proposal: { status, timestamp: approvedAt, approved } }],
  member, clock, notice: record(clock), positionLink: { ok: true, why: 'the position link answers for this program' },
});
const NAMED = { notBefore: '2026-10-23T14:00:00Z' };

test('a named date holds the execute after the lock is over, until that date', () => {
  const clock = T('2026-10-23T13:50:00Z'); // lock over at 13:45:21, the named date not yet
  const d = decide(cfg(NAMED), state({ clock }));
  assert.equal(d.action, null);
  assert.match(d.lines.at(-1).w, /may execute from 2026-10-23T14:00:00Z/);
  assert.match(d.lines.at(-1).w, /the date the notice names/);
});

test('from the named date it offers the execute', () => {
  const d = decide(cfg(NAMED), state({ clock: T('2026-10-23T14:00:00Z') }));
  assert.equal(d.action, 'execute');
  assert.equal(d.index, 19);
  assert.ok(d.lines.some((l) => l.ok && /date the notice names \(2026-10-23T14:00:00Z\) has passed/.test(l.w)));
});

test('the chain\'s lock still comes first: a named date that has passed does not open a locked proposal', () => {
  const late = T('2026-10-23T12:00:00Z'); // approved later: its lock ends 2026-10-25T12:00:00Z
  const d = decide(cfg(NAMED), state({ clock: T('2026-10-24T00:00:00Z'), approvedAt: late }));
  assert.equal(d.action, null);
  assert.match(d.lines.at(-1).w, /time lock holds it until 2026-10-25T12:00:00Z/);
});

test('a named date before the notice went public waits for the notice instead', () => {
  const early = { notBefore: '2026-10-21T00:00:00Z' };
  assert.equal(noticeEnds(cfg(early), { start: T('2026-10-22T04:00:00Z') }).at, T('2026-10-22T04:00:00Z'));
  const d = decide(cfg(early), state({ clock: T('2026-10-23T14:00:00Z') }));
  assert.equal(d.action, 'execute');
});

test('a named date that does not read as a time refuses everything', () => {
  for (const bad of ['2026-10-23 14:00', 'soon', '2026-10-23T14:00:00+01:00', 1761228000]) {
    const d = decide(cfg({ notBefore: bad }), state({ clock: T('2026-10-30T00:00:00Z') }));
    assert.equal(d.action, null, `notBefore ${bad}`);
    assert.ok(d.lines.some((l) => !l.ok && /date the notice names does not read as a time/.test(l.w)), `notBefore ${bad}`);
  }
});

test('the approval that starts the lock waits until the lock would end no sooner than the named date', () => {
  const later = { notBefore: '2026-10-26T14:00:00Z' }; // approvals from 2026-10-24T14:00:00Z
  const s = (clock) => state({ clock, status: 'Active', approved: [B], member: A });
  const before = decide(cfg(later), s(T('2026-10-23T00:00:00Z')));
  assert.equal(before.action, null);
  assert.match(before.lines.at(-1).w, /waits for your approval from 2026-10-24T14:00:00Z/);
  assert.match(before.lines.at(-1).w, /no sooner than the date the notice names \(2026-10-26T14:00:00Z\)/);
  assert.equal(decide(cfg(later), s(T('2026-10-24T14:00:00Z'))).action, 'approve');
});

test('without a named date nothing changes: the notice still runs its days', () => {
  const ends = T('2026-10-22T04:00:00Z') + 7 * 86400; // 2026-10-29T04:00:00Z
  const waiting = decide(cfg({}), state({ clock: ends - 60 }));
  assert.equal(waiting.action, null);
  assert.match(waiting.lines.at(-1).w, /may execute from 2026-10-29T04:00:00Z \(7 days after the notice\)/);
  const open = decide(cfg({}), state({ clock: ends }));
  assert.equal(open.action, 'execute');
  assert.ok(open.lines.some((l) => l.ok && /public for 7 days, without a gap/.test(l.w)));
});
