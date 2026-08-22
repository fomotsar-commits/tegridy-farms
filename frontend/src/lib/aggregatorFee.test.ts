// F3 fee plumbing, at the wire.
//
// The claim under test is narrow and total: what the meta-router SENDS and what it
// REPORTS on the quote are the same number, for every provider, in both the off and
// the on state. `venueFeeBps` is the only figure a surface is allowed to display, so
// if it can drift from the request, every disclosure downstream is fiction.
//
// Kept out of aggregator.test.ts so the R045 chain/slippage suite stays a single
// subject.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { getMetaAggregatorQuotes, getAggregatorPrice } from './aggregator';
import { venueFeeDisclosure } from '../components/swap/VenueFeeLine';

const RECIPIENT = '0x6d5791A660e79175F74C6D639584C98422d5956E';
const AMOUNT = '1000000000000000000';
const SENDER = '0x000000000000000000000000000000000000dEaD';

/** One successful body per provider, so every leg lands in the same run. */
function mockAllProviders() {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body =
      url.includes('/api/swapapi/') ? { amountOut: '100', priceImpact: 0 }
      : url.includes('/odos/') ? { outAmounts: ['100'] }
      : url.includes('/cow/') ? { quote: { buyAmount: '100' } }
      : url.includes('/lifi/') ? { estimate: { toAmount: '100' } }
      : url.includes('/kyber/') ? { data: { routeSummary: { amountOut: '100' } } }
      : url.includes('/openocean/') ? { data: { outAmount: '100' } }
      : url.includes('/paraswap/') ? { priceRoute: { destAmount: '100' } }
      : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

function callsMatching(spy: ReturnType<typeof mockAllProviders>, fragment: string) {
  return spy.mock.calls.filter(([u]) => typeof u === 'string' && u.includes(fragment));
}

function quotes() {
  return getMetaAggregatorQuotes('ETH', 'WETH', AMOUNT, SENDER, 1);
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('fee OFF by default — nothing leaves carrying a fee', () => {
  it('no provider request carries a fee parameter', async () => {
    const spy = mockAllProviders();
    await quotes();

    const urls = spy.mock.calls.map(([u]) => String(u)).join('\n');
    for (const param of [
      'partnerAddress', 'partnerFeeBps', 'integrator', 'fee=', 'referrer', 'referrerFee',
      'feeAmount', 'chargeFeeBy', 'feeReceiver', 'swapFeeBps', 'referralCode',
    ]) {
      expect(urls, param).not.toContain(param);
    }
    for (const [, init] of spy.mock.calls) {
      const raw = (init as RequestInit | undefined)?.body;
      if (typeof raw === 'string') expect(raw).not.toMatch(/partner|referral|referrer|feeAmount|swapFee/i);
    }
  });

  it('every quote reports a zero venue fee', async () => {
    mockAllProviders();
    const result = await quotes();
    expect(result.allQuotes.length).toBeGreaterThan(0);
    for (const q of result.allQuotes) expect(q.venueFeeBps, q.source).toBe(0);
  });

  it('a rate with no recipient still sends nothing', async () => {
    vi.stubEnv('VITE_SWAP_FEE_BPS', '25');
    const spy = mockAllProviders();
    await quotes();
    expect(callsMatching(spy, 'partnerFeeBps')).toHaveLength(0);
  });

  it('a nonsense rate alongside a valid recipient still sends nothing', async () => {
    vi.stubEnv('VITE_SWAP_FEE_BPS', 'quarter of a percent');
    vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', RECIPIENT);
    const spy = mockAllProviders();
    const result = await quotes();
    expect(callsMatching(spy, 'partnerFeeBps')).toHaveLength(0);
    for (const q of result.allQuotes) expect(q.venueFeeBps, q.source).toBe(0);
  });
});

describe('fee ON — only a confirmed leg carries it', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SWAP_FEE_BPS', '25');
    vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', RECIPIENT);
  });

  it('ParaSwap’s request carries the recipient and the bps', async () => {
    const spy = mockAllProviders();
    await quotes();
    const [call] = callsMatching(spy, '/paraswap/');
    const url = new URL(String(call![0]), 'https://memetic.fun');
    expect(url.searchParams.get('partnerAddress')).toBe(RECIPIENT);
    expect(url.searchParams.get('partnerFeeBps')).toBe('25');
  });

  it('the ParaSwap quote reports exactly the bps its request carried', async () => {
    mockAllProviders();
    const result = await quotes();
    const paraswap = result.allQuotes.find((q) => q.source === 'paraswap');
    expect(paraswap!.venueFeeBps).toBe(25);
  });

  it('withheld providers send no fee and report none', async () => {
    const spy = mockAllProviders();
    const result = await quotes();

    const withheld = ['/api/swapapi/', '/odos/', '/cow/', '/lifi/', '/kyber/', '/openocean/'];
    for (const fragment of withheld) {
      const [call] = callsMatching(spy, fragment);
      expect(String(call![0]), fragment).not.toMatch(/integrator|referrer|feeAmount|chargeFeeBy|feeReceiver|swapFeeBps|referralCode|partner/i);
      const raw = (call![1] as RequestInit | undefined)?.body;
      if (typeof raw === 'string') expect(raw, fragment).not.toMatch(/partner|referral|referrer|feeAmount|swapFee/i);
    }

    for (const q of result.allQuotes) {
      if (q.source === 'paraswap') continue;
      expect(q.venueFeeBps, q.source).toBe(0);
    }
  });

  it('an over-max rate is clamped on the wire, not just in the policy', async () => {
    vi.stubEnv('VITE_SWAP_FEE_BPS', '9999');
    const spy = mockAllProviders();
    const result = await quotes();
    const [call] = callsMatching(spy, '/paraswap/');
    const url = new URL(String(call![0]), 'https://memetic.fun');
    expect(url.searchParams.get('partnerFeeBps')).toBe('100');
    expect(result.allQuotes.find((q) => q.source === 'paraswap')!.venueFeeBps).toBe(100);
  });

  it('getAggregatorPrice carries the winning quote’s fee, not the policy’s', async () => {
    // Only a withheld provider answers, so the policy says 25 and the truth says 0.
    vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = url.includes('/lifi/') ? { estimate: { toAmount: '100' } } : {};
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const priced = await getAggregatorPrice('ETH', 'WETH', AMOUNT, SENDER, 1);
    expect(priced!.source).toBe('lifi');
    expect(priced!.venueFeeBps).toBe(0);
  });
});

describe('display == sent', () => {
  it('the disclosed percentage is derived from the bps the request carried', async () => {
    vi.stubEnv('VITE_SWAP_FEE_BPS', '25');
    vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', RECIPIENT);
    const spy = mockAllProviders();
    const result = await quotes();

    const paraswap = result.allQuotes.find((q) => q.source === 'paraswap')!;
    const [call] = callsMatching(spy, '/paraswap/');
    const sentBps = new URL(String(call![0]), 'https://memetic.fun').searchParams.get('partnerFeeBps');

    expect(String(paraswap.venueFeeBps)).toBe(sentBps);
    expect(venueFeeDisclosure(paraswap, true).value).toBe(`${Number(sentBps) / 100}%`);
  });

  it('a withheld provider discloses no fee even while the policy is enabled', async () => {
    vi.stubEnv('VITE_SWAP_FEE_BPS', '25');
    vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', RECIPIENT);
    mockAllProviders();
    const result = await quotes();
    const lifi = result.allQuotes.find((q) => q.source === 'lifi')!;
    expect(venueFeeDisclosure(lifi, true).value).toBe('None');
  });
});
