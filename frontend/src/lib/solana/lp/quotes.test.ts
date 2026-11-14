// @vitest-environment node
//
// The coins a pool may pair a token with (SOL, USDC and the island's five coins), and the
// one reading every pool of two mints has.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { BUNGALOWS, BAYLA_MINT as BUNGALOW_BAYLA } from '../../bungalows';
import { WELL_KNOWN_NAMES } from './tokenSafety';
import {
  BAYLA_QUOTE,
  BOBO_QUOTE,
  BRAINLET_QUOTE,
  ISLAND_QUOTES,
  QUOTE_COINS,
  QUOTE_COINS_IN_TURN,
  QUOTE_COINS_OR,
  RIZZ_QUOTE,
  SOL_QUOTE,
  SOY_QUOTE,
  USDC_QUOTE,
  canPair,
  quoteCoin,
  quotesFor,
  readPair,
} from './quotes';

const stranger = () => Keypair.generate().publicKey.toBase58();
const SOL = SOL_QUOTE.mint;
const USDC = USDC_QUOTE.mint;
const BAYLA = BAYLA_QUOTE.mint;
const BOBO = BOBO_QUOTE.mint;
const SOY = SOY_QUOTE.mint;
const RIZZ = RIZZ_QUOTE.mint;

/** A mainnet `getAccountInfo` dump beside the ones the local validator is seeded from. */
const dumpOf = (file: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../scripts/solana-localnet/golden/${file}`, import.meta.url)), 'utf8')) as {
    pubkey: string;
    account: { owner: string; data: [string, string] };
  };

describe('the pairing coins', () => {
  it('are SOL, USDC, then the island’s five coins, in that rank order, and nothing else', () => {
    expect(QUOTE_COINS.map((q) => q.symbol)).toEqual(['SOL', 'USDC', 'BAYLA', 'BOBO', 'SOY', 'BRAINLET', 'RIZZ']);
    expect(new Set(QUOTE_COINS.map((q) => q.mint)).size).toBe(7);
    expect(ISLAND_QUOTES).toEqual([BAYLA_QUOTE, BOBO_QUOTE, SOY_QUOTE, BRAINLET_QUOTE, RIZZ_QUOTE]);
    expect(QUOTE_COINS_OR).toBe('SOL, USDC, BAYLA, BOBO, SOY, BRAINLET or RIZZ');
    expect(QUOTE_COINS_IN_TURN).toBe('SOL pools first, then USDC, then BAYLA, then BOBO, then SOY, then BRAINLET, then RIZZ');
  });

  it('SOL is the classic native mint and the only native one', () => {
    expect(SOL).toBe(NATIVE_MINT.toBase58());
    expect(SOL_QUOTE).toMatchObject({ decimals: 9, native: true, program: TOKEN_PROGRAM_ID.toBase58() });
    expect(QUOTE_COINS.filter((q) => q.native)).toEqual([SOL_QUOTE]);
  });

  it('USDC is Circle’s mainnet mint: classic program, 6 decimals', () => {
    expect(USDC_QUOTE).toMatchObject({ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6, native: false, program: TOKEN_PROGRAM_ID.toBase58() });
  });

  it('USDC says what its issuer can do to a pool, and the coins whose mints have no freeze authority say nothing', () => {
    // USDC keeps a freeze authority; SOL has no issuer, and no island mint has a freeze or
    // a mint authority (pinned against mainnet's bytes below).
    expect(USDC_QUOTE.risk).toMatch(/can freeze any USDC account, including a pool’s own/);
    expect(USDC_QUOTE.risk).toMatch(/nobody can take liquidity out of that pool, you included/);
    expect(SOL_QUOTE.risk).toBeNull();
    for (const q of ISLAND_QUOTES) expect(q.risk, q.symbol).toBeNull();
  });

  it('the island coins are the five Solana bungalows, in bungalows.ts order, each at its bungalow’s mint', () => {
    const rooms = BUNGALOWS.filter((b) => b.chain === 'solana');
    expect(ISLAND_QUOTES.map((q) => q.mint)).toEqual(rooms.map((b) => b.address));
    expect(ISLAND_QUOTES.map((q) => q.symbol)).toEqual(rooms.map((b) => b.symbol));
    expect(BAYLA).toBe(BUNGALOW_BAYLA);
    // And the same mints the token check names as the one real coin of each ticker.
    for (const q of ISLAND_QUOTES) expect(WELL_KNOWN_NAMES.find((k) => k.label === q.symbol)?.mint, q.symbol).toBe(q.mint);
  });

  it.each(ISLAND_QUOTES.map((q) => [q.symbol, q] as const))('%s’s row is what mainnet’s mint account says, and the mint has no authority', (_s, q) => {
    const dump = dumpOf(`${q.symbol.toLowerCase()}-mint.mainnet.json`);
    expect(dump.pubkey).toBe(q.mint);
    expect(q.program).toBe(dump.account.owner);
    // SPL mint layout (the same first 82 bytes under both token programs): decimals is the
    // byte at offset 44.
    const bytes = Buffer.from(dump.account.data[0], 'base64');
    expect(bytes[44]).toBe(q.decimals);
    // No mint authority (bytes 0-3) and no freeze authority (bytes 46-49): nobody can
    // freeze a pool's account of the coin or print more, which is why its row carries no
    // risk line.
    expect(bytes.readUInt32LE(0)).toBe(0);
    expect(bytes.readUInt32LE(46)).toBe(0);
    expect(q.native).toBe(false);
  });

  it('BAYLA is under Token-2022; the other four island coins are pump.fun mints under the classic token program', () => {
    expect(BAYLA_QUOTE.program).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    for (const q of [BOBO_QUOTE, SOY_QUOTE, BRAINLET_QUOTE, RIZZ_QUOTE]) {
      expect(q.program, q.symbol).toBe(TOKEN_PROGRAM_ID.toBase58());
      expect(q.decimals, q.symbol).toBe(6);
    }
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
    ['a token with RIZZ', X, RIZZ, RIZZ, X],
    ['BAYLA with SOL is BAYLA priced in SOL', BAYLA, SOL, SOL, BAYLA],
    ['BAYLA with USDC is BAYLA priced in USDC', BAYLA, USDC, USDC, BAYLA],
    ['USDC with SOL is USDC priced in SOL', USDC, SOL, SOL, USDC],
    ['BOBO with BAYLA is BOBO priced in BAYLA', BOBO, BAYLA, BAYLA, BOBO],
    ['SOY with BOBO is SOY priced in BOBO', SOY, BOBO, BOBO, SOY],
    ['RIZZ with SOL is RIZZ priced in SOL', RIZZ, SOL, SOL, RIZZ],
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
    expect(readPair(BOBO, BOBO)).toBeNull();
    expect(readPair(X, X)).toBeNull();
  });
});

describe('quotesFor: what a token can be paired with', () => {
  it('an ordinary token: all seven, in rank order', () => {
    expect(quotesFor(stranger())).toEqual([SOL_QUOTE, USDC_QUOTE, BAYLA_QUOTE, BOBO_QUOTE, SOY_QUOTE, BRAINLET_QUOTE, RIZZ_QUOTE]);
  });

  it('a pairing coin: only the coins that outrank it, and SOL none', () => {
    expect(quotesFor(RIZZ)).toEqual([SOL_QUOTE, USDC_QUOTE, BAYLA_QUOTE, BOBO_QUOTE, SOY_QUOTE, BRAINLET_QUOTE]);
    expect(quotesFor(BOBO)).toEqual([SOL_QUOTE, USDC_QUOTE, BAYLA_QUOTE]);
    expect(quotesFor(BAYLA)).toEqual([SOL_QUOTE, USDC_QUOTE]);
    expect(quotesFor(USDC)).toEqual([SOL_QUOTE]);
    expect(quotesFor(SOL)).toEqual([]);
  });

  it('agrees with readPair: a token pairs with a coin exactly when the pool reads that way round', () => {
    const mints = [stranger(), ...QUOTE_COINS.map((q) => q.mint)];
    for (const token of mints) {
      for (const q of QUOTE_COINS) {
        const r = readPair(token, q.mint);
        expect(canPair(token, q), `${token} with ${q.symbol}`).toBe(r !== null && r.tokenMint === token && r.quote === q);
      }
    }
  });
});
