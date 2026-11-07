// The coins with no room the dashboard lists and pictures (owner, 2026-11-01). A picture that is not
// on the site is a broken image on the board, and an address that is not whole lists no coin at all.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { BUNGALOWS } from '../bungalows';
import { OFF_ISLAND_COINS, offIslandArt } from './offIslandCoins';

describe('offIslandCoins', () => {
  it.each(OFF_ISLAND_COINS.map((c) => [c.address, c]))('%s: a whole address, no room of its own, and a picture the site serves', (_, c) => {
    expect(new PublicKey(c.address).toBase58()).toBe(c.address);
    expect(BUNGALOWS.some((b) => b.address === c.address)).toBe(false);
    expect(existsSync(resolve(__dirname, '../../../public', `.${c.art.src}`))).toBe(true);
  });

  it('BIG BRAIN shows the owner’s picture; any other coin has none', () => {
    expect(offIslandArt('solana', 'J9zjM2nn4DBYpFy3qrReaUzY66g4EFMwLa61YSGCpump')?.src).toBe('/art/bobo/865DB7B3-E24E-452B-9358-36CBC610180E.jpg');
    expect(offIslandArt('solana', 'J9zjM2nn')).toBeNull();
    expect(offIslandArt('ethereum', 'J9zjM2nn4DBYpFy3qrReaUzY66g4EFMwLa61YSGCpump')).toBeNull();
    expect(offIslandArt('solana', undefined)).toBeNull();
  });
});
