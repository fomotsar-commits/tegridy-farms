// @vitest-environment node
//
// A pool's last trade, from the record the program itself writes (oracle.rs): a field,
// never a guess from fee counters, and never the word "active".
import { describe, it, expect } from 'vitest';
import { poolStatePda } from '../../launcher/solana/curve/program';
import { decodePoolState } from '../cpswap/program';
import { decodeObservationState } from './ownPrice';
import { poolViewFrom, type PoolView, type ReadPoolsOptions } from './poolFinder';
import { NO_TRADE_YET, lastTrade, lastTradeText } from './poolPast';
import { LAUNCH, PROGRAM, buildPool, key, observationBytes, viewOf } from './testkit.fixture';

const opts: ReadPoolsOptions = { programId: PROGRAM, launchProgramId: LAUNCH };
const pool = key();

/** A view whose price record is `bytes`, decoded the way the finder decodes it. */
function viewWith(bytes: Uint8Array): PoolView {
  const b = buildPool({ mint: key(), configIndex: 1, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
  const obs = decodeObservationState(bytes);
  if (!obs) throw new Error('the test bytes do not decode as a price record');
  return viewOf(b, { sol: 10n ** 9n, tok: 10n ** 12n, history: { kind: 'ok', obs } });
}

describe('lastTrade', () => {
  it('a ring the program never wrote to is none, whatever its index says', () => {
    // index 1: a decoder reading the wrong byte for `initialized` would see a 1 here.
    expect(lastTrade(viewWith(observationBytes({ pool, initialized: false, index: 1 })))).toEqual({ kind: 'none' });
  });

  it('an initialized ring is at its last update time', () => {
    const t = 1_791_055_083n; // 2026-10-03T19:18:03Z, the venue's first pool opening
    expect(lastTrade(viewWith(observationBytes({ pool, index: 3, lastUpdate: t, obs: [[3, t - 7n, 1n, 1n]] })))).toEqual({ kind: 'at', time: t });
  });

  it('a ring with no last update time uses the newest slot time', () => {
    const slotTime = 1_700_000_000n;
    expect(lastTrade(viewWith(observationBytes({ pool, index: 5, lastUpdate: 0n, obs: [[5, slotTime, 1n, 1n], [4, slotTime - 60n, 1n, 1n]] })))).toEqual({ kind: 'at', time: slotTime });
  });

  it('a record the finder could not read is unread with the finder’s reason, and one never read says so', () => {
    const b = buildPool({ mint: key(), configIndex: 1, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    expect(lastTrade(viewOf(b, { sol: 10n ** 9n, tok: 10n ** 12n, history: { kind: 'unread', detail: 'its price record account is missing' } }))).toEqual({
      kind: 'unread',
      detail: 'its price record account is missing',
    });
    expect(lastTrade(viewOf(b, { sol: 10n ** 9n, tok: 10n ** 12n, history: { kind: 'not-read' } }))).toEqual({ kind: 'unread', detail: 'not read yet' });
  });

  // Through the finder, for a pool that is NOT the launch pool: the record is read for
  // every pool, and a record that names another pool is never this pool's trade record.
  it('reads an ordinary pool’s record through the finder, and a record belonging to another pool is unread', () => {
    const mint = key();
    const standard = buildPool({ mint, configIndex: 1, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    const launch = buildPool({ mint, configIndex: 0, address: poolStatePda(mint, LAUNCH), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    const acc = (b: typeof standard, a: string) => ({ address: a, owner: b.accounts[a]!.owner, data: b.accounts[a]!.data, lamports: 1 });
    const entryFor = (b: typeof standard, recordOf: typeof standard, initialized: boolean) => {
      const d = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
      return poolViewFrom({
        address: b.address.toBase58(),
        pool: acc(b, b.address.toBase58()),
        vault0: acc(b, d.token0Vault),
        vault1: acc(b, d.token1Vault),
        config: acc(b, d.ammConfig),
        observation: { address: b.observation.toBase58(), owner: PROGRAM.toBase58(), data: observationBytes({ pool: recordOf.address, initialized, lastUpdate: initialized ? 1_700_000_000n : 0n }), lamports: 1 },
        opts,
      });
    };
    const own = entryFor(standard, standard, false);
    expect(own.kind === 'pool' && own.view.origin).toBe('standard');
    expect(own.kind === 'pool' && lastTrade(own.view)).toEqual({ kind: 'none' });

    const traded = entryFor(standard, standard, true);
    expect(traded.kind === 'pool' && lastTrade(traded.view)).toEqual({ kind: 'at', time: 1_700_000_000n });

    const borrowed = entryFor(standard, launch, true);
    expect(borrowed.kind === 'pool' && lastTrade(borrowed.view)).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/another pool/) });
  });
});

describe('lastTradeText', () => {
  const lines = [
    lastTradeText({ kind: 'none' }),
    lastTradeText({ kind: 'at', time: 1_791_055_083n }),
    lastTradeText({ kind: 'unread', detail: 'its price record account is missing' }),
  ];

  it('says the three things, verbatim, with the time in UTC', () => {
    expect(lines).toEqual([
      'No trade has reached this pool yet.',
      'Last trade: 2026-10-03 19:18:03 UTC',
      'Its trade record could not be read (its price record account is missing).',
    ]);
    expect(NO_TRADE_YET).toBe('No trade has reached this pool yet.');
  });

  // A dust swap for 0.005 SOL makes a dead pool's record read "minutes ago"; the time is
  // the fact, so the word "active" is never printed. No em dash, no forecast word.
  it('never calls a pool active, and carries no em dash or forecast word', () => {
    for (const line of lines) {
      expect(line).not.toMatch(/active/i);
      expect(line).not.toContain('—');
      expect(line).not.toMatch(/\bAPR\b|\bAPY\b|yield of|a year|annual|per day|per week|rate of return|earn fees on every trade/i);
    }
  });
});
