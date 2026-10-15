// @vitest-environment node
// Carried over from the page slice's own `curve.test.ts`, which is deleted: its
// maths, decoders and phase table were duplicates of the core's, but these
// presentational assertions were not, and every one of them pins a way this repo
// has previously shipped a wrong number.
import { describe, it, expect } from 'vitest';
import {
  LAUNCH_ERROR_COPY,
  buyBlockedReason,
  decimalCommaToPoint,
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

  it('never renders a non-zero amount as 0, at any decimals and any precision', () => {
    // 0.00005 of an 8-decimal token priced in hundreds of SOL is real money, and the
    // money rows printed it as "0 tokens" beside a SOL figure that had its floor.
    expect(formatTokenAmount(5_000n, 8, 4).text).not.toBe('0');
    for (let d = 0; d <= 18; d++) {
      for (let shown = 0; shown <= d; shown++) {
        for (const raw of [1n, 9n, 10n ** BigInt(d) - 1n, 10n ** BigInt(d)]) {
          if (raw === 0n) continue;
          const { text } = formatTokenAmount(raw, d, shown);
          expect(/[1-9]/.test(text), `${raw} at ${d} decimals, ${shown} shown: "${text}"`).toBe(true);
        }
      }
    }
    // Nothing is still nothing, and an amount the column can show is shown, not floored.
    expect(formatTokenAmount(0n, 8, 4).text).toBe('0');
    expect(formatTokenAmount(10_000n, 8, 4).text).toBe('0.0001');
  });

  it('floors exactly as formatSol does, so the two halves of a money row read alike', () => {
    for (const raw of [1n, 99_999n, 100_000n, 123_456_789n]) {
      for (const shown of [0, 2, 4, 9]) expect(formatTokenAmount(raw, 9, shown).text).toBe(formatSol(raw, shown));
    }
  });
});

describe('decimalCommaToPoint', () => {
  const parse = (text: string) => parseDecimalToBaseUnits(text, 9);
  /** What the box holds after each key of `keys`, typed into an empty box. */
  const typed = (keys: string) => [...keys].reduce((box, k) => decimalCommaToPoint(box + k, box), '');
  const pasted = (text: string) => decimalCommaToPoint(text, '');

  it('reads a typed comma as the decimal point: a comma-region phone keypad has no "."', () => {
    expect(parse(typed('0,5'))).toBe(500_000_000n);
    expect(parse(typed(',5'))).toBe(500_000_000n);
    // Three decimals typed one key at a time are a fraction, not thousands.
    expect(parse(typed('68,066'))).toBe(68_066_000_000n);
    expect(typed('0.5')).toBe('0.5');
  });

  it('never reads a pasted thousands separator as a decimal point', () => {
    // The page prints "68,066.397104" and "1,393,591". Each means what it says or is
    // refused; "68,066" is never 68.066 and "1,234.5" is never 1.2345.
    const means: Record<string, bigint> = {
      '68,066': 68_066n * SOL,
      '68,066.397104': 68_066_397_104_000n,
      '1,393,591': 1_393_591n * SOL,
      '1,234.5': 1_234_500_000_000n,
      '1.234,5': 1_234_500_000_000n,
    };
    for (const [text, exact] of Object.entries(means)) expect([null, exact], text).toContain(parse(pasted(text)));
  });

  it('reads a pasted comma that can only be a decimal point', () => {
    expect(parse(pasted('0,5'))).toBe(500_000_000n);
    expect(parse(pasted('12,25'))).toBe(12_250_000_000n);
  });

  it('never re-reads a comma already in the box, so fixing a refused paste cannot shrink it', () => {
    // "1,393,591" pasted and refused, then its second comma deleted: not 1.393591.
    expect(parse(decimalCommaToPoint('1,393591', '1,393,591'))).toBeNull();
    expect(parse(decimalCommaToPoint('68,06', '68,066'))).toBeNull();
    expect(parse(decimalCommaToPoint('1393591', '1,393591'))).toBe(1_393_591n * SOL);
  });

  it('changes nothing but that one comma', () => {
    for (const next of ['', '1', '1.5', 'abc', '1e9', '-1', ' 0,5', '0,5x', '1,2,3', ',,', '1,5']) {
      for (const prev of ['', '1', '1,']) expect([next, next.replace(',', '.')]).toContain(decimalCommaToPoint(next, prev));
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

  it('still accepts the shapes an amount field actually produces mid-typing', () => {
    // The rewrite for ReDoS replaced two explicit '' / '.' rejections with the regex
    // itself, so pin every branch rather than trusting the alternation reads right.
    expect(parseDecimalToBaseUnits('123', 9)).toBe(123_000_000_000n);
    expect(parseDecimalToBaseUnits('12.', 9)).toBe(12_000_000_000n); // trailing dot
    expect(parseDecimalToBaseUnits('.5', 9)).toBe(500_000_000n); // leading dot
    expect(parseDecimalToBaseUnits('.', 9)).toBeNull();
    expect(parseDecimalToBaseUnits('..5', 9)).toBeNull();
    expect(parseDecimalToBaseUnits('1.2.3', 9)).toBeNull();
  });

  it('refuses an absurdly long input instead of grinding on it', () => {
    // u64 max is 20 digits, so nothing legitimate approaches the cap. The cap — not the
    // regex rewrite — is what makes the backtracking unreachable, so it is what gets
    // pinned. A wall-clock assertion was tried here and deliberately removed: the old
    // pattern is POLYNOMIAL, not exponential, so 5k characters still matched in 4ms and
    // the timing passed on the vulnerable code. A test that cannot fail on the bug it
    // names is worse than no test.
    expect(parseDecimalToBaseUnits('9'.repeat(80), 9)).not.toBeNull();
    expect(parseDecimalToBaseUnits('9'.repeat(81), 9)).toBeNull();
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

  // F13/UX7: every launch's price read "1.502e-9 SOL per token".
  it('writes a tiny price out in full, four significant digits, never in e-notation', () => {
    // 1.502e-6 lamports per base unit at 6 decimals = 1.502e-9 SOL per token.
    expect(spotPriceLabel(1.502e-6, 6)).toEqual({ value: '0.000000001502', unit: 'SOL per token' });
    expect(spotPriceLabel(1e-5, 6).value).toBe('0.00000001');
    expect(spotPriceLabel(3.3e-12).value).toBe('0.000000000003300'.replace(/0+$/, ''));
    expect(spotPriceLabel(2.5e12).value).toBe('2500000000000');
    for (const p of [1.502e-6, 1e-5, 3.3e-12, 2.5e12, 7e-20]) expect(spotPriceLabel(p, 6).value).not.toMatch(/e/i);
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
    expect(Object.keys(LAUNCH_ERROR_CODES).length).toBe(25);
  });

  it('returns null for a code outside the program rather than guessing', () => {
    expect(launchErrorName(5999)).toBeNull();
    expect(launchErrorName(6025)).toBeNull();
    expect(launchErrorName(0)).toBeNull();
  });
});
