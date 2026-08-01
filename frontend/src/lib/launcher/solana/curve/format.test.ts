// @vitest-environment node
// Carried over from the page slice's own `curve.test.ts`, which is deleted: its
// maths, decoders and phase table were duplicates of the core's, but these
// presentational assertions were not, and every one of them pins a way this repo
// has previously shipped a wrong number.
import { describe, it, expect } from 'vitest';
import {
  LAUNCH_ERROR_COPY,
  buyBlockedReason,
  formatSol,
  formatTokenAmount,
  isTradablePhase,
  looksLikePubkey,
  parseDecimalToBaseUnits,
  sellBlockedReason,
  spotPriceLabel,
} from './format';
import { BPS_DENOMINATOR, applySlippage } from './math';
import { LAUNCH_ERROR_CODES, launchErrorName } from './program';
import type { LaunchPhase } from './read';

const SOL = 1_000_000_000n;

describe('applySlippage', () => {
  it('rounds the floor DOWN so it never exceeds the quote', () => {
    expect(applySlippage(1_000n, 100n)).toBe(990n); // 1%
    expect(applySlippage(9_999n, 100n)).toBe(9_899n); // floor, not 9899.01
    expect(applySlippage(1_000n, 0n)).toBe(1_000n);
  });

  it('refuses a tolerance of 100% or more, which would accept any fill', () => {
    // `null`, not a permissive number and not a thrown CurveError — this is not
    // one of curve.rs's functions and must not borrow its error enum.
    expect(applySlippage(1_000n, BPS_DENOMINATOR)).toBeNull();
    expect(applySlippage(1_000n, -1n)).toBeNull();
  });

  it('refuses an amount the program could never have produced', () => {
    expect(applySlippage(2n ** 64n, 100n)).toBeNull();
  });
});

describe('formatSol', () => {
  it('never renders a non-zero balance as 0', () => {
    // The defect this repo keeps re-shipping: a real value truncated to a clean
    // zero. Below display precision must read as "smaller than", not "none".
    expect(formatSol(1n)).toBe('<0.0001');
    expect(formatSol(0n)).toBe('0');
    expect(formatSol(SOL)).toBe('1');
    expect(formatSol(1_500_000_000n)).toBe('1.5');
    expect(formatSol(86n * SOL)).toBe('86');
  });

  it('truncates rather than rounds, so an amount is never overstated', () => {
    expect(formatSol(999_999_990n, 4)).toBe('0.9999');
  });

  it('keeps the floor in fixed-width mode, where a padded zero is the trap', () => {
    // The chart's own former copy of this function had no floor and rendered a
    // single lamport as "0.0000".
    expect(formatSol(1n, 4, { fixed: true })).toBe('<0.0001');
    expect(formatSol(0n, 4, { fixed: true })).toBe('0.0000');
    expect(formatSol(SOL, 4, { fixed: true })).toBe('1.0000');
    expect(formatSol(-SOL, 2, { fixed: true })).toBe('-1.00');
  });
});

describe('formatTokenAmount', () => {
  it('says it is showing base units when decimals could not be read', () => {
    // Decimals are not on the curve and NOT constrained by the program — the
    // tests use 9 but nothing enforces it. Assuming 9 mis-scales every number.
    const r = formatTokenAmount(1_234_567_890n, null);
    expect(r.isBaseUnits).toBe(true);
    expect(r.text).toBe('1234567890');
  });

  it('scales by the mint decimals when they were read', () => {
    const r = formatTokenAmount(1_234_567_890n, 9);
    expect(r.isBaseUnits).toBe(false);
    expect(r.text).toBe('1.2345');
  });

  it('does not assume 9 — a 6-decimal mint scales differently', () => {
    expect(formatTokenAmount(1_234_567_890n, 6).text).toBe('1,234.5678');
  });

  it('falls back to base units for a decimals value that cannot be real', () => {
    for (const d of [-1, 9.5, 99]) {
      expect(formatTokenAmount(1_234_567_890n, d).isBaseUnits).toBe(true);
    }
  });
});

describe('parseDecimalToBaseUnits', () => {
  it('parses exactly and rejects junk rather than coercing it to zero', () => {
    expect(parseDecimalToBaseUnits('1.5', 9)).toBe(1_500_000_000n);
    expect(parseDecimalToBaseUnits('0.000000001', 9)).toBe(1n);
    expect(parseDecimalToBaseUnits('', 9)).toBeNull();
    expect(parseDecimalToBaseUnits('abc', 9)).toBeNull();
    expect(parseDecimalToBaseUnits('-1', 9)).toBeNull();
    expect(parseDecimalToBaseUnits('1e9', 9)).toBeNull();
    // More precision than the mint has is a mistake, not a rounding opportunity.
    expect(parseDecimalToBaseUnits('1.0000000001', 9)).toBeNull();
  });
});

describe('looksLikePubkey', () => {
  it('accepts a plausible base58 key and rejects an obvious typo', () => {
    expect(looksLikePubkey('So11111111111111111111111111111111111111112')).toBe(true);
    expect(looksLikePubkey('  So11111111111111111111111111111111111111112  ')).toBe(true);
    expect(looksLikePubkey('not-an-address!!')).toBe(false);
    expect(looksLikePubkey('')).toBe(false);
    // 0, O, I and l are not in the base58 alphabet.
    expect(looksLikePubkey('0'.repeat(43))).toBe(false);
  });
});

describe('spotPriceLabel', () => {
  it('never assumes 9 decimals — with no mint read it reports base units', () => {
    const label = spotPriceLabel(0.0000145);
    expect(label.unit).toBe('lamports per base unit');
    expect(label.value).not.toBe('0');
  });

  it('renders an unreadable price as unreadable, not as zero', () => {
    expect(spotPriceLabel(Number.NaN)).toEqual({ value: '—', unit: 'unreadable' });
    expect(spotPriceLabel(Number.POSITIVE_INFINITY).unit).toBe('unreadable');
  });
});

describe('buy/sell gating', () => {
  it('halts buys when paused but leaves selling open (lib.rs:453 vs 563-564)', () => {
    const trading: LaunchPhase = { kind: 'trading' };
    expect(buyBlockedReason(trading, true)).toBe('Paused');
    // A pause stops new money entering; it must never strand holders.
    expect(sellBlockedReason(trading)).toBeNull();
  });

  it('blocks buys on a fully funded curve with a DIFFERENT reason than a graduated one', () => {
    expect(buyBlockedReason({ kind: 'awaiting-migration' }, false)).toBe('AwaitingMigration');
    expect(buyBlockedReason({ kind: 'graduated', pool: undefined as never }, false)).toBe('AlreadyComplete');
    // ...and sells still work on the fully funded one.
    expect(sellBlockedReason({ kind: 'awaiting-migration' })).toBeNull();
    expect(sellBlockedReason({ kind: 'graduated', pool: undefined as never })).toBe('AlreadyComplete');
  });

  it('BLOCKS on every phase we could not establish — an unknown never permits', () => {
    // `null` from these means "nothing blocks it". A phase we failed to read is
    // not that, and returning null there would let a read failure open a trade.
    const unknown: LaunchPhase[] = [
      { kind: 'not-deployed' },
      { kind: 'not-a-program', owner: 'x' },
      { kind: 'unreadable', detail: 'timeout' },
      { kind: 'protocol-not-initialized' },
      { kind: 'pre-launch' },
    ];
    for (const p of unknown) {
      expect(buyBlockedReason(p, false)).not.toBeNull();
      expect(sellBlockedReason(p)).not.toBeNull();
    }
  });

  it('agrees with isTradablePhase about which phases are a venue', () => {
    expect(isTradablePhase({ kind: 'trading' })).toBe(true);
    expect(isTradablePhase({ kind: 'at-target' })).toBe(true);
    expect(isTradablePhase({ kind: 'awaiting-migration' })).toBe(true);
    expect(isTradablePhase({ kind: 'pre-launch' })).toBe(false);
    expect(isTradablePhase({ kind: 'unreadable', detail: 'x' })).toBe(false);
  });
});

describe('LAUNCH_ERROR_COPY', () => {
  it('has a sentence for every error the program can return', () => {
    for (const name of Object.values(LAUNCH_ERROR_CODES)) {
      expect(LAUNCH_ERROR_COPY[name], name).toBeTruthy();
    }
  });

  it('never lets AwaitingMigration read as graduated — 6019 exists to split them', () => {
    // An earlier program version returned AlreadyComplete for the fully-funded
    // case, telling callers a curve had moved to an AMM pool when it had not.
    expect(LAUNCH_ERROR_COPY.AwaitingMigration).toMatch(/NOT graduated/);
    expect(LAUNCH_ERROR_COPY.AwaitingMigration).not.toMatch(/AMM pool/i);
    expect(LAUNCH_ERROR_COPY.AlreadyComplete).toMatch(/AMM pool/i);
  });

  it('says BUYS are paused, not trading — sells are unpausable', () => {
    expect(LAUNCH_ERROR_COPY.Paused).toMatch(/[Bb]uys are paused/);
    expect(LAUNCH_ERROR_COPY.Paused).toMatch(/[Ss]elling is still open/);
  });
});

describe('launchErrorName', () => {
  it('maps Anchor codes from 6000 in declaration order (errors.rs:5-48)', () => {
    expect(launchErrorName(6000)).toBe('Overflow');
    expect(launchErrorName(6004)).toBe('Paused');
    expect(launchErrorName(6005)).toBe('AlreadyComplete');
    expect(launchErrorName(6019)).toBe('AwaitingMigration');
    expect(Object.keys(LAUNCH_ERROR_CODES).length).toBe(20);
  });

  it('returns null for a code outside the program rather than guessing', () => {
    expect(launchErrorName(5999)).toBeNull();
    expect(launchErrorName(6020)).toBeNull();
    expect(launchErrorName(0)).toBeNull();
  });
});
