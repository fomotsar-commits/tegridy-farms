// @vitest-environment node
// A pool's heading comes from the site's own registry, by mint address, never from what
// the token's metadata says it is called.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { pairAccessibleName, pairLabel, registryToken, tierLabel, tokenSymbol } from './identity';
import { buildPool, viewOf } from './testkit.fixture';
import { BAYLA_MINT, USDC_MINT, WSOL_MINT, type TokenSafety } from './tokenSafety';
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

  it('names an unknown mint by its short address, whatever it calls itself', () => {
    expect(tokenSymbol(FAKE_BAYLA)).toBe(SHORT);
  });
});

describe('pairLabel: the heading is built from the registry and the pool, never from a claim', () => {
  it('a token whose metadata says BAYLA at a mint that is not the registry’s is headed by its short address', () => {
    // The claim rides along, as a card has it beside the view. The heading must not read it.
    const claimed: Heading & { safety: typeof CLAIMS_BAYLA } = { tokenMint: FAKE_BAYLA, quote: SOL_QUOTE, config: tier1(), safety: CLAIMS_BAYLA };
    expect(claimed.safety.symbol).toBe('BAYLA');
    expect(pairLabel(claimed)).toBe(`${SHORT} / SOL · 1% tier`);
    expect(pairLabel(claimed)).not.toContain('BAYLA');
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

describe('pairAccessibleName: the heading and where the pool sits', () => {
  it('reads the pair label, then "pool at" and the short pool address', () => {
    const b = buildPool({ mint: new PublicKey(BAYLA_MINT), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 6n });
    const view = viewOf(b, { sol: 10n ** 9n, tok: 10n ** 6n, origin: 'standard' });
    const address = b.address.toBase58();
    expect(view.config?.tradeFeeRate).toBe(10_000n);
    expect(pairAccessibleName(view)).toBe(`BAYLA / SOL · 1% tier pool at ${address.slice(0, 4)}…${address.slice(-4)}`);
    expect(pairAccessibleName(view)).not.toContain(address);
  });
});
