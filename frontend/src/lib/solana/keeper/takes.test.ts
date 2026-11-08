// @vitest-environment node
//
// The scanner's page read as trips between two outside pools: only fresh, proven, well-formed
// two-pool round trips in one of the robot's coins, on an exchange it knows, best first.
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import { TAKE_FRESH_MS, outsideTakes } from './takes';

const addr = () => Keypair.generate().publicKey.toBase58();
const NOW = 1_800_000_000_000;
const TOKEN = addr();
const P1 = addr();
const P2 = addr();
const PROGRAMS = { pumpswap: addr(), whirlpool: addr() };

const row = (over: Record<string, unknown> = {}, legOver: [Record<string, unknown>, Record<string, unknown>] = [{}, {}]) => ({
  mint: TOKEN,
  coin: SOL_QUOTE.mint,
  inRaw: 250_000_000,
  netUsd: 0.4,
  legs: [
    { pool: P1, dex: 'pumpswap', from: SOL_QUOTE.mint, to: TOKEN, ...legOver[0] },
    { pool: P2, dex: 'whirlpool', from: TOKEN, to: SOL_QUOTE.mint, ...legOver[1] },
  ],
  proof: { ok: true, at: NOW - 10_000 },
  ...over,
});

describe('outsideTakes: the scanner’s proven trips between two outside pools', () => {
  it('reads a fresh, proven two-pool trip, with each leg’s program', () => {
    const [t, ...rest] = outsideTakes({ watch: [row({ proof: { ok: true, at: NOW - TAKE_FRESH_MS + 1 } })] }, PROGRAMS, NOW);
    expect(rest).toEqual([]);
    expect(t).toEqual({
      coinMint: SOL_QUOTE.mint,
      tokenMint: TOKEN,
      legs: [{ pool: P1, program: PROGRAMS.pumpswap }, { pool: P2, program: PROGRAMS.whirlpool }],
      inRaw: 250_000_000n,
      netUsd: 0.4,
    });
  });

  it('reads both lists, each route once, best estimate first', () => {
    const better = row({ netUsd: 2, coin: USDC_QUOTE.mint }, [{ from: USDC_QUOTE.mint }, { to: USDC_QUOTE.mint }]);
    // Route A from `take` at $1 (its $0.40 copy in `watch` is the same route), route B at $2 after it.
    const got = outsideTakes({ take: [row({ netUsd: 1 })], watch: [row(), better] }, PROGRAMS, NOW);
    expect(got.map((t) => t.netUsd)).toEqual([2, 1]);
  });

  it('drops a trip whose test run failed, is missing, is stale, or is from the future', () => {
    for (const proof of [{ ok: false, at: NOW }, null, { ok: true, at: NOW - TAKE_FRESH_MS }, { ok: true, at: NOW + 1 }, { ok: 'true', at: NOW }]) {
      expect(outsideTakes({ watch: [row({ proof })] }, PROGRAMS, NOW)).toEqual([]);
    }
  });

  it('drops anything that is not a round trip between two outside pools in the robot’s coin', () => {
    const other = addr();
    const bad = [
      row({ coin: other }, [{ from: other }, { to: other }]), // starts in a coin the robot does not hold
      row({}, [{ dex: 'ours' }, {}]), // our pool: the robot's own trips
      row({}, [{}, { dex: 'nowhere' }]), // an exchange the robot does not know
      row({}, [{}, { dex: 'toString' }]), // not an own key of the table
      row({}, [{}, { pool: P1 }]), // both legs in one pool
      row({}, [{ pool: 'not-an-address' }, {}]),
      row({}, [{ pool: '0'.repeat(40) }, {}]), // the right length, not base58
      row({}, [{ to: addr() }, {}]), // the legs do not chain
      row({}, [{}, { to: USDC_QUOTE.mint }]), // ends in another coin: a third swap
      row({ mint: USDC_QUOTE.mint }, [{ to: USDC_QUOTE.mint }, { from: USDC_QUOTE.mint }]), // the "token" is the robot's other coin
      row({ inRaw: 0 }),
      row({ inRaw: Number.NaN }),
      row({ netUsd: '1' }),
      { ...row(), legs: [row().legs[0]] },
    ];
    for (const r of bad) expect(outsideTakes({ watch: [r] }, PROGRAMS, NOW)).toEqual([]);
    expect(outsideTakes(null, PROGRAMS, NOW)).toEqual([]);
    expect(outsideTakes({ watch: 'x' }, PROGRAMS, NOW)).toEqual([]);
  });
});
