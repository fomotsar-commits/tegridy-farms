// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { BAYLA_MINT, USDC_MINT, WSOL_MINT } from '../lp/tokenSafety';
import { offersTier, tiersOffered } from './tierOffer';

/** The tiers this site offers a pair (owner, 2026-10-24): under 1% only for SOL against a dollar coin. */

const MEME = Keypair.generate().publicKey.toBase58();

describe('the tiers a pair is offered', () => {
  it('1% is offered to every pair', () => {
    for (const [a, b] of [[BAYLA_MINT, WSOL_MINT], [BAYLA_MINT, USDC_MINT], [WSOL_MINT, USDC_MINT], [MEME, WSOL_MINT]]) {
      expect(offersTier(10_000, a!, b!)).toBe(true);
    }
  });

  it('0.25% only to SOL against USDC, either way round', () => {
    expect(offersTier(2_500, WSOL_MINT, USDC_MINT)).toBe(true);
    expect(offersTier(2_500, USDC_MINT, WSOL_MINT)).toBe(true);
    for (const [a, b] of [[BAYLA_MINT, WSOL_MINT], [WSOL_MINT, BAYLA_MINT], [BAYLA_MINT, USDC_MINT], [MEME, WSOL_MINT], [MEME, USDC_MINT], [WSOL_MINT, WSOL_MINT]]) {
      expect(offersTier(2_500, a!, b!)).toBe(false);
    }
  });

  it('the line is 1%: just under it is a low tier, anything from 1% up is offered to all', () => {
    expect(offersTier(9_999, BAYLA_MINT, WSOL_MINT)).toBe(false);
    expect(offersTier(40_000, BAYLA_MINT, WSOL_MINT)).toBe(true);
  });

  it('keeps the offered tiers in the order given', () => {
    const tiers = [{ tradeFeeRate: 10_000, i: 0 }, { tradeFeeRate: 2_500, i: 1 }];
    expect(tiersOffered(tiers, BAYLA_MINT, WSOL_MINT).map((t) => t.i)).toEqual([0]);
    expect(tiersOffered(tiers, USDC_MINT, WSOL_MINT).map((t) => t.i)).toEqual([0, 1]);
  });
});
