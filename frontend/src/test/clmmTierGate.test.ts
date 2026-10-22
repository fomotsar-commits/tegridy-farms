// @vitest-environment node
//
// When the range-pool fee-tier page (solana/clmm-deploy) offers the approval and the execute. The
// execute waits for the later of the vault's time lock and the notice: the owner's fixed time when
// the folder names one (2026-10-23 14:00 UTC, ruled 2026-10-22), else the notice's days. Every
// other gate holds at that time too.

import { describe, it, expect } from 'vitest';
import {
  decide,
  noticeEnds,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs pack module, deliberately untyped and outside src/
} from '../../../solana/clmm-deploy/scripts/lib/tiers.mjs';

const t = (iso: string) => Date.parse(iso) / 1000;
const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000', '');
const LOCK = 172_800;
const NOT_BEFORE = '2026-10-23T14:00:00Z';
const APPROVED = t('2026-10-21T13:45:21Z'); // proposal #19 on mainnet: its lock ends 2026-10-23T13:45:21Z

const cfg = (notice: Record<string, unknown>) => ({
  timeLock: LOCK,
  binary: { sha256: 'f'.repeat(64) },
  addr: { vault: 'Vault' },
  stagedAt: '2026-10-21T18:00:00Z',
  notice: { line: '- Notice (updated): the line', ...notice },
});

/** The chain as decide() reads it, with the notice checked a minute before `clock`. */
function state(clock: number, over: Record<string, unknown> = {}, status = 'Approved', approved = ['A', 'B']) {
  return {
    ms: { threshold: 2, timeLock: LOCK, configAuthority: '11111111111111111111111111111111', transactionIndex: 19, members: [{ key: 'A', mask: 7 }, { key: 'B', mask: 7 }] },
    program: { exists: true, sameBuild: true, authority: 'Vault' },
    tiers: [{ want: { index: 0 }, state: 'absent' }, { want: { index: 1 }, state: 'absent' }],
    proposals: [{ index: 19, kind: 'vault', live: true, ours: true, touches: true, proposal: { status, timestamp: APPROVED, approved } }],
    clock,
    member: 'A',
    notice: { line: '- Notice (updated): the line', live: true, seenAt: '2026-10-21T19:00:00Z', continuousSince: '2026-10-21T18:55:00Z', checkedAt: iso(clock - 60) },
    positionLink: { ok: true, why: 'the position link answers for this program' },
    ...over,
  };
}
const last = (d: { lines: { w: string }[] }) => d.lines.at(-1)?.w ?? '';

describe('the owner\'s fixed time (notice.notBefore)', () => {
  const c = cfg({ days: 7, notBefore: NOT_BEFORE });

  it('names that time as the execute time, whatever the notice\'s start', () => {
    expect(noticeEnds(c, { start: t('2026-10-21T19:00:00Z') }).at).toBe(t(NOT_BEFORE));
    expect(noticeEnds(cfg({ days: 7 }), { start: t('2026-10-21T19:00:00Z') }).at).toBe(t('2026-10-28T19:00:00Z'));
  });

  it('holds the execute for the time lock first, then for that time, then offers it', () => {
    let d = decide(c, state(t('2026-10-23T13:45:20Z')));
    expect(d.action).toBeNull();
    expect(last(d)).toMatch(/time lock holds it until 2026-10-23T13:45:21Z/);
    d = decide(c, state(t('2026-10-23T13:50:00Z')));
    expect(d.action).toBeNull();
    expect(last(d)).toMatch(/may execute from 2026-10-23T14:00:00Z/);
    d = decide(c, state(t(NOT_BEFORE)));
    expect(d).toMatchObject({ action: 'execute', index: 19 });
  });

  it('waits for the lock when the fixed time comes first', () => {
    const early = cfg({ days: 7, notBefore: '2026-10-23T13:00:00Z' });
    expect(decide(early, state(t('2026-10-23T13:30:00Z'))).action).toBeNull();
    expect(decide(early, state(t('2026-10-23T13:45:21Z'))).action).toBe('execute');
  });

  it('keeps every other gate at the execute time', () => {
    const at = t(NOT_BEFORE);
    expect(decide(c, state(at, { positionLink: { ok: false, why: 'not live for this program' } })).action).toBeNull();
    expect(decide(c, state(at, { notice: { ...state(at).notice, checkedAt: iso(at - 3700) } })).action).toBeNull();
    expect(decide(c, state(at, { notice: { ...state(at).notice, live: false } })).action).toBeNull();
    expect(decide(c, state(at, { notice: { ...state(at).notice, line: '- Notice: the old line' } })).action).toBeNull();
    expect(decide(c, state(at, { program: { exists: true, sameBuild: true, authority: 'Someone' } })).action).toBeNull();
    const foreign = { index: 20, kind: 'vault', live: true, ours: false, touches: true, proposal: { status: 'Active', timestamp: at, approved: ['B'] } };
    expect(decide(c, state(at, { proposals: [...state(at).proposals, foreign] })).action).toBeNull();
  });

  it('offers the last approval from the fixed time less the lock, so the lock ends no sooner', () => {
    const later = cfg({ days: 7, notBefore: '2026-10-25T14:00:00Z' });
    const from = t('2026-10-25T14:00:00Z') - LOCK;
    const d = decide(later, state(from - 1, {}, 'Active', ['B']));
    expect(d.action).toBeNull();
    expect(last(d)).toMatch(new RegExp(`waits for your approval from ${iso(from)}`));
    expect(decide(later, state(from, {}, 'Active', ['B'])).action).toBe('approve');
  });
});

describe('with no fixed time, the notice\'s days as before', () => {
  const c = cfg({ days: 7 });
  const start = t('2026-10-21T19:00:00Z');

  it('offers the execute only once the notice has been public for its days', () => {
    expect(decide(c, state(start + 7 * 86400 - 1)).action).toBeNull();
    expect(decide(c, state(start + 7 * 86400)).action).toBe('execute');
  });
});
