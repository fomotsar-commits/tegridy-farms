// @vitest-environment node
//
// The outside price read from the chain: a PumpSwap pool's two vaults are its reserves, so a
// coin's price there costs one RPC read and no Jupiter call.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { key } from '../lp/testkit.fixture';
import { WSOL_MINT } from '../lp/tokenSafety';
import { OUTSIDE_POOLS, PUMPSWAP_PROGRAM, decodePumpPool, outsideUsd, screenUsd } from './outside';

const b58 = (b: Uint8Array) => new PublicKey(b).toBase58();
const token = key().toBase58();
const tokenVault = key().toBase58();
const solVault = key().toBase58();

/** A PumpSwap pool account as the chain holds it (layout read from BAYLA's pool 8z52…YpK2n, 2026-11-05). */
function pumpPool(o: { base?: string; quote?: string; owner?: string; len?: number } = {}) {
  const data = new Uint8Array(301);
  data.set(new PublicKey(o.base ?? token).toBytes(), 43);
  data.set(new PublicKey(o.quote ?? WSOL_MINT).toBytes(), 75);
  data.set(new PublicKey(tokenVault).toBytes(), 139);
  data.set(new PublicKey(solVault).toBytes(), 171);
  return { address: 'pool', data: data.subarray(0, o.len ?? 301), owner: o.owner ?? PUMPSWAP_PROGRAM, lamports: 1 };
}

describe('decodePumpPool', () => {
  it('reads the token and both vaults of a PumpSwap SOL pool', () => {
    expect(decodePumpPool('pool', pumpPool(), b58)).toEqual({ pool: 'pool', tokenMint: token, tokenVault, solVault });
  });

  it('says why anything else is not one', () => {
    expect(decodePumpPool('pool', null, b58)).toMatch(/not found/);
    expect(decodePumpPool('pool', pumpPool({ owner: key().toBase58() }), b58)).toMatch(/not a PumpSwap pool/);
    expect(decodePumpPool('pool', pumpPool({ len: 202 }), b58)).toMatch(/too short/);
    expect(decodePumpPool('pool', pumpPool({ quote: key().toBase58() }), b58)).toMatch(/not priced in SOL/);
  });
});

describe('outsideUsd', () => {
  const pool = { pool: 'pool', tokenMint: token, tokenVault, solVault };

  it('prices a whole token at the SOL vault over the token vault, at SOL’s price', () => {
    // 300 SOL against 60,000,000 tokens of 6 decimals: 0.000005 SOL, $0.001 at $200.
    const amounts = new Map([
      [solVault, 300n * 10n ** 9n],
      [tokenVault, 60_000_000n * 10n ** 6n],
    ]);
    const usd = outsideUsd([pool], amounts, () => 6, 200).get(token)!;
    expect(usd).toBeCloseTo(0.001, 12);
  });

  it('gives no price for an empty side, an unread vault, unknown decimals or no SOL price', () => {
    const full = new Map([
      [solVault, 10n ** 9n],
      [tokenVault, 10n ** 6n],
    ]);
    expect(outsideUsd([pool], new Map([[solVault, 0n], [tokenVault, 10n ** 6n]]), () => 6, 200).size).toBe(0);
    expect(outsideUsd([pool], new Map([[solVault, 10n ** 9n]]), () => 6, 200).size).toBe(0);
    expect(outsideUsd([pool], full, () => null, 200).size).toBe(0);
    expect(outsideUsd([pool], full, () => 6, 0).size).toBe(0);
  });

  it('lists BAYLA’s PumpSwap pool, the one the rival trades against ours', () => {
    expect(OUTSIDE_POOLS).toContain('8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n');
  });
});

describe('screenUsd', () => {
  it('takes Jupiter’s level, and moves it as far as the outside pool has moved since', () => {
    const anchors = new Map();
    // BAYLA's vaults read 6% off Jupiter's quote through the same pool: the level is Jupiter's.
    expect(screenUsd(new Map([['T', 1.0]]), new Map([['T', 0.94]]), anchors).get('T')).toBe(1.0);
    // The pool trades up 5% while Jupiter's price is reused: the screen moves 5% with it.
    expect(screenUsd(new Map([['T', 1.0]]), new Map([['T', 0.987]]), anchors).get('T')).toBeCloseTo(1.05, 12);
    // A new listed price is the new level.
    expect(screenUsd(new Map([['T', 1.2]]), new Map([['T', 0.99]]), anchors).get('T')).toBe(1.2);
    expect(screenUsd(new Map([['T', 1.2]]), new Map([['T', 0.99]]), anchors).get('T')).toBe(1.2);
  });

  it('gives no price to a coin Jupiter lists none for', () => {
    expect(screenUsd(new Map(), new Map([['T', 0.94]]), new Map()).size).toBe(0);
  });
});
