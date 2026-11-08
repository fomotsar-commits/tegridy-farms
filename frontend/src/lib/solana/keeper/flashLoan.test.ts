// @vitest-environment node
//
// The flash loan, held byte for byte to the real mainnet trip it was copied from:
// 3QKvzHwNSLAoY7ij4uEZqqjr7BLtitFbzFv8KhERFFDzQtYwP3UNxKs3pS21mTvX8UGpQeP4njaJL7ZkBPvFzsCa (slot 465,859,742).
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import { flashBorrowIx, flashFee, flashRepayIx, loanFor } from './flashLoan';

const RIVAL = new PublicKey('Cn8LrZZnFD6qpyUY5uxJqTYKJ131U1dQLspEJqsxBn34');
const RIVAL_SOL = new PublicKey('5XxSQ4X57z31aJBaC21FVRV5jXuU6jDQn96FsaPBKfTT');
// The trip's twelve accounts, in order, for both instructions (read from the chain 2026-11-06).
const ACCOUNTS = [
  'Cn8LrZZnFD6qpyUY5uxJqTYKJ131U1dQLspEJqsxBn34',
  '9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo',
  '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
  'd4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q',
  'So11111111111111111111111111111111111111112',
  'GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U',
  '5XxSQ4X57z31aJBaC21FVRV5jXuU6jDQn96FsaPBKfTT',
  '3JNof8s453bwG5UqiXBLJc77NRQXezYYEBbk3fqnoKph',
  'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
  'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
  'Sysvar1nstructions1111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
];
const BORROWED = 172_726_224n;

describe('flash loan: the real trip’s instructions, byte for byte', () => {
  it('borrows with the same data and accounts', () => {
    const ix = flashBorrowIx(RIVAL, RIVAL_SOL, BORROWED);
    expect(ix.programId.toBase58()).toBe('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
    expect(Buffer.from(ix.data).toString('hex')).toBe('87e734a70734d4c1d0974b0a00000000');
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(ACCOUNTS);
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([RIVAL.toBase58()]);
  });

  it('repays with the same data (the borrow at place 4) and accounts', () => {
    const ix = flashRepayIx(RIVAL, RIVAL_SOL, BORROWED, 4);
    expect(Buffer.from(ix.data).toString('hex')).toBe('b97500cb60f5b4bad0974b0a0000000004');
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(ACCOUNTS);
    expect(() => flashRepayIx(RIVAL, RIVAL_SOL, 1n, 256)).toThrow(/byte/);
  });

  it('counts the fee as Kamino charged it, never less', () => {
    expect(flashFee(BORROWED)).toBeGreaterThanOrEqual(1_727n);
    expect(flashFee(BORROWED)).toBeLessThanOrEqual(1_728n);
    expect(flashFee(1n)).toBe(1n);
    expect(flashFee(0n)).toBe(0n);
  });

  it('borrows only the part of a SOL trip the keeper does not hold, and only when loans are on', () => {
    expect(loanFor(SOL_QUOTE.mint, 10n, 4n, true)).toBe(6n);
    expect(loanFor(SOL_QUOTE.mint, 4n, 4n, true)).toBe(0n);
    expect(loanFor(SOL_QUOTE.mint, 10n, 4n, false)).toBe(0n);
    expect(loanFor(USDC_QUOTE.mint, 10n, 4n, true)).toBe(0n);
  });
});
