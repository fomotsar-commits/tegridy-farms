// What /solana opens buying. $BAYLA first (the owner, 2026-10-03): SOL to $BAYLA, and in
// a Solana room, SOL to that room's coin. A link's own ?out= still wins.

import { describe, it, expect } from 'vitest';
import { openingBuyMint } from './solanaOpeningPair';
import { BAYLA, USDC, SOL, BUY_TOKENS, isUnverified } from './solanaTokenList';
import { BAYLA_MINT, BUNGALOWS } from './bungalows';

const room = (id: string) => BUNGALOWS.find((b) => b.id === id)!;
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('the coin /solana opens buying', () => {
  it('is $BAYLA when the link names none and the visitor is in no room', () => {
    expect(openingBuyMint('', null)).toBe(BAYLA_MINT);
  });

  it('is the room’s coin in every Solana room', () => {
    const solanaRooms = BUNGALOWS.filter((b) => b.live && b.chain === 'solana' && b.address);
    expect(solanaRooms.map((b) => b.id).sort()).toEqual(['bayla', 'bobo', 'brainlet', 'rizz', 'soy']);
    for (const b of solanaRooms) expect(openingBuyMint('', b), b.id).toBe(b.address);
  });

  it('is $BAYLA in a room on another chain, TOWELI’s included', () => {
    for (const id of ['toweli', 'pepe', 'bnkr']) expect(openingBuyMint('', room(id)), id).toBe(BAYLA_MINT);
  });

  it('is the link’s own ?out=, in a room or out of one', () => {
    expect(openingBuyMint(`?out=${BONK}`, null)).toBe(BONK);
    expect(openingBuyMint(`?out=${BONK}`, room('bobo'))).toBe(BONK);
    expect(openingBuyMint(`?out=${USDC.mint}`, room('bayla'))).toBe(USDC.mint);
  });

  it('ignores an ?out= that is not a mint address', () => {
    expect(openingBuyMint('?out=not-a-mint', null)).toBe(BAYLA_MINT);
    expect(openingBuyMint('?out=', room('bobo'))).toBe(room('bobo').address);
  });

  it('never opens on a pair of one coin: a link that pays with it buys USDC', () => {
    expect(openingBuyMint(`?in=${BAYLA_MINT}`, null)).toBe(USDC.mint);
    expect(openingBuyMint(`?in=${room('bobo').address}`, room('bobo'))).toBe(USDC.mint);
    // Any other pay side leaves the default alone.
    expect(openingBuyMint(`?in=${USDC.mint}`, null)).toBe(BAYLA_MINT);
    expect(openingBuyMint(`?in=${SOL.mint}`, null)).toBe(BAYLA_MINT);
  });
});

describe('the $BAYLA the page opens on', () => {
  it('is the registry’s mint, and the same entry the picker lists', () => {
    expect(BAYLA.mint).toBe(BAYLA_MINT);
    expect(BUY_TOKENS).toContain(BAYLA);
  });

  it('keeps its Unverified chip and its tick box: no verified flag is claimed', () => {
    expect(BAYLA.verified).toBeUndefined();
    expect(isUnverified(BAYLA)).toBe(true);
  });
});
