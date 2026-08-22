import { describe, it, expect } from 'vitest';
import type { AggregatorQuote } from '../aggregator';
import { invoiceLifecycle, invoiceProblems, invoiceFromWire, invoiceToWire, type Invoice } from './invoice';
import {
  applySlippageFloor,
  buildSettlementPlan,
  buildSettlementRecord,
  canSign,
  MAX_QUOTE_AGE_SECONDS,
  settlementStandingText,
  sizePayAmount,
} from './settlement';

const MERCHANT = '0x1111111111111111111111111111111111111111' as const;
const BUYER = '0x2222222222222222222222222222222222222222' as const;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as const;

const NOW = 1_760_000_000;

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-000001',
    merchant: MERCHANT,
    chainId: 1,
    settleToken: USDC,
    settleSymbol: 'USDC',
    settleDecimals: 6,
    settleAmount: 100_000_000n, // 100 USDC
    memo: 'one towel',
    expiresAt: NOW + 900,
    createdAt: NOW - 60,
    ...over,
  };
}

function quote(amountOut: string): AggregatorQuote {
  return {
    source: 'odos',
    amountOut,
    priceImpact: 0.1,
    chainId: 1,
    maxSlippagePct: 0.5,
    venueFeeBps: 0,
  };
}

function plan(over: Partial<Parameters<typeof buildSettlementPlan>[0]> = {}) {
  return buildSettlementPlan({
    invoice: invoice(),
    buyer: BUYER,
    payToken: WETH,
    paySymbol: 'WETH',
    payDecimals: 18,
    payAmount: 40_000_000_000_000_000n,
    quote: quote('101000000'),
    quotedAt: NOW - 5,
    slippagePct: 0.5,
    now: NOW,
    connectedChainId: 1,
    ...over,
  });
}

describe('the invoice is a debt in one asset and nothing else', () => {
  it('accepts a well-formed invoice', () => {
    expect(invoiceProblems(invoice())).toEqual([]);
    expect(invoiceLifecycle(invoice(), NOW)).toBe('open');
  });

  it('refuses a zero amount, which would render as a completed payment of nothing', () => {
    expect(invoiceProblems(invoice({ settleAmount: 0n })).join(' ')).toMatch(/nothing to settle/i);
  });

  it('refuses the zero address as a payee', () => {
    const problems = invoiceProblems(invoice({ merchant: '0x0000000000000000000000000000000000000000' }));
    expect(problems.join(' ')).toMatch(/burn/i);
  });

  it('refuses a window long enough to be a free option on the merchant', () => {
    const problems = invoiceProblems(invoice({ expiresAt: NOW + 400_000 }));
    expect(problems.join(' ')).toMatch(/at most 24 hours/i);
  });

  it('round-trips the amount through the wire as a decimal string, never a number', () => {
    const huge = invoice({ settleAmount: 2n ** 80n });
    const wire = invoiceToWire(huge);
    expect(typeof wire.settleAmount).toBe('string');
    expect(invoiceFromWire(JSON.parse(JSON.stringify(wire)))!.settleAmount).toBe(2n ** 80n);
  });

  it('rejects a fractional amount string rather than rounding a debt', () => {
    const wire = { ...invoiceToWire(invoice()), settleAmount: '100.5' };
    expect(invoiceFromWire(wire)).toBeNull();
  });
});

describe('the guarantee, which is the whole point of the checkout', () => {
  it('floors the quote by the tolerance, downward', () => {
    // 1000 at 0.5% -> 995, and never 995.x rounded up.
    expect(applySlippageFloor(1000n, 0.5)).toBe(995n);
    expect(applySlippageFloor(999n, 0.5)).toBe(994n);
  });

  it('offers a signature when the floored output still covers the exact invoice', () => {
    const p = plan();
    expect(p.refusals).toEqual([]);
    expect(canSign(p)).toBe(true);
    // 101_000_000 * 99.5% = 100_495_000 ≥ 100_000_000
    expect(p.disclosure.guaranteedOut).toBe(100_495_000n);
    expect(p.disclosure.buyerSurplus).toBe(495_000n);
  });

  it('REFUSES when the floored output falls short, even though the raw quote clears it', () => {
    // 100_200_000 raw clears the invoice; floored at 0.5% it is 99_699_000 and does not.
    const p = plan({ quote: quote('100200000') });
    expect(canSign(p)).toBe(false);
    expect(p.legs).toEqual([]);
    expect(p.refusals.join(' ')).toMatch(/cannot guarantee the exact amount/i);
  });

  it('never lets the surplus render as a negative number on a refused plan', () => {
    const p = plan({ quote: quote('1') });
    expect(p.disclosure.buyerSurplus).toBe(0n);
  });

  it('transfers the EXACT invoice amount, not whatever the swap produced', () => {
    const p = plan({ quote: quote('150000000') });
    const transfer = p.legs.find((l) => l.kind === 'transfer');
    expect(transfer).toMatchObject({ amount: 100_000_000n, to: MERCHANT, token: USDC });
    // The excess is the buyer's and is disclosed as theirs.
    expect(p.disclosure.buyerSurplus).toBeGreaterThan(0n);
  });

  it('discloses the pay leg as a maximum and the settle leg as exact', () => {
    const p = plan();
    expect(p.disclosure.payAmountMax).toBe(40_000_000_000_000_000n);
    expect(p.disclosure.settleAmount).toBe(100_000_000n);
    expect(p.disclosure.settleSymbol).toBe('USDC');
  });
});

describe('every refusal a buyer could be harmed by', () => {
  it('refuses an expired invoice rather than re-quoting a lapsed price', () => {
    expect(plan({ now: NOW + 10_000 }).refusals.join(' ')).toMatch(/expired/i);
  });

  it('refuses a stale quote', () => {
    const p = plan({ quotedAt: NOW - MAX_QUOTE_AGE_SECONDS - 1 });
    expect(p.refusals.join(' ')).toMatch(/old/i);
  });

  it('refuses when no route answered, instead of falling back to a price nobody fetched', () => {
    const p = plan({ quote: null });
    expect(p.refusals.join(' ')).toMatch(/No route answered/i);
    expect(p.legs).toEqual([]);
  });

  it('refuses a chain mismatch', () => {
    expect(plan({ connectedChainId: 8453 }).refusals.join(' ')).toMatch(/chain 8453/);
  });

  it('refuses a quote tagged for another chain', () => {
    const q = { ...quote('101000000'), chainId: 8453 };
    expect(plan({ quote: q }).refusals.join(' ')).toMatch(/different chain/i);
  });

  it('refuses when the merchant is the connected wallet', () => {
    expect(plan({ buyer: MERCHANT }).refusals.join(' ')).toMatch(/payment to itself/i);
  });

  it('refuses with no wallet', () => {
    expect(plan({ buyer: null }).refusals.join(' ')).toMatch(/no signer/i);
  });

  it('still fills the disclosure on a refusal, so the numbers behind it are visible', () => {
    const p = plan({ quote: null });
    expect(p.disclosure.settleAmount).toBe(100_000_000n);
    expect(p.disclosure.merchant).toBe(MERCHANT);
  });
});

describe('paying in the settlement asset takes no route at all', () => {
  it('builds a single transfer with no swap leg and no slippage', () => {
    const p = plan({ payToken: USDC, paySymbol: 'USDC', payDecimals: 6, payAmount: 100_000_000n, quote: null });
    expect(p.sameAsset).toBe(true);
    expect(p.refusals).toEqual([]);
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0]!.kind).toBe('transfer');
    expect(p.disclosure.slippagePct).toBeNull();
    expect(p.disclosure.quoteAgeSeconds).toBeNull();
  });

  it('refuses an underpayment in the settlement asset', () => {
    const p = plan({ payToken: USDC, paySymbol: 'USDC', payDecimals: 6, payAmount: 99_000_000n, quote: null });
    expect(p.refusals.join(' ')).toMatch(/underpay/i);
  });
});

describe('sizing the pay leg is a request size, never a disclosure', () => {
  it('scales an implied rate up and adds headroom, rounding the cost UP', () => {
    // probe: 1e18 in -> 2500e6 out. target 100e6 -> 0.04e18 base, +1.5%.
    const sized = sizePayAmount({ amountIn: 10n ** 18n, amountOut: 2_500_000_000n }, 100_000_000n, 150);
    expect(sized).toBe(40_600_000_000_000_000n);
  });

  it('returns null rather than sizing a payment from a zero rate', () => {
    expect(sizePayAmount({ amountIn: 0n, amountOut: 1n }, 1n)).toBeNull();
    expect(sizePayAmount({ amountIn: 1n, amountOut: 0n }, 1n)).toBeNull();
  });
});

describe('the settlement record distinguishes a claim from a confirmation', () => {
  it('refuses a hash that is not a hash', () => {
    expect(
      buildSettlementRecord({ invoice: invoice(), payer: BUYER, txHash: '0xdead', verification: 'client-reported', recordedAt: NOW }),
    ).toBeNull();
  });

  it('records the invoice amount, never a restated one', () => {
    const rec = buildSettlementRecord({
      invoice: invoice(),
      payer: BUYER,
      txHash: `0x${'ab'.repeat(32)}`,
      verification: 'client-reported',
      recordedAt: NOW,
    })!;
    expect(rec.settleAmount).toBe(100_000_000n);
    expect(rec.verification).toBe('client-reported');
  });

  it('tells a merchant not to release goods against an unverified claim', () => {
    expect(settlementStandingText('client-reported')).toMatch(/claim, not a confirmation/i);
    expect(settlementStandingText('chain-refuted')).toMatch(/Do not release/i);
    expect(settlementStandingText('chain-confirmed')).toMatch(/receipt was read/i);
  });
});
