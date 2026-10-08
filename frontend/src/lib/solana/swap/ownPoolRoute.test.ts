// @vitest-environment node
//
// The route decided again when Buy is pressed. The rule is "our own pool unless
// somewhere else pays more", and it has to hold for the transaction that is built, not
// only for the line on the page: so the cases here are the pool losing by one raw unit,
// the tie, and every way a fresh quote can be missing.
import { describe, it, expect, vi } from 'vitest';
import type { AggregatorSeen, Prepared } from '../../launcher/solana/write/types';
import type { VenuePoolCandidate } from './venuePools';
import { OWN_ROUTE_COPY, freshDecision, ownPoolNowWins, prepareOwnPoolSwap, within, type OwnPoolSwapDeps } from './ownPoolRoute';

const pool = (address: string, out: bigint) => ({ venue: 'own-pool', outAmount: out, label: 'venue pool', poolAddress: address }) as VenuePoolCandidate;
const BUILT = { ok: true, prepared: { kind: 'venue-swap' } } as unknown as Prepared;

function deps(o: { agg: bigint | null | Error; own: VenuePoolCandidate[] }) {
  const prepare = vi.fn(async (_pool: string, _aggregator: AggregatorSeen) => BUILT);
  const d: OwnPoolSwapDeps = {
    aggregatorOut: async () => {
      if (o.agg instanceof Error) throw o.agg;
      return o.agg;
    },
    ownPools: async () => o.own,
    prepare,
  };
  return { d, prepare };
}
const messageOf = (r: Prepared) => (r.ok ? 'built' : r.outcome.message);

describe('our pool was shown: it is built only while it is still the route', () => {
  it('builds nothing when the aggregator now pays one raw unit more', async () => {
    const { d, prepare } = deps({ agg: 1_000_001n, own: [pool('PoolA', 1_000_000n)] });
    const r = await prepareOwnPoolSwap(d, 990_000n);
    expect(messageOf(r)).toBe(OWN_ROUTE_COPY.routeMoved);
    expect(r.ok ? null : r.outcome).toMatchObject({ status: 'not-sent', stage: 'build' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps a tie, and holds the build to the aggregator’s fresh figure', async () => {
    const { d, prepare } = deps({ agg: 1_000_000n, own: [pool('PoolA', 1_000_000n)] });
    expect(await prepareOwnPoolSwap(d, null)).toBe(BUILT);
    expect(prepare).toHaveBeenCalledWith('PoolA', { kind: 'quoted', out: 1_000_000n, when: 'now' });
  });

  it('builds when our pool pays more, in the best of our pools', async () => {
    const { d, prepare } = deps({ agg: 1_000_000n, own: [pool('PoolB', 1_000_500n), pool('PoolA', 1_002_000n)] });
    expect(await prepareOwnPoolSwap(d, null)).toBe(BUILT);
    expect(prepare).toHaveBeenCalledWith('PoolA', { kind: 'quoted', out: 1_000_000n, when: 'now' });
  });

  it('builds nothing when the one pool of ours still quoting pays one raw unit less', async () => {
    const { d, prepare } = deps({ agg: 1_000_000n, own: [pool('PoolB', 999_999n)] });
    expect(messageOf(await prepareOwnPoolSwap(d, null))).toBe(OWN_ROUTE_COPY.routeMoved);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('with no route at the aggregator, our pool is the only venue and is held to nothing', async () => {
    const { d, prepare } = deps({ agg: null, own: [pool('PoolA', 5n)] });
    expect(await prepareOwnPoolSwap(d, 1_000_000n)).toBe(BUILT);
    expect(prepare).toHaveBeenCalledWith('PoolA', { kind: 'no-route' });
  });

  it('when the aggregator cannot be asked again, the figure that was on screen stands in', async () => {
    const lost = deps({ agg: new Error('HTTP 502'), own: [pool('PoolA', 1_000_000n)] });
    expect(messageOf(await prepareOwnPoolSwap(lost.d, 1_000_001n))).toBe(OWN_ROUTE_COPY.underLastQuote);
    expect(lost.prepare).not.toHaveBeenCalled();
    const tied = deps({ agg: new Error('HTTP 502'), own: [pool('PoolA', 1_000_000n)] });
    expect(await prepareOwnPoolSwap(tied.d, 1_000_000n)).toBe(BUILT);
    // Said as the earlier figure it is, never as one taken just now.
    expect(tied.prepare).toHaveBeenCalledWith('PoolA', { kind: 'quoted', out: 1_000_000n, when: 'earlier' });
  });

  it('an aggregator that could not be asked, now or before, is "could not be asked", never "no route"', async () => {
    const alone = deps({ agg: new Error('HTTP 502'), own: [pool('PoolA', 1_000_000n)] });
    expect(await prepareOwnPoolSwap(alone.d, null)).toBe(BUILT);
    expect(alone.prepare).toHaveBeenCalledWith('PoolA', { kind: 'unreachable' });
  });

  it('builds nothing when none of our pools can be quoted any more, and says that, not that the aggregator won', async () => {
    const { d, prepare } = deps({ agg: 1n, own: [] });
    expect(messageOf(await prepareOwnPoolSwap(d, null))).toBe(OWN_ROUTE_COPY.poolGone);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('hands on whatever the builder answers, a refusal included', async () => {
    const refused: Prepared = { ok: false, outcome: { status: 'not-sent', stage: 'simulate', message: 'Blocked.' } };
    const { d } = deps({ agg: null, own: [pool('PoolA', 5n)] });
    d.prepare = async () => refused;
    expect(await prepareOwnPoolSwap(d, null)).toBe(refused);
  });
});

describe('the aggregator could not be asked at the press, and our pool fell under the figure on screen', () => {
  it('nothing is built, and the words never say the aggregator "now pays more" or that a better route is waiting', async () => {
    const { d, prepare } = deps({ agg: new Error('HTTP 502'), own: [pool('PoolA', 990_000n)] });
    const r = await prepareOwnPoolSwap(d, 1_000_000n);
    expect(prepare).not.toHaveBeenCalled();
    expect(r.ok ? null : r.outcome).toMatchObject({ status: 'not-sent', stage: 'build' });
    // Jupiter did not answer: what is known is that our pool fell under its LAST quote.
    expect(messageOf(r)).not.toBe(OWN_ROUTE_COPY.routeMoved);
    expect(messageOf(r)).not.toMatch(/now pays more|better route/);
    expect(messageOf(r)).toMatch(/could not be asked/);
  });

  it('a figure taken just now that beats our pool is still said as Jupiter paying more', async () => {
    const { d } = deps({ agg: 1_000_000n, own: [pool('PoolA', 990_000n)] });
    expect(messageOf(await prepareOwnPoolSwap(d, 1_000_000n))).toBe(OWN_ROUTE_COPY.routeMoved);
  });
});

describe('a quote whose transaction fails its own test run is no route this site would send', () => {
  const withSends = (o: Parameters<typeof deps>[0], sends: boolean) => {
    const x = deps(o);
    const asked = vi.fn(async () => sends);
    x.d.aggregatorSends = asked;
    return { ...x, asked };
  };

  it('the aggregator quotes more, and its transaction is refused: our pool is built, held to nothing, and says why', async () => {
    const { d, prepare } = withSends({ agg: 1_020_000n, own: [pool('PoolA', 1_010_000n)] }, false);
    expect(await prepareOwnPoolSwap(d, 1_000_000n)).toBe(BUILT);
    expect(prepare).toHaveBeenCalledWith('PoolA', { kind: 'refused' });
  });

  it('the aggregator quotes more, and its transaction would run (or its test run could not run): nothing is built', async () => {
    const { d, prepare } = withSends({ agg: 1_020_000n, own: [pool('PoolA', 1_010_000n)] }, true);
    expect(messageOf(await prepareOwnPoolSwap(d, 1_000_000n))).toBe(OWN_ROUTE_COPY.routeMoved);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('is not asked when our pool already takes the trade, nor of a figure from earlier', async () => {
    const won = withSends({ agg: 1_000_000n, own: [pool('PoolA', 1_010_000n)] }, false);
    expect(await prepareOwnPoolSwap(won.d, null)).toBe(BUILT);
    expect(won.prepare).toHaveBeenCalledWith('PoolA', { kind: 'quoted', out: 1_000_000n, when: 'now' });
    expect(won.asked).not.toHaveBeenCalled();
    const earlier = withSends({ agg: new Error('HTTP 502'), own: [pool('PoolA', 990_000n)] }, false);
    expect(messageOf(await prepareOwnPoolSwap(earlier.d, 1_000_000n))).toBe(OWN_ROUTE_COPY.underLastQuote);
    expect(earlier.asked).not.toHaveBeenCalled();
  });
});

describe('the aggregator was shown: our pool takes the trade only from a tie up', () => {
  it('one raw unit short is not enough', async () => {
    expect(await ownPoolNowWins(async () => [pool('PoolA', 999_999n)], 1_000_000n)).toBe(false);
  });
  it('a tie is', async () => {
    expect(await ownPoolNowWins(async () => [pool('PoolA', 1_000_000n)], 1_000_000n)).toBe(true);
  });
  it('and so is more', async () => {
    expect(await ownPoolNowWins(async () => [pool('PoolB', 1n), pool('PoolA', 1_000_001n)], 1_000_000n)).toBe(true);
  });
  it('no pool of ours quoting is never a win', async () => {
    expect(await ownPoolNowWins(async () => [], 1n)).toBe(false);
  });
});

describe('within: a read that hangs does not hold a trade', () => {
  it('gives the answer when it comes in time', async () => {
    expect(await within(Promise.resolve([1]), 50, [])).toEqual([1]);
  });
  it('gives the fallback when it does not, and when the read fails', async () => {
    expect(await within(new Promise<number[]>(() => {}), 10, [])).toEqual([]);
    expect(await within(Promise.reject<number[]>(new Error('x')), 50, [])).toEqual([]);
  });
});

describe('freshDecision', () => {
  it('is the router’s own decision on the fresh quotes', () => {
    expect(freshDecision([pool('PoolA', 10n)], 11n).chosen?.venue).toBe('aggregator');
    expect(freshDecision([pool('PoolA', 10n)], 10n).chosen?.venue).toBe('own-pool');
    expect(freshDecision([pool('PoolA', 10n)], null).runnerUp).toBe(null);
    expect(freshDecision([], null).chosen).toBe(null);
  });
});
