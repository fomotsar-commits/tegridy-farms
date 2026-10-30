// The dashboard's last read of each wallet (owner, 2026-10-24: "can we make it instant"). What is
// kept is only what a read returned, under the wallet it was read for, for a week; a row of
// another shape is never drawn.

import { describe, it, expect, beforeEach } from 'vitest';
import { BOARD_MEMORY_KEY, BOARD_MEMORY_MAX_AGE_MS, isHoldingRow, isPositionRow, recallWallet, rememberLegs } from './boardMemory';
import type { HoldingRow, PositionRow } from './walletRows';

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const B = '0x1111111111111111111111111111111111111111';
const NOW = Date.UTC(2026, 9, 24, 12);
const sol: HoldingRow = { key: 'sol', symbol: 'SOL', chain: 'solana', amount: '0.0124', usd: 1.27, roomId: null, to: null };
const lock: PositionRow = { key: 'ladder:x', roomId: 'bayla', chain: 'solana', title: 'BAYLA lock', facts: ['3,000 BAYLA', 'unlocks 31 Aug 2027'], to: '/earn/bayla' };

beforeEach(() => localStorage.clear());

describe('boardMemory', () => {
  it('gives back each part as it was read, under its own wallet only', () => {
    rememberLegs(A, { 'sol-holdings': [sol] }, NOW);
    rememberLegs(A, { 'sol-ladder': [lock] }, NOW + 1000);
    expect(recallWallet(A, NOW + 2000)).toEqual({
      'sol-holdings': { at: NOW, rows: [sol] },
      'sol-ladder': { at: NOW + 1000, rows: [lock] },
    });
    expect(recallWallet(B, NOW + 2000)).toEqual({});
  });

  it('keeps a read that found nothing: an empty part is a read too', () => {
    rememberLegs(A, { 'sol-lp': [] }, NOW);
    expect(recallWallet(A, NOW)).toEqual({ 'sol-lp': { at: NOW, rows: [] } });
  });

  it('draws nothing read more than a week ago', () => {
    rememberLegs(A, { 'sol-holdings': [sol] }, NOW);
    expect(recallWallet(A, NOW + BOARD_MEMORY_MAX_AGE_MS)).not.toEqual({});
    expect(recallWallet(A, NOW + BOARD_MEMORY_MAX_AGE_MS + 1)).toEqual({});
  });

  it('keeps four wallets, letting the one read longest ago go', () => {
    const owners = ['w1', 'w2', 'w3', 'w4', 'w5'];
    owners.forEach((o, i) => rememberLegs(o, { 'sol-holdings': [sol] }, NOW + i));
    expect(recallWallet('w1', NOW + 10)).toEqual({});
    for (const o of owners.slice(1)) expect(recallWallet(o, NOW + 10)).not.toEqual({});
  });

  it('reads a broken or foreign entry as nothing kept, never a throw', () => {
    localStorage.setItem(BOARD_MEMORY_KEY, '{not json');
    expect(recallWallet(A, NOW)).toEqual({});
    localStorage.setItem(BOARD_MEMORY_KEY, JSON.stringify({ ts: NOW, wallets: { [A]: { at: NOW, legs: { x: { at: 'soon', rows: [sol] }, y: { at: NOW, rows: 'many' } } } } }));
    expect(recallWallet(A, NOW)).toEqual({});
    rememberLegs(A, { 'sol-holdings': [sol] }, NOW);
    expect(recallWallet(A, NOW)).toEqual({ 'sol-holdings': { at: NOW, rows: [sol] } });
  });

  it('draws only rows of the shape the board draws, opening rooms on this site', () => {
    expect(isHoldingRow(sol)).toBe(true);
    expect(isHoldingRow({ ...sol, to: '/bayla' })).toBe(true);
    expect(isHoldingRow({ ...sol, usd: '1.27' })).toBe(false);
    expect(isHoldingRow({ ...sol, to: 'https://example.com' })).toBe(false);
    expect(isHoldingRow({ ...sol, to: '//example.com' })).toBe(false);
    expect(isHoldingRow(null)).toBe(false);
    expect(isPositionRow(lock)).toBe(true);
    expect(isPositionRow({ ...lock, facts: '3,000 BAYLA' })).toBe(false);
    expect(isPositionRow({ ...lock, chain: 'bitcoin' })).toBe(false);
    expect(isPositionRow({ ...lock, to: 'javascript:alert(1)' })).toBe(false);
  });
});
