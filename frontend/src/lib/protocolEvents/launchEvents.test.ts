import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import type { OutcomeRecord } from '../launcher/outcomes';
import type { LauncherOutcomesResponse } from '../launcher/outcomesClient';
import { launchOutcomesToEvents } from './launchEvents';

const TOKEN_F = '0x00000000000000000000000000000000000000f1' as Address;
const TOKEN_L = '0x00000000000000000000000000000000000000f2' as Address;
const TOKEN_N = '0x00000000000000000000000000000000000000f3' as Address;

function rec(over: Partial<OutcomeRecord> & Pick<OutcomeRecord, 'token' | 'tier' | 'launchedAt'>): OutcomeRecord {
  return {
    observedAt: 1_800_000_500,
    priceEth: 0,
    launchPriceEth: 0,
    liquidityEth: 0,
    launchLiquidityEth: 0,
    holderCount: 0,
    unlocks: [],
    lastTeamActivityAt: null,
    ...over,
  };
}

function resp(records: OutcomeRecord[]): LauncherOutcomesResponse {
  const outcomes: Record<Address, OutcomeRecord> = {};
  for (const r of records) outcomes[r.token] = r;
  return { launches: [], outcomes };
}

describe('launchOutcomesToEvents', () => {
  it('returns [] for empty / null / malformed input (self-gating)', () => {
    expect(launchOutcomesToEvents(null)).toEqual([]);
    expect(launchOutcomesToEvents(undefined)).toEqual([]);
    expect(launchOutcomesToEvents({ launches: [], outcomes: {} })).toEqual([]);
  });

  it('excludes tier "none" (not a graded launch)', () => {
    const out = launchOutcomesToEvents(
      resp([rec({ token: TOKEN_N, tier: 'none', launchedAt: 1_800_000_000 })]),
    );
    expect(out).toEqual([]);
  });

  it('surfaces flagship + listable graded launches, newest first', () => {
    const out = launchOutcomesToEvents(
      resp([
        rec({ token: TOKEN_L, tier: 'listable', launchedAt: 1_800_000_100 }),
        rec({ token: TOKEN_F, tier: 'flagship', launchedAt: 1_800_000_200, launchLiquidityEth: 4.2, holderCount: 130 }),
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe('launch');
    expect(out[0].ts).toBe(1_800_000_200); // newest first
    expect(out[0].title).toBe('Flagship launch graduated');
    expect(out[0].whale).toBe(true); // flagship
    expect(out[0].detail).toContain('4.2 ETH liquidity');
    expect(out[0].detail).toContain('130 holders');
    expect(out[0].href).toBe(`https://etherscan.io/token/${TOKEN_F}`);
    expect(out[1].title).toBe('Listable launch graduated');
    expect(out[1].whale).toBe(false);
  });

  it('drops a record with no honest launch timestamp (launchedAt 0)', () => {
    const out = launchOutcomesToEvents(
      resp([rec({ token: TOKEN_F, tier: 'flagship', launchedAt: 0 })]),
    );
    expect(out).toEqual([]);
  });

  it('honors the sinceTs recency cutoff', () => {
    const out = launchOutcomesToEvents(
      resp([
        rec({ token: TOKEN_F, tier: 'flagship', launchedAt: 1_000 }),
        rec({ token: TOKEN_L, tier: 'listable', launchedAt: 5_000 }),
      ]),
      { sinceTs: 4_000 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].ts).toBe(5_000);
  });

  it('never invents a value — omits liquidity/holders when absent', () => {
    const out = launchOutcomesToEvents(
      resp([rec({ token: TOKEN_L, tier: 'listable', launchedAt: 1_800_000_100 })]),
    );
    expect(out[0].detail).toBe('Met the listable structural bar');
  });
});
