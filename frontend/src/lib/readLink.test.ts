import { describe, it, expect } from 'vitest';
import { readLink } from './readLink';
import { SITE_URL } from './constants';

// seacasa's word, 2026-11-19: a holder posted 500.4° and X drew his card under it at 491.99°, the card it
// had kept for the same link a week before. X draws a card again only for a link it has not seen, so
// the link carries the number the card paints: a new number is a new link.
const ADDR = '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca';
const SOL = '2jDhAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1wuF';
const NOW = Date.UTC(2026, 10, 19, 19, 34); // 11-19, 11:34 AM Pacific

describe('the read link a post carries', () => {
  it('carries the heat the card paints, to the hundredth', () => {
    expect(readLink(ADDR, 500.35, NOW)).toBe(`${SITE_URL}/read/${ADDR}?h=500.35`);
    expect(readLink(ADDR, 2292.9712, NOW)).toBe(`${SITE_URL}/read/${ADDR}?h=2292.97`);
  });

  it('is a new link the moment the number moves, so X draws the card again', () => {
    expect(readLink(ADDR, 500.36, NOW)).not.toBe(readLink(ADDR, 500.35, NOW));
  });

  it('keeps a Solana address exactly as written', () => {
    expect(readLink(SOL, 491.99, NOW)).toBe(`${SITE_URL}/read/${SOL}?h=491.99`);
  });

  it('a cold reading carries its zero', () => {
    expect(readLink(ADDR, 0, NOW)).toBe(`${SITE_URL}/read/${ADDR}?h=0.00`);
  });

  it('with no reading in hand, carries the day it was posted (UTC)', () => {
    expect(readLink(ADDR, null, NOW)).toBe(`${SITE_URL}/read/${ADDR}?d=20261119`);
    expect(readLink(ADDR, undefined, Date.UTC(2026, 10, 20, 0, 1))).toBe(`${SITE_URL}/read/${ADDR}?d=20261120`);
    expect(readLink(ADDR, Number.NaN, NOW)).toBe(`${SITE_URL}/read/${ADDR}?d=20261119`);
    expect(readLink(ADDR, -1, NOW)).toBe(`${SITE_URL}/read/${ADDR}?d=20261119`);
  });
});
