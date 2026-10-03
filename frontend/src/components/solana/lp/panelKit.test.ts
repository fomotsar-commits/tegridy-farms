// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { tokenText } from '../../../lib/solana/lp/format';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import { cannotFundText, coinAbout, coinExact, solAbout, solExact, tokensAbout, unitsExact } from './panelKit';

describe('the "about" amounts on the liquidity panels', () => {
  it('never say a real amount is 0, on the token side as on the SOL side', () => {
    // 5,000 base units of an 8-decimal token (0.00005) pairs with real SOL in a pool of
    // a token priced in hundreds of SOL. The rows used to read "0.03 SOL and 0 tokens".
    for (const raw of [1n, 5_000n, 9_999n, 10_000n, 123_456_789n]) {
      expect(tokensAbout(raw, 8), `${raw}`).toMatch(/[1-9]/);
      expect(tokenText(raw, 8), `${raw}`).toMatch(/[1-9]/);
      // At SOL's own decimals the two halves of a row are the same figure.
      expect(tokensAbout(raw, 9).replace(' tokens', '')).toBe(solAbout(raw).replace(' SOL', ''));
    }
    expect(tokensAbout(0n, 8)).toBe('0 tokens');
  });

  it('leaves an exact amount exact', () => {
    expect(unitsExact(5_000n, 8)).toBe('0.00005');
    expect(unitsExact(1n, 8)).toBe('0.00000001');
  });
});

describe('an amount of the pool’s pairing coin', () => {
  it('SOL is said exactly as the SOL helpers say it, to the character', () => {
    for (const raw of [0n, 1n, 4_999n, 5_000n, 890_880n, 123_456_789n, 1_000_000_000n, 1_234_567_890_123n]) {
      expect(coinExact(raw, SOL_QUOTE), `${raw}`).toBe(solExact(raw));
      expect(coinAbout(raw, SOL_QUOTE), `${raw}`).toBe(solAbout(raw));
    }
    // And those are these words: a thousands separator is never added to SOL.
    expect(coinExact(1_234_567_890_123n, SOL_QUOTE)).toBe('1234.567890123 SOL');
    expect(coinAbout(1_234_567_890_123n, SOL_QUOTE)).toBe('1234.5678 SOL');
  });

  it('USDC and BAYLA are printed in their own 6 decimals, with their own symbol', () => {
    expect(coinExact(250_000_000n, USDC_QUOTE)).toBe('250 USDC');
    expect(coinAbout(250_000_000n, USDC_QUOTE)).toBe('250 USDC');
    expect(coinExact(1_500_000n, BAYLA_QUOTE)).toBe('1.5 BAYLA');
    expect(coinAbout(1_500_000n, BAYLA_QUOTE)).toBe('1.5 BAYLA');
    // Exact keeps every digit the coin has; "about" keeps four.
    expect(coinExact(1_234_567_891n, USDC_QUOTE)).toBe('1,234.567891 USDC');
    expect(coinAbout(1_234_567_891n, USDC_QUOTE)).toBe('1,234.5678 USDC');
    expect(coinExact(1n, BAYLA_QUOTE)).toBe('0.000001 BAYLA');
    expect(coinExact(0n, USDC_QUOTE)).toBe('0 USDC');
  });

  it('"about" never says a real amount of a coin is 0', () => {
    for (const quote of [USDC_QUOTE, BAYLA_QUOTE]) {
      for (const raw of [1n, 99n, 100n, 12_345n]) expect(coinAbout(raw, quote), `${raw} ${quote.symbol}`).toMatch(/[1-9]/);
    }
    expect(coinAbout(1n, USDC_QUOTE)).toBe('<0.0001 USDC');
  });
});

describe('cannotFundText: a wallet that cannot fund the action is told so, and why', () => {
  const OPEN = { doing: 'open a pool', forWhat: 'the fee to open, the account deposits and network fees' };
  const SET_ASIDE = 193_989_240n;
  const SHORT = 5_960_758n;

  describe('a SOL pool: the words it has always had', () => {
    const sol = (o: { lamports?: bigint | null; setAside?: bigint | null; availableQuote: bigint | null; availableToken: bigint | null }) =>
      cannotFundText({ ...OPEN, quote: SOL_QUOTE, lamports: SHORT, setAside: SET_ASIDE, ...o });

    it('no SOL left to put in after the costs', () => {
      expect(sol({ availableQuote: 0n, availableToken: 500n })).toBe(
        'This wallet cannot open a pool yet. That needs about 0.1939 SOL for the fee to open, the account deposits and network fees before any SOL goes into the pool, and this wallet has 0.005960758 SOL.',
      );
    });

    it('no SOL to put in and none of the token', () => {
      expect(sol({ availableQuote: 0n, availableToken: 0n })).toBe(
        'This wallet cannot open a pool yet. That needs about 0.1939 SOL for the fee to open, the account deposits and network fees before any SOL goes into the pool, and this wallet has 0.005960758 SOL. It also holds none of this token, and a pool needs both.',
      );
    });

    it('none of the token', () => {
      expect(sol({ availableQuote: 1n, availableToken: 0n })).toBe('This wallet holds none of this token, so it cannot open a pool yet. A pool needs both SOL and the token.');
      expect(cannotFundText({ doing: 'add to this pool', forWhat: 'fees and account deposits', quote: SOL_QUOTE, lamports: 5n, setAside: 1n, availableQuote: 4n, availableToken: 0n })).toBe(
        'This wallet holds none of this token, so it cannot add to this pool yet. A pool needs both SOL and the token.',
      );
    });

    it('something can go in on both sides: nothing is said', () => {
      expect(sol({ availableQuote: 1n, availableToken: 1n })).toBeNull();
    });

    it('a balance that was not read is never spoken about', () => {
      // The SOL side reads 0 to put in, but the figures behind the sentence were not read.
      expect(sol({ availableQuote: 0n, availableToken: 500n, lamports: null })).toBeNull();
      expect(sol({ availableQuote: 0n, availableToken: 500n, setAside: null })).toBeNull();
      expect(sol({ availableQuote: null, availableToken: null })).toBeNull();
      expect(sol({ availableQuote: null, availableToken: 500n })).toBeNull();
      expect(sol({ availableQuote: 5n, availableToken: null })).toBeNull();
      // The token is still said when only the SOL figures are unread.
      expect(sol({ availableQuote: 0n, availableToken: 0n, lamports: null })).toBe('This wallet holds none of this token, so it cannot open a pool yet. A pool needs both SOL and the token.');
    });
  });

  describe('a USDC pool: the SOL for the costs, then USDC, then the token', () => {
    const usdc = (o: { lamports?: bigint | null; setAside?: bigint | null; availableQuote: bigint | null; availableToken: bigint | null }) =>
      cannotFundText({ ...OPEN, quote: USDC_QUOTE, lamports: SET_ASIDE, setAside: SET_ASIDE, ...o });
    const SOL_LINE =
      'This wallet cannot open a pool yet. That needs about 0.1939 SOL for the fee to open, the account deposits and network fees, and this wallet has 0.005960758 SOL. No SOL goes into the pool, but those costs are paid in SOL.';

    it('(a) too little SOL for the network fee and the account deposits: the amount needed and the amount held', () => {
      expect(usdc({ lamports: SHORT, availableQuote: 250_000_000n, availableToken: 500n })).toBe(SOL_LINE);
    });

    it('(a) leads, and names whatever else the wallet is short of', () => {
      expect(usdc({ lamports: SHORT, availableQuote: 0n, availableToken: 500n })).toBe(`${SOL_LINE} It also holds no USDC. A pool needs both USDC and the token.`);
      expect(usdc({ lamports: SHORT, availableQuote: 250_000_000n, availableToken: 0n })).toBe(`${SOL_LINE} It also holds none of this token. A pool needs both USDC and the token.`);
      expect(usdc({ lamports: SHORT, availableQuote: 0n, availableToken: 0n })).toBe(`${SOL_LINE} It also holds no USDC and none of this token. A pool needs both USDC and the token.`);
    });

    it('a wallet holding exactly the SOL the costs need is not short of SOL (the write layer’s own rule)', () => {
      expect(usdc({ lamports: SET_ASIDE, availableQuote: 1n, availableToken: 1n })).toBeNull();
      expect(usdc({ lamports: SET_ASIDE - 1n, availableQuote: 1n, availableToken: 1n })).toMatch(/^This wallet cannot open a pool yet\. That needs about/);
    });

    it('(b) no USDC', () => {
      expect(usdc({ availableQuote: 0n, availableToken: 500n })).toBe('This wallet holds no USDC, so it cannot open a pool yet. A pool needs both USDC and the token.');
    });

    it('(b) no USDC and none of the token: both are named', () => {
      expect(usdc({ availableQuote: 0n, availableToken: 0n })).toBe('This wallet holds no USDC and none of this token, so it cannot open a pool yet. A pool needs both USDC and the token.');
    });

    it('(c) none of the token', () => {
      expect(usdc({ availableQuote: 250_000_000n, availableToken: 0n })).toBe('This wallet holds none of this token, so it cannot open a pool yet. A pool needs both USDC and the token.');
    });

    it('holding no USDC is never said as a lack of SOL: a coin pool puts no SOL in', () => {
      const text = usdc({ lamports: 5n * 10n ** 9n, availableQuote: 0n, availableToken: 500n });
      expect(text).not.toMatch(/SOL/);
    });

    it('everything is there: nothing is said', () => {
      expect(usdc({ availableQuote: 1n, availableToken: 1n })).toBeNull();
    });

    it('a balance that was not read is never spoken about', () => {
      // SOL unread (either figure): the SOL line is not said, even for a wallet that would be short.
      expect(usdc({ lamports: null, availableQuote: 1n, availableToken: 1n })).toBeNull();
      expect(usdc({ lamports: SHORT, setAside: null, availableQuote: 1n, availableToken: 1n })).toBeNull();
      // USDC unread: not "no USDC". The token unread: not "none of this token".
      expect(usdc({ availableQuote: null, availableToken: 500n })).toBeNull();
      expect(usdc({ availableQuote: 250_000_000n, availableToken: null })).toBeNull();
      expect(usdc({ lamports: null, setAside: null, availableQuote: null, availableToken: null })).toBeNull();
      // What WAS read is still said, and only that.
      expect(usdc({ lamports: SHORT, availableQuote: null, availableToken: null })).toBe(SOL_LINE);
      expect(usdc({ lamports: null, availableQuote: 0n, availableToken: null })).toBe('This wallet holds no USDC, so it cannot open a pool yet. A pool needs both USDC and the token.');
      expect(usdc({ availableQuote: null, availableToken: 0n })).toBe('This wallet holds none of this token, so it cannot open a pool yet. A pool needs both USDC and the token.');
    });

    it('BAYLA is named as BAYLA', () => {
      expect(cannotFundText({ doing: 'add to this pool', forWhat: 'fees and account deposits', quote: BAYLA_QUOTE, lamports: 10n, setAside: 5n, availableQuote: 0n, availableToken: 3n })).toBe(
        'This wallet holds no BAYLA, so it cannot add to this pool yet. A pool needs both BAYLA and the token.',
      );
    });
  });
});
