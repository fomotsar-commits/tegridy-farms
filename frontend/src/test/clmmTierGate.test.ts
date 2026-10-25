// @vitest-environment node
//
// When the range-pool fee-tier page (solana/clmm-deploy) offers the approval and the execute. The
// execute waits for the later of the vault's time lock and the notice: the owner's fixed time when
// the folder names one (2026-10-23 14:00 UTC), else the notice's days. Every other gate holds at
// that time too. The tier the page makes is the owner's: one, 1% (2026-10-25).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decide,
  noticeEnds,
  TIERS,
  NOTICE_LINE,
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
    tiers: [{ want: { index: 0 }, state: 'absent' }],
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

describe('the tier the page makes (owner, 2026-10-25: "only one fee tier that is 1%")', () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  it('is one tier: index 0, 1% of each swap, 120 price steps, 10.4% of each fee to the vault and 5.6% to the Workshop', () => {
    expect(TIERS).toEqual([{ index: 0, tickSpacing: 120, tradeFeeRate: 10_000, protocolFeeRate: 104_000, fundFeeRate: 56_000 }]);
  });

  it('is the one the public notice names, and the changelog carries that line byte for byte', () => {
    expect(NOTICE_LINE).toMatch(/^- Notice, updated: range pools get one fee tier, 1% of each swap, no sooner than 2026-10-23 14:00 UTC /);
    const lines = ['CHANGELOG.md', 'docs/CHANGELOG_EARLIER.md'].flatMap((f) => readFileSync(join(REPO, f), 'utf-8').replace(/\r/g, '').split('\n'));
    expect(lines.filter((l) => l === NOTICE_LINE)).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('- Notice') && /range pools get/.test(l))).toEqual([NOTICE_LINE]);
  });

  it('refuses to go on while the old two-tier #19 can execute, and offers the next proposal once both members cancel it', () => {
    const at = t('2026-10-25T07:00:00Z');
    const other = (index: number) => ({ index, kind: 'vault', live: true, ours: false, touches: false, proposal: { status: 'Approved', timestamp: at, approved: ['A', 'B'] } });
    const old19 = (status: string, cancelled: string[]) => ({ index: 19, kind: 'vault', live: status === 'Approved', ours: false, touches: true, proposal: { status, timestamp: at, approved: ['A', 'B'], cancelled } });
    const c = cfg({ days: 7, notBefore: NOT_BEFORE });
    const withProposals = (p: unknown[]) => state(at, { proposals: p, ms: { ...state(at).ms, transactionIndex: 20 } });

    for (const cancelled of [[], ['A']]) {
      const d = decide(c, withProposals([other(18), old19('Approved', cancelled), other(20)]));
      expect(d.action).toBeNull();
      expect(d.lines.some((l: { ok: boolean; w: string }) => !l.ok && /#19 \(Approved\) touches the range program but is NOT this page's: never approve or execute it\. Both members cancel it/.test(l.w))).toBe(true);
    }
    const d = decide(c, withProposals([other(18), old19('Cancelled', ['A', 'B']), other(20)]));
    expect(d).toMatchObject({ action: 'propose' });
    expect(last(d)).toMatch(/#21 will be created/);
  });
});
