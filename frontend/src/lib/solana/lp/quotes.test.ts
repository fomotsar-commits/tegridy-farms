// @vitest-environment node
//
// The coins a pool may pair a token with (SOL, USDC, BAYLA), and the one reading every
// pool of two mints has.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { BAYLA_MINT as BUNGALOW_BAYLA } from '../../bungalows';
import { BAYLA_QUOTE, QUOTE_COINS, SOL_QUOTE, USDC_QUOTE, canPair, quoteCoin, quotesFor, readPair } from './quotes';

const stranger = () => Keypair.generate().publicKey.toBase58();
const SOL = SOL_QUOTE.mint;
const USDC = USDC_QUOTE.mint;
const BAYLA = BAYLA_QUOTE.mint;

describe('the pairing coins', () => {
  it('are SOL, USDC and BAYLA, in that rank order, and nothing else', () => {
    expect(QUOTE_COINS.map((q) => q.symbol)).toEqual(['SOL', 'USDC', 'BAYLA']);
    expect(new Set(QUOTE_COINS.map((q) => q.mint)).size).toBe(3);
  });

  it('SOL is the classic native mint and the only native one', () => {
    expect(SOL).toBe(NATIVE_MINT.toBase58());
    expect(SOL_QUOTE).toMatchObject({ decimals: 9, native: true, program: TOKEN_PROGRAM_ID.toBase58() });
    expect(QUOTE_COINS.filter((q) => q.native)).toEqual([SOL_QUOTE]);
  });

  it('USDC is Circle’s mainnet mint: classic program, 6 decimals', () => {
    expect(USDC_QUOTE).toEqual({ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6, native: false, program: TOKEN_PROGRAM_ID.toBase58() });
  });

  it('BAYLA is the island’s own mint, and its row is what mainnet’s mint account says', () => {
    expect(BAYLA).toBe(BUNGALOW_BAYLA);
    // The dump the local validator is seeded from: mainnet's own bytes for the BAYLA mint.
    const dump = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../scripts/solana-localnet/golden/bayla-mint.mainnet.json', import.meta.url)), 'utf8')) as {
      pubkey: string;
      account: { owner: string; data: [string, string] };
    };
    expect(dump.pubkey).toBe(BAYLA);
    expect(dump.account.owner).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(BAYLA_QUOTE.program).toBe(dump.account.owner);
    // SPL mint layout: decimals is the byte at offset 44.
    expect(Buffer.from(dump.account.data[0], 'base64')[44]).toBe(BAYLA_QUOTE.decimals);
    expect(BAYLA_QUOTE.native).toBe(false);
  });

  it('quoteCoin finds a coin by its mint and nothing by any other', () => {
    for (const q of QUOTE_COINS) expect(quoteCoin(q.mint)).toBe(q);
    expect(quoteCoin(stranger())).toBeNull();
    expect(quoteCoin('')).toBeNull();
  });
});

describe('readPair: one reading for every pool, whichever side comes first', () => {
  const X = stranger();
  const cases: Array<[string, string, string, string, string]> = [
    // [name, a, b, quote, token]
    ['a token with SOL', X, SOL, SOL, X],
    ['a token with USDC', X, USDC, USDC, X],
    ['a token with BAYLA', X, BAYLA, BAYLA, X],
    ['BAYLA with SOL is BAYLA priced in SOL', BAYLA, SOL, SOL, BAYLA],
    ['BAYLA with USDC is BAYLA priced in USDC', BAYLA, USDC, USDC, BAYLA],
    ['USDC with SOL is USDC priced in SOL', USDC, SOL, SOL, USDC],
  ];
  it.each(cases)('%s', (_n, a, b, quote, token) => {
    for (const [m0, m1] of [[a, b], [b, a]] as const) {
      const r = readPair(m0, m1);
      expect(r?.quote.mint).toBe(quote);
      expect(r?.tokenMint).toBe(token);
      expect(r?.quoteIsToken0).toBe(m0 === quote);
    }
  });

  it('two tokens that are not pairing coins have no reading', () => {
    expect(readPair(stranger(), stranger())).toBeNull();
  });

  it('a mint against itself has no reading, pairing coin or not', () => {
    expect(readPair(SOL, SOL)).toBeNull();
    expect(readPair(X, X)).toBeNull();
  });
});

describe('quotesFor: what a token can be paired with', () => {
  it('an ordinary token: all three, in rank order', () => {
    expect(quotesFor(stranger())).toEqual([SOL_QUOTE, USDC_QUOTE, BAYLA_QUOTE]);
  });

  it('a pairing coin: only the coins that outrank it, and SOL none', () => {
    expect(quotesFor(BAYLA)).toEqual([SOL_QUOTE, USDC_QUOTE]);
    expect(quotesFor(USDC)).toEqual([SOL_QUOTE]);
    expect(quotesFor(SOL)).toEqual([]);
  });

  it('agrees with readPair: a token pairs with a coin exactly when the pool reads that way round', () => {
    const mints = [stranger(), SOL, USDC, BAYLA];
    for (const token of mints) {
      for (const q of QUOTE_COINS) {
        const r = readPair(token, q.mint);
        expect(canPair(token, q), `${token} with ${q.symbol}`).toBe(r !== null && r.tokenMint === token && r.quote === q);
      }
    }
  });
});
