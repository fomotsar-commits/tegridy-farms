// The burn ledger's contract: a figure is printed only from a full reading that agrees
// with the minted record, and every token bungalow has exactly one record.

import { describe, it, expect } from 'vitest';
import { isAddress } from 'viem';
import { BUNGALOWS, DEFAULT_BUNGALOW_ID, type Bungalow } from './bungalows';
import { BURN_ADDRESSES } from './detection/exclusions';
import {
  BUNGALOW_BURN_FACTS,
  EVM_BURN_ADDRESS,
  burnFactFor,
  burnProofUrl,
  formatBurnPercent,
  formatCompactTokens,
  formatNotBurnt,
  formatWholeTokens,
  homeBurnRoom,
  mintedRawOf,
  tallyBurn,
  type BurnFact,
  type BurnTally,
} from './bungalowBurn';

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

function fact(id: string): BurnFact {
  const f = BUNGALOW_BURN_FACTS[id];
  if (!f) throw new Error(`no burn fact for ${id}`);
  return f;
}

function okTally(t: BurnTally): Extract<BurnTally, { ok: true }> {
  if (!t.ok) throw new Error(`expected a tally, got mismatch ${t.reason}`);
  return t;
}

describe('the burn record covers the registry', () => {
  const tokenRooms = BUNGALOWS.filter((b) => b.address);

  it('has one record for every bungalow with a token, and none for the unmarked lot', () => {
    expect(tokenRooms.length, 'the loop below must not run empty').toBe(12);
    expect(new Set(Object.keys(BUNGALOW_BURN_FACTS))).toEqual(new Set(tokenRooms.map((b) => b.id)));
    const unmarked = BUNGALOWS.find((b) => !b.address);
    expect(unmarked?.id).toBe('nb1');
    expect(burnFactFor(unmarked!)).toBeNull();
  });

  it.each(tokenRooms.map((b) => [b.id, b] as const))('%s: the record fits its token', (_id, b) => {
    const f = fact(b.id);
    expect(f.minted).toMatch(/^[1-9][0-9]*$/);
    // A registry row that states decimals must agree; every Solana mint here is 6, every EVM token 18.
    expect(f.decimals).toBe(b.chain === 'solana' ? 6 : 18);
    if (b.decimals !== undefined) expect(f.decimals).toBe(b.decimals);
    // The mint transaction is on the token's own chain: a hash on EVM, a signature on Solana.
    if (b.chain === 'solana') expect(f.mintTx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
    else expect(f.mintTx).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('counts a fall in supply for every token except the three with a bridge burn', () => {
    const notCounted = Object.entries(BUNGALOW_BURN_FACTS).filter(([, f]) => !f.countsSupplyDrop).map(([id]) => id);
    expect(notCounted.sort()).toEqual(['drb', 'jbm', 'qr']);
  });

  // Facts about past transactions: they never change, so they are pinned as literals. A shape
  // check alone would pass a minted figure with one zero too many (SOY would read 90% burnt).
  it('pins what each token minted', () => {
    expect(Object.fromEntries(Object.entries(BUNGALOW_BURN_FACTS).map(([id, f]) => [id, f.minted]))).toEqual({
      toweli: '1000000000',
      bayla: '1000000000',
      pepe: '420690000000000',
      qr: '100000000000',
      mfer: '1000000000',
      bnkr: '100000000000',
      drb: '100000000000',
      bobo: '1000000000',
      jbm: '100000000000',
      soy: '1000000000',
      brainlet: '1000000000',
      rizz: '1000000000',
    });
  });

  it('counts a token contract\'s own balance for the seven EVM tokens proven stuck, and for no other', () => {
    const counted = Object.entries(BUNGALOW_BURN_FACTS).filter(([, f]) => f.countsOwnBalance).map(([id]) => id);
    expect(counted.sort()).toEqual(['bnkr', 'drb', 'jbm', 'mfer', 'pepe', 'qr', 'toweli']);
  });

  it('reads the same burn address the scanner excludes from holders', () => {
    // The literal, not only set membership: the zero address is in that set too, and it holds 0.
    expect(EVM_BURN_ADDRESS).toBe('0x000000000000000000000000000000000000dEaD');
    expect(isAddress(EVM_BURN_ADDRESS, { strict: true })).toBe(true);
    expect(BURN_ADDRESSES.has(EVM_BURN_ADDRESS.toLowerCase())).toBe(true);
  });
});

describe('tallyBurn', () => {
  it('TOWELI: nothing destroyed, so the burn is the burn-address balance', () => {
    const t = okTally(tallyBurn(fact('toweli'), {
      supplyRaw: 1_000_000_000n * E18,
      decimals: 18,
      atBurnAddressRaw: 257_626_865_814586290000000000n,
    }));
    expect(t.destroyedRaw).toBe(0n);
    expect(t.burntRaw).toBe(257_626_865_814586290000000000n);
    expect(t.notBurntRaw).toBe(1_000_000_000n * E18 - 257_626_865_814586290000000000n);
    expect(t.burntPpm).toBe(257_626);
  });

  it('PEPE: the burn address and the supply fall are both counted, once each', () => {
    const supplyRaw = 420_689_899_645_071_695787564425681079n;
    const atBurnAddressRaw = 6_917_544_537_127_740524900319904797n;
    const t = okTally(tallyBurn(fact('pepe'), { supplyRaw, decimals: 18, atBurnAddressRaw }));
    expect(t.destroyedRaw).toBe(100_354_928_304212435574318921n);
    expect(t.burntRaw).toBe(atBurnAddressRaw + 100_354_928_304212435574318921n);
    expect(t.burntRaw + t.notBurntRaw!).toBe(t.mintedRaw);
    expect(t.burntPpm).toBe(16_443);
  });

  it('QR: a fall in supply is not counted, because a bridge can cause one', () => {
    const minted = 100_000_000_000n * E18;
    const t = okTally(tallyBurn(fact('qr'), {
      supplyRaw: minted - 5_000_000_000n * E18,
      decimals: 18,
      atBurnAddressRaw: 6_669_949_934n * E18,
    }));
    expect(t.destroyedRaw).toBeUndefined();
    expect(t.burntRaw).toBe(6_669_949_934n * E18);
    // The fall is reported beside the burn, and "not burnt" is withheld: the card cannot
    // tell a burn() from a bridge-out, so it cannot say how much is left.
    expect(t.uncountedFallRaw).toBe(5_000_000_000n * E18);
    expect(t.notBurntRaw).toBeUndefined();
    expect(formatNotBurnt(t)).toBeNull();
  });

  it('QR at full supply: no fall, so what is not burnt is known', () => {
    const minted = 100_000_000_000n * E18;
    const t = okTally(tallyBurn(fact('qr'), { supplyRaw: minted, decimals: 18, atBurnAddressRaw: 6_669_949_934n * E18 }));
    expect(t.uncountedFallRaw).toBe(0n);
    expect(t.notBurntRaw).toBe(minted - 6_669_949_934n * E18);
    expect(formatNotBurnt(t)).toBe('93,330,050,066');
  });

  it('a token whose fall IS counted reports no uncounted fall', () => {
    const t = okTally(tallyBurn(fact('rizz'), { supplyRaw: 773_739_826_938731n, decimals: 6 }));
    expect(t.uncountedFallRaw).toBeUndefined();
  });

  it('Solana: no burn address is read, so the burn is minted minus supply', () => {
    const t = okTally(tallyBurn(fact('rizz'), { supplyRaw: 773_739_826_938731n, decimals: 6 }));
    expect(t.atBurnAddressRaw).toBeUndefined();
    expect(t.destroyedRaw).toBe(226_260_173_061269n);
    expect(t.burntRaw).toBe(226_260_173_061269n);
    expect(t.burntPpm).toBe(226_260);
  });

  it('a read zero is a zero: nothing burnt is a figure, not a failure', () => {
    const t = okTally(tallyBurn(fact('bnkr'), { supplyRaw: 100_000_000_000n * E18, decimals: 18, atBurnAddressRaw: 0n }));
    expect(t.burntRaw).toBe(0n);
    expect(formatBurnPercent(t)).toBe('0%');
  });

  it('gives no figure when the chain reports other decimals than the record', () => {
    expect(tallyBurn(fact('bayla'), { supplyRaw: 989_301_008n * E6, decimals: 9 }))
      .toEqual({ ok: false, reason: 'decimals' });
  });

  it('gives no figure when the supply is larger than everything ever minted', () => {
    // The record is wrong, or the token minted again. For the bridged three this is a bridge in.
    for (const id of ['toweli', 'jbm', 'soy']) {
      const f = fact(id);
      const reading = id === 'soy'
        ? { supplyRaw: mintedRawOf(f) + 1n, decimals: f.decimals }
        : { supplyRaw: mintedRawOf(f) + 1n, decimals: f.decimals, atBurnAddressRaw: 0n };
      expect(tallyBurn(f, reading), id).toEqual({ ok: false, reason: 'supply-above-minted' });
    }
  });

  it('gives no figure when the burn address holds more than the whole supply', () => {
    expect(tallyBurn(fact('mfer'), { supplyRaw: 10n * E18, decimals: 18, atBurnAddressRaw: 11n * E18 }))
      .toEqual({ ok: false, reason: 'balances-above-supply' });
  });

  it('MFER: tokens stuck in the token\'s own contract are counted, beside the burn address and the fall', () => {
    const t = okTally(tallyBurn(fact('mfer'), {
      supplyRaw: 999_997_819_542365138940470525n,
      decimals: 18,
      atBurnAddressRaw: 934_220_813059864763270444n,
      inOwnContractRaw: 364_950_370401477478889761n,
    }));
    expect(t.inOwnContractRaw).toBe(364_950_370401477478889761n);
    expect(t.destroyedRaw).toBe(2_180_457634861059529475n);
    expect(t.burntRaw).toBe(934_220_813059864763270444n + 364_950_370401477478889761n + 2_180_457634861059529475n);
    expect(formatWholeTokens(t.burntRaw, 18)).toBe('1,301,351');
    expect(formatBurnPercent(t)).toBe('0.1301%');
    expect(t.burntRaw + t.notBurntRaw!).toBe(t.mintedRaw);
  });

  it('an own balance is counted only where the record proves it stuck', () => {
    // The same reading against a record without the flag: the own balance is left out, not added.
    const unproven: BurnFact = { ...fact('mfer'), countsOwnBalance: undefined };
    const t = okTally(tallyBurn(unproven, {
      supplyRaw: 1_000_000_000n * E18, decimals: 18, atBurnAddressRaw: 100n * E18, inOwnContractRaw: 50n * E18,
    }));
    expect(t.inOwnContractRaw).toBeUndefined();
    expect(t.burntRaw).toBe(100n * E18);
  });

  it('gives no figure when the burn address and the own balance together exceed the supply', () => {
    // Each alone fits; a reading where the two overlap or are wrong must not be summed into a burn.
    expect(tallyBurn(fact('mfer'), { supplyRaw: 10n * E18, decimals: 18, atBurnAddressRaw: 6n * E18, inOwnContractRaw: 6n * E18 }))
      .toEqual({ ok: false, reason: 'balances-above-supply' });
  });
});

describe('the figures as printed', () => {
  it('prints whole tokens with commas, rounded down', () => {
    expect(formatWholeTokens(6_917_544_537_127_740524900319904797n, 18)).toBe('6,917,544,537,127');
    expect(formatWholeTokens(7_165_822529n, 6)).toBe('7,165');
  });

  it('a real amount under one token is never printed as 0', () => {
    expect(formatWholeTokens(999_999n, 6)).toBe('under 1');
    expect(formatWholeTokens(1n, 18)).toBe('under 1');
    expect(formatCompactTokens(999_999n, 6)).toBe('under 1');
    // A read zero is still a zero.
    expect(formatWholeTokens(0n, 6)).toBe('0');
    expect(formatCompactTokens(0n, 18)).toBe('0');
  });

  it('Not burnt is whole Ever minted minus whole Burnt, so the two rows add up to the third', () => {
    const t = okTally(tallyBurn(fact('pepe'), {
      supplyRaw: 420_689_899_645_071_695787564425681079n,
      decimals: 18,
      atBurnAddressRaw: 6_917_544_537_127_740524900319904797n,
    }));
    const n = (s: string) => BigInt(s.replaceAll(',', ''));
    expect(formatNotBurnt(t)).toBe('413,772,355,107,944');
    expect(n(formatWholeTokens(t.burntRaw, 18)) + n(formatNotBurnt(t)!)).toBe(n(formatWholeTokens(t.mintedRaw, 18)));
  });

  it('shortens a headline figure and never rounds it up', () => {
    expect(formatCompactTokens(6_917_644_892_056n * E18, 18)).toBe('6.91T');
    expect(formatCompactTokens(420_690_000_000_000n * E18, 18)).toBe('420.69T');
    expect(formatCompactTokens(257_626_865n * E18, 18)).toBe('257.62M');
    expect(formatCompactTokens(1_999_999_999n * E6, 6)).toBe('1.99B');
    expect(formatCompactTokens(1_000_000_000n * E6, 6)).toBe('1.00B');
    expect(formatCompactTokens(936_401n * E18, 18)).toBe('936,401');
  });

  function pct(id: string, supplyWhole: bigint, burnWhole?: bigint): string {
    const f = fact(id);
    const unit = 10n ** BigInt(f.decimals);
    return formatBurnPercent(okTally(tallyBurn(f, {
      supplyRaw: supplyWhole * unit,
      decimals: f.decimals,
      ...(burnWhole === undefined ? {} : { atBurnAddressRaw: burnWhole * unit }),
    })));
  }

  it('prints the percent rounded down, with more places for a small burn', () => {
    expect(pct('toweli', 1_000_000_000n, 257_626_865n)).toBe('25.76%');
    expect(pct('jbm', 100_000_000_000n, 9_270_681_207n)).toBe('9.27%');
    expect(pct('rizz', 773_739_826n)).toBe('22.62%');
    expect(pct('mfer', 999_997_819n, 934_220n)).toBe('0.0936%');
    expect(pct('bobo', 999_992_834n)).toBe('0.0007%');
    expect(pct('bnkr', 100_000_000_000n, 500_000_000n)).toBe('0.5%');
    expect(pct('toweli', 0n, 0n)).toBe('100.00%');
    // The two sides of the 1% line, where the format changes.
    expect(pct('bnkr', 100_000_000_000n, 1_000_000_000n)).toBe('1.00%');
    expect(pct('bnkr', 100_000_000_000n, 999_900_000n)).toBe('0.9999%');
  });

  it('a burn too small for four decimals is never printed as 0%', () => {
    expect(pct('pepe', 420_690_000_000_000n, 1n)).toBe('under 0.0001%');
  });
});

describe('where the card sends a reader to check', () => {
  const room = (id: string): Bungalow => BUNGALOWS.find((b) => b.id === id)!;

  it('links the burn address holding on EVM and the mint on Solana', () => {
    expect(burnProofUrl(room('toweli'))).toBe(`https://etherscan.io/token/${room('toweli').address}?a=${EVM_BURN_ADDRESS}`);
    expect(burnProofUrl(room('drb'))).toBe(`https://basescan.org/token/${room('drb').address}?a=${EVM_BURN_ADDRESS}`);
    expect(burnProofUrl(room('bayla'))).toBe(`https://solscan.io/token/${room('bayla').address}`);
    expect(burnProofUrl(room('nb1'))).toBeNull();
  });
});

describe('homeBurnRoom', () => {
  const pepe = BUNGALOWS.find((b) => b.id === 'pepe')!;

  it('shows the worn room, TOWELI in its own room, and nothing on the venue front door', () => {
    expect(homeBurnRoom(pepe, false)?.id).toBe('pepe');
    expect(homeBurnRoom(null, true)?.id).toBe(DEFAULT_BUNGALOW_ID);
    expect(homeBurnRoom(null, false)).toBeNull();
    // An identity room wins even if the arrival flag is set: one card, never two.
    expect(homeBurnRoom(pepe, true)?.id).toBe('pepe');
  });
});
