import { describe, it, expect } from 'vitest';
import { bnplQuote, type BnplTerms } from './useBnplQuote';

// TWO IMPLEMENTATIONS OF ONE PIECE OF MONEY ARITHMETIC.
//
// `bnplQuote` here and `NftfiBnpl.quote` in
// contracts/src/nftfi/NftfiBnpl.sol compute the same schedule. That is a
// liability by default: the browser could quietly quote a buyer a smaller
// number than the contract charges, and nothing would notice until someone
// compared their wallet against the screen.
//
// The vectors below are the pin. They are byte-identical to what the Solidity
// function returns for the same inputs, and the same vectors are asserted from
// the other side in contracts/test/nftfi/NftfiBnpl.t.sol
// (`test_quoteMatchesTheBrowsersPinnedVectors`). If either implementation
// drifts, one of the two suites goes red — which is the only arrangement in
// which having two implementations is acceptable at all.

const STANDARD: BnplTerms = {
  depositBps: 2_500,
  aprBps: 1_500,
  originationFeeBps: 0,
  instalments: 3,
  instalmentIntervalSeconds: 30 * 24 * 60 * 60,
};

describe('bnplQuote matches the contract, wei for wei', () => {
  it('4 ETH at 25% down, 15% APR, no origination fee', () => {
    const q = bnplQuote(4_000000000000000000n, STANDARD);
    expect(q).not.toBeNull();
    expect(q!.depositWei).toBe(1_000000000000000000n);
    expect(q!.financedWei).toBe(3_000000000000000000n);
    expect(q!.originationWei).toBe(0n);
    expect(q!.interestWei).toBe(73972602739726026n);
    expect(q!.totalWei).toBe(4073972602739726026n);
    expect(q!.instalmentsWei).toEqual([
      1012328767123287671n,
      1024657534246575342n,
      1036986301369863013n,
    ]);
    expect(q!.costOfCreditBps).toBe(184);
  });

  it('3 ETH with a 0.5% origination fee turned on', () => {
    const q = bnplQuote(3_000000000000000000n, { ...STANDARD, originationFeeBps: 50 });
    expect(q!.depositWei).toBe(750000000000000000n);
    expect(q!.financedWei).toBe(2250000000000000000n);
    expect(q!.originationWei).toBe(11250000000000000n);
    expect(q!.interestWei).toBe(55479452054794519n);
    expect(q!.totalWei).toBe(3066729452054794519n);
    expect(q!.costOfCreditBps).toBe(222);
  });
});

describe('the schedule adds up', () => {
  it('the instalments retire exactly the financed principal and nothing more', () => {
    const q = bnplQuote(4_000000000000000000n, STANDARD)!;
    const sum = q.instalmentsWei.reduce((a, b) => a + b, 0n);
    expect(sum).toBe(q.financedWei + q.interestWei);
  });

  it('the total is the sum of its named parts, so nothing is hidden in rounding', () => {
    const q = bnplQuote(4_000000000000000000n, STANDARD)!;
    expect(q.totalWei).toBe(q.depositWei + q.originationWei + q.financedWei + q.interestWei);
  });

  it('an indivisible financed leg puts the remainder on the last payment, never drops it', () => {
    // 10 wei financed across 3 payments: 3 + 3 + 4, not 3 + 3 + 3.
    const q = bnplQuote(40n, { ...STANDARD, aprBps: 0 })!;
    expect(q.financedWei).toBe(30n);
    expect(q.instalmentsWei).toEqual([10n, 10n, 10n]);

    const odd = bnplQuote(41n, { ...STANDARD, aprBps: 0 })!;
    const sum = odd.instalmentsWei.reduce((a, b) => a + b, 0n);
    expect(sum).toBe(odd.financedWei);
  });
});

describe('a quote that cannot exist is absent, not zero', () => {
  // A zeroed schedule on screen reads as "free". Refusing to produce one is the
  // whole reason this returns a nullable.
  it('refuses a zero or negative price', () => {
    expect(bnplQuote(0n, STANDARD)).toBeNull();
    expect(bnplQuote(-1n, STANDARD)).toBeNull();
  });

  it('refuses terms with no instalments', () => {
    expect(bnplQuote(1_000000000000000000n, { ...STANDARD, instalments: 0 })).toBeNull();
  });

  it('refuses a zero interval, which would make every payment due at once', () => {
    expect(bnplQuote(1_000000000000000000n, { ...STANDARD, instalmentIntervalSeconds: 0 })).toBeNull();
  });

  it('refuses a deposit of the whole price, which is not a credit product', () => {
    expect(bnplQuote(1_000000000000000000n, { ...STANDARD, depositBps: 10_000 })).toBeNull();
  });
});

describe('the cost of credit is never understated', () => {
  it('a zero-APR, zero-fee plan is the only way to reach a zero cost of credit', () => {
    const free = bnplQuote(4_000000000000000000n, { ...STANDARD, aprBps: 0, originationFeeBps: 0 })!;
    expect(free.costOfCreditBps).toBe(0);
    expect(free.totalWei).toBe(4_000000000000000000n);
  });

  it('any live APR produces a total above the sticker price', () => {
    const q = bnplQuote(4_000000000000000000n, STANDARD)!;
    expect(q.totalWei).toBeGreaterThan(4_000000000000000000n);
    expect(q.costOfCreditBps).toBeGreaterThan(0);
  });

  it('a longer schedule costs more, so the surface cannot make one look free', () => {
    const short = bnplQuote(4_000000000000000000n, STANDARD)!;
    const long = bnplQuote(4_000000000000000000n, { ...STANDARD, instalments: 6 })!;
    expect(long.interestWei).toBeGreaterThan(short.interestWei);
  });
});
