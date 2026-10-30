// @vitest-environment node
// A pool's heading: our coins and the pairing coins by the site's own registry, by mint
// address; every other coin by the ticker it gives itself, and a copy of a well-known
// ticker as "fake X".
import { describe, it, expect } from 'vitest';
import { claimedTicker, pairLabel, registryToken, siteNamed, tierLabel, tokenSymbol, tokenTicker } from './identity';
import { BAYLA_MINT, USDC_MINT, USDT_MINT, WSOL_MINT, type TokenSafety } from './tokenSafety';
import { SOL_QUOTE, USDC_QUOTE } from './quotes';
import type { PoolView } from './poolFinder';
import type { AmmConfigView } from '../cpswap/program';

/**
 * A mint that is NOT the registry's BAYLA but shares its first four and last four
 * characters (one middle character differs): the grinded vanity collision the attacker
 * named (DESIGN 2.A6, C2). Its metadata calls itself BAYLA.
 */
const FAKE_BAYLA = `${BAYLA_MINT.slice(0, 20)}k${BAYLA_MINT.slice(21)}`;
const SHORT = '7hmV…pump';

/** The public tier's own fee settings (1% a trade), as the pool's config account reads. */
function tier1(over: Partial<AmmConfigView> = {}): AmmConfigView {
  return {
    address: 'tier',
    index: 1,
    disableCreatePool: false,
    tradeFeeRate: 10_000n,
    protocolFeeRate: 160_000n,
    fundFeeRate: 0n,
    createPoolFee: 150_000_000n,
    creatorFeeRate: 0n,
    protocolOwner: 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd',
    fundOwner: 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd',
    ...over,
  };
}

/** What the token check read about the fake: it claims BAYLA's name and symbol. */
const CLAIMS_BAYLA: Extract<TokenSafety, { kind: 'read' }> = {
  kind: 'read',
  mint: FAKE_BAYLA,
  verdict: 'ok',
  blocks: [],
  warnings: [],
  facts: null,
  name: 'BAYLA',
  symbol: 'BAYLA',
  metadataSource: 'none',
};

type Heading = Pick<PoolView, 'tokenMint' | 'quote' | 'config'>;

/** What the token check read for `mint`: it calls itself `symbol`. */
const claims = (mint: string, symbol: string | null): TokenSafety => ({ ...CLAIMS_BAYLA, mint, name: symbol, symbol });
/** A coin off the registry, at an address of its own. */
const OTHER = 'Ep5tnKTSkLDeQ12ctS3RhQNcbcApkcyJcGPgHh4dpump';

describe('registryToken: the site registry, by Solana mint address', () => {
  it('finds BAYLA by its mint, and nothing by a mint that only shares its first and last four characters', () => {
    expect(BAYLA_MINT).toHaveLength(44);
    expect(FAKE_BAYLA).toHaveLength(44);
    expect(FAKE_BAYLA).not.toBe(BAYLA_MINT);
    expect(FAKE_BAYLA.slice(0, 4)).toBe(BAYLA_MINT.slice(0, 4));
    expect(FAKE_BAYLA.slice(-4)).toBe(BAYLA_MINT.slice(-4));
    expect(registryToken(BAYLA_MINT)).toEqual({ id: 'bayla', symbol: 'BAYLA' });
    expect(registryToken(FAKE_BAYLA)).toBeNull();
  });

  it('knows no room for SOL or USDC: they are pairing coins, not residents', () => {
    expect(registryToken(WSOL_MINT)).toBeNull();
    expect(registryToken(USDC_MINT)).toBeNull();
  });
});

describe('tokenSymbol: registry, then pairing coin, then the short address', () => {
  it('names a resident by the registry and a pairing coin by quotes.ts', () => {
    expect(tokenSymbol(BAYLA_MINT)).toBe('BAYLA');
    expect(tokenSymbol(WSOL_MINT)).toBe('SOL');
    expect(tokenSymbol(USDC_MINT)).toBe('USDC');
  });

  it('names a mint off the registry by its short address when no check was read for it', () => {
    expect(tokenSymbol(FAKE_BAYLA)).toBe(SHORT);
    expect(tokenSymbol(FAKE_BAYLA, null)).toBe(SHORT);
    expect(tokenSymbol(OTHER, { kind: 'unread', mint: OTHER, detail: 'HTTP 429' })).toBe('Ep5t…pump');
    expect(tokenSymbol(OTHER, { kind: 'absent', mint: OTHER })).toBe('Ep5t…pump');
    expect(tokenTicker(OTHER)).toBeNull();
  });
});

describe('tokenTicker: every coin shows its ticker (owner ruling 2026-10-22)', () => {
  it('a coin off the registry shows the ticker it gives itself', () => {
    expect(tokenTicker(OTHER, claims(OTHER, 'CRYING'))).toBe('CRYING');
    expect(tokenSymbol(OTHER, claims(OTHER, 'CRYING'))).toBe('CRYING');
    expect(siteNamed(OTHER)).toBe(false);
  });

  it('our coins and the pairing coins keep the site’s name, whatever their check says', () => {
    expect(tokenTicker(BAYLA_MINT, claims(BAYLA_MINT, 'SCAM'))).toBe('BAYLA');
    expect(tokenTicker(USDC_MINT, claims(USDC_MINT, 'SCAM'))).toBe('USDC');
    expect([BAYLA_MINT, USDC_MINT, WSOL_MINT].every(siteNamed)).toBe(true);
  });

  it('a ticker copying a well-known coin at another mint reads "fake", never as the real one', () => {
    expect(tokenTicker(FAKE_BAYLA, CLAIMS_BAYLA)).toBe('fake BAYLA');
    expect(tokenTicker(OTHER, claims(OTHER, 'SOY'))).toBe('fake SOY');
    expect(tokenTicker(OTHER, claims(OTHER, 'USDC'))).toBe('fake USDC');
    expect(tokenTicker(OTHER, claims(OTHER, 'SOL'))).toBe('fake SOL');
    // TOWELI has no Solana mint at all: every TOWELI here is a copy.
    expect(tokenTicker(OTHER, claims(OTHER, 'TOWELI'))).toBe('fake TOWELI');
    // Look-alike letters and decorations fold to the name they copy: a Cyrillic О, a zero, an emoji, a suffix.
    expect(tokenTicker(OTHER, claims(OTHER, 'SОY'))).toBe('fake SОY');
    expect(tokenTicker(OTHER, claims(OTHER, 'S0Y'))).toBe('fake S0Y');
    expect(tokenTicker(OTHER, claims(OTHER, 'SOY\u{1F525}'))).toBe('fake SOY\u{1F525}');
    expect(tokenTicker(OTHER, claims(OTHER, 'BAYLA2'))).toBe('fake BAYLA2');
  });

  it('the real USDT is not called a copy of itself', () => {
    expect(tokenTicker(USDT_MINT, claims(USDT_MINT, 'USDT'))).toBe('USDT');
    expect(tokenTicker(OTHER, claims(OTHER, 'USDT'))).toBe('fake USDT');
  });

  it('a ticker is cleaned for the screen: hidden characters out, cut to 12 characters', () => {
    // A right-to-left override and a zero-width space would reorder or hide what is shown.
    expect(tokenTicker(OTHER, claims(OTHER, '‮GNIYRC​'))).toBe('GNIYRC');
    expect(tokenTicker(OTHER, claims(OTHER, 'ABCDEFGHIJKLMNOP'))).toBe('ABCDEFGHIJK…');
    // A copy hidden behind invisible characters is still a copy.
    expect(tokenTicker(OTHER, claims(OTHER, 'S​O​Y'))).toBe('fake SOY');
    // Nothing left to show is no ticker.
    expect(tokenTicker(OTHER, claims(OTHER, '​​'))).toBeNull();
    expect(tokenTicker(OTHER, claims(OTHER, ''))).toBeNull();
    expect(tokenTicker(OTHER, claims(OTHER, null))).toBeNull();
  });

  it('a check read for another mint is never used', () => {
    expect(tokenTicker(OTHER, claims(FAKE_BAYLA, 'CRYING'))).toBeNull();
    expect(tokenSymbol(OTHER, claims(FAKE_BAYLA, 'CRYING'))).toBe('Ep5t…pump');
  });
});

describe('pairLabel: our coins from the registry, every other coin by its own ticker', () => {
  it('a token whose metadata says BAYLA at a mint that is not the registry’s is headed "fake BAYLA"', () => {
    const claimed: Heading = { tokenMint: FAKE_BAYLA, quote: SOL_QUOTE, config: tier1() };
    expect(pairLabel(claimed, CLAIMS_BAYLA)).toBe('fake BAYLA / SOL · 1% tier');
    // With no check given, its short address.
    expect(pairLabel(claimed)).toBe(`${SHORT} / SOL · 1% tier`);
  });

  it('a coin off the registry is headed by its own ticker', () => {
    expect(pairLabel({ tokenMint: OTHER, quote: SOL_QUOTE, config: tier1() }, claims(OTHER, 'CRYING'))).toBe('CRYING / SOL · 1% tier');
  });

  it('the registry’s BAYLA reads BAYLA, with the pool’s coin and the tier read from its own config', () => {
    expect(pairLabel({ tokenMint: BAYLA_MINT, quote: SOL_QUOTE, config: tier1() })).toBe('BAYLA / SOL · 1% tier');
    expect(pairLabel({ tokenMint: BAYLA_MINT, quote: USDC_QUOTE, config: tier1() })).toBe('BAYLA / USDC · 1% tier');
    expect(pairLabel({ tokenMint: BAYLA_MINT, quote: SOL_QUOTE, config: tier1({ tradeFeeRate: 2_500n }) })).toBe('BAYLA / SOL · 0.25% tier');
  });

  it('a config that was not read is said, never defaulted to a tier', () => {
    expect(tierLabel(null)).toBe('tier not read');
    expect(pairLabel({ tokenMint: BAYLA_MINT, quote: SOL_QUOTE, config: null })).toBe('BAYLA / SOL · tier not read');
    expect(pairLabel({ tokenMint: BAYLA_MINT, quote: SOL_QUOTE, config: null })).not.toMatch(/1%/);
  });

  it('no heading carries an em dash', () => {
    for (const s of [pairLabel({ tokenMint: FAKE_BAYLA, quote: SOL_QUOTE, config: null }), tierLabel(null), tierLabel(tier1())]) {
      expect(s).not.toMatch(/—/);
    }
  });
});

describe('claimedTicker: the same name from a ticker read anywhere else (the swap page’s Jupiter list)', () => {
  const SOY_MINT = '8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump';
  const COPY = `${SOY_MINT.slice(0, 20)}k${SOY_MINT.slice(21)}`;

  it('a copy of an island coin’s ticker at another mint reads "fake SOY"; the real SOY reads SOY', () => {
    expect(claimedTicker(COPY, 'SOY')).toBe('fake SOY');
    expect(claimedTicker(SOY_MINT, 'SOY')).toBe('SOY');
  });

  it('our coins and the pairing coins keep the site’s name, whatever ticker the list gives them', () => {
    expect(claimedTicker(BAYLA_MINT, 'NOT BAYLA')).toBe('BAYLA');
    expect(claimedTicker(WSOL_MINT, 'Wrapped SOL')).toBe('SOL');
  });

  it('any other coin keeps its own ticker, cleaned and cut as on a pool card; none to show is null', () => {
    expect(claimedTicker(USDT_MINT, 'USDT')).toBe('USDT');
    expect(claimedTicker(COPY, 'CRYING')).toBe('CRYING');
    expect(claimedTicker(COPY, 'ABCDEFGHIJKLMNOP')).toBe(tokenTicker(COPY, { ...CLAIMS_BAYLA, mint: COPY, symbol: 'ABCDEFGHIJKLMNOP' }));
    expect(claimedTicker(COPY, '')).toBeNull();
    expect(claimedTicker(COPY, null)).toBeNull();
  });
});
