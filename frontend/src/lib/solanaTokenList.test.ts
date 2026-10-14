// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isUnverified,
  findSolToken,
  SOL,
  USDC,
  BUY_TOKENS,
  LST_TOKENS,
  rememberToken,
  getRecentTokens,
  getFavoriteTokens,
  toggleFavoriteToken,
  isFavoriteToken,
  iconSrc,
  BAYLA,
  PAY_WITH_TOKENS,
  VENUE_COINS,
  isVenueCoin,
  needsRiskAck,
  withVenueCoinsFirst,
  isRiskAcked,
  rememberRiskAck,
  forgetRiskAck,
  type SolToken,
} from './solanaTokenList';
import { BAYLA_MINT } from './bungalows';
import { QUOTE_COINS } from './solana/lp/quotes';

describe('isUnverified — the one verified/unverified decision', () => {
  it('treats an UNSET flag as unverified (the curated BAYLA case)', () => {
    // BAYLA deliberately leaves `verified` unset — Jupiter's tag would be a
    // lie — and its own comment expects the Unverified chip to render. The
    // old `=== false` checks silently exempted it from the badge AND the
    // risk-ack gate; this pin fails on that shape.
    const bayla = findSolToken('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
    expect(bayla).toBeDefined();
    expect(bayla!.verified).toBeUndefined();
    expect(isUnverified(bayla!)).toBe(true);
  });

  it('treats an explicit false as unverified', () => {
    expect(isUnverified({ ...SOL, verified: false })).toBe(true);
  });

  it('only an explicit true passes', () => {
    expect(isUnverified(SOL)).toBe(false);
    expect(isUnverified(USDC)).toBe(false);
  });

  it('every curated featured/LST token except BAYLA is explicitly verified', () => {
    // Breadth guard the other way: `!== true` must not suddenly badge the
    // whole curated shortlist. If a future curated entry legitimately lacks
    // Jupiter verification, list it here with the reason, like BAYLA.
    const knownUnverified = new Set(['7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump']);
    for (const t of [...BUY_TOKENS, ...LST_TOKENS]) {
      if (knownUnverified.has(t.mint)) continue;
      expect(t.verified, `${t.symbol} (${t.mint})`).toBe(true);
    }
  });
});

describe('the venue knows its own coins by mint', () => {
  const copy: SolToken = { mint: 'CopyCopyCopyCopyCopyCopyCopyCopyCopyCopypump', symbol: 'BAYLA', name: 'BAYLA', decimals: 6 };

  it('they are the three coins our pools pair with, and BAYLA is the bungalow mint', () => {
    expect(VENUE_COINS.map((t) => t.mint).sort()).toEqual(QUOTE_COINS.map((q) => q.mint).sort());
    expect(BAYLA.mint).toBe(BAYLA_MINT);
    for (const t of VENUE_COINS) expect(isVenueCoin(t.mint)).toBe(true);
  });

  it('a copy of the name is not a venue coin: the mint decides, never the symbol', () => {
    expect(isVenueCoin(copy.mint)).toBe(false);
    expect(isVenueCoin('BAYLA')).toBe(false);
  });

  it('the venue BAYLA asks for no acknowledgement, though Jupiter has not verified it; a copy does', () => {
    expect(BAYLA.verified).toBeUndefined();
    expect(needsRiskAck(BAYLA)).toBe(false);
    expect(needsRiskAck(copy)).toBe(true);
    expect(needsRiskAck({ ...copy, verified: false })).toBe(true);
    expect(needsRiskAck(SOL)).toBe(false);
    expect(needsRiskAck({ ...copy, verified: true })).toBe(false);
  });

  it('BAYLA is on both short lists, first on the buy side, so neither side needs a search', () => {
    expect(BUY_TOKENS[0]!.mint).toBe(BAYLA_MINT);
    expect(PAY_WITH_TOKENS.some((t) => t.mint === BAYLA_MINT)).toBe(true);
  });
});

describe('the liquid-staking list holds no rate', () => {
  // Four rates used to be typed in here (7.5, 7.2, 7.0, 8.0) and printed as "~X% APY".
  // Nothing on the page reads a staking rate, so the list may hold none to print.
  it('the only number a staking token carries is its decimals', () => {
    expect(LST_TOKENS.length).toBeGreaterThanOrEqual(4);
    for (const t of LST_TOKENS) {
      const numeric = Object.entries(t).filter(([, v]) => typeof v === 'number').map(([k]) => k);
      expect(numeric, t.symbol).toEqual(['decimals']);
    }
  });

  it('each one is named for what it is, with no rate in the name', () => {
    for (const t of LST_TOKENS) {
      expect(t.name, t.symbol).toMatch(/staked SOL/i);
      expect(`${t.symbol} ${t.name}`, t.symbol).not.toMatch(/\d\s*%|\bAP[YR]\b/i);
    }
  });
});

describe('search results put the venue coin where a trader can find it', () => {
  const row = (mint: string, symbol = 'BAYLA'): SolToken => ({ mint, symbol, name: symbol, decimals: 6 });
  const copies = [row('Copy1111111111111111111111111111111111111pump'), row('Copy2222222222222222222222222222222222222pump')];
  const real: SolToken = { ...row(BAYLA_MINT), logoURI: 'https://example.test/bayla.png', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' };

  it('moves the real BAYLA to the front, as the row the search returned', () => {
    const out = withVenueCoinsFirst([copies[0]!, real, copies[1]!], 'bayla');
    expect(out.map((t) => t.mint)).toEqual([BAYLA_MINT, copies[0]!.mint, copies[1]!.mint]);
    expect(out[0]!.logoURI).toBe(real.logoURI);
  });

  it('adds it when copies filled the results and left it out', () => {
    const out = withVenueCoinsFirst(copies, 'BAYLA');
    expect(out.map((t) => t.mint)).toEqual([BAYLA_MINT, copies[0]!.mint, copies[1]!.mint]);
  });

  it('adds it for its pasted mint, and for the start of its symbol', () => {
    expect(withVenueCoinsFirst([], BAYLA_MINT).map((t) => t.mint)).toEqual([BAYLA_MINT]);
    expect(withVenueCoinsFirst([], ' bay ').map((t) => t.mint)).toEqual([BAYLA_MINT]);
  });

  it('adds nothing for a search that is not about a venue coin, and keeps the order it was given', () => {
    const others = [row('Other111111111111111111111111111111111111111', 'WIF'), row('Other222222222222222222222222222222222222222', 'BONK')];
    expect(withVenueCoinsFirst(others, 'wif')).toEqual(others);
    expect(withVenueCoinsFirst(others, 'b')).toEqual(others);
    expect(withVenueCoinsFirst([], '')).toEqual([]);
  });

  it('never lists a venue coin twice', () => {
    const out = withVenueCoinsFirst([real, copies[0]!, real], 'bayla');
    expect(out.filter((t) => t.mint === BAYLA_MINT)).toHaveLength(1);
  });
});

describe('a risk acknowledgement is remembered per token on this device', () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('remembers the tokens that were acknowledged, and only those', () => {
    expect(isRiskAcked('MintA')).toBe(false);
    rememberRiskAck(['MintA', 'MintB']);
    expect(isRiskAcked('MintA')).toBe(true);
    expect(isRiskAcked('MintB')).toBe(true);
    expect(isRiskAcked('MintC')).toBe(false);
    rememberRiskAck(['MintA']);
    expect(JSON.parse(store['sol.acks']!)).toEqual(['MintA', 'MintB']);
  });

  it('forgets one when the trader takes the tick back', () => {
    rememberRiskAck(['MintA', 'MintB']);
    forgetRiskAck(['MintA']);
    expect(isRiskAcked('MintA')).toBe(false);
    expect(isRiskAcked('MintB')).toBe(true);
  });

  it('keeps the newest 64, and reads a damaged or missing store as nothing remembered', () => {
    for (let i = 0; i < 70; i++) rememberRiskAck([`M${i}`]);
    expect(JSON.parse(store['sol.acks']!)).toHaveLength(64);
    expect(isRiskAcked('M69')).toBe(true);
    expect(isRiskAcked('M0')).toBe(false);
    store['sol.acks'] = '{"not":"a list"}';
    expect(isRiskAcked('M69')).toBe(false);
    store['sol.acks'] = 'garbage';
    expect(isRiskAcked('M69')).toBe(false);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(() => rememberRiskAck(['X'])).not.toThrow();
    expect(isRiskAcked('X')).toBe(false);
  });
});

describe('recents + favorites store', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('remembers picks front-first, deduped, capped at 8', () => {
    for (let i = 0; i < 10; i++) {
      rememberToken({ mint: `M${i}`, symbol: `T${i}`, name: `Tok ${i}`, decimals: 6 });
    }
    rememberToken({ mint: 'M5', symbol: 'T5', name: 'Tok 5', decimals: 6 });
    const recents = getRecentTokens();
    expect(recents.length).toBe(8);
    expect(recents[0]!.mint).toBe('M5'); // re-pick moves to front, no duplicate
    expect(recents.filter((t) => t.mint === 'M5').length).toBe(1);
  });

  it('stores full tokens so decimals survive offline, and drops corrupt rows', () => {
    rememberToken({ ...SOL });
    store['sol.recents'] = JSON.stringify([
      ...JSON.parse(store['sol.recents']!),
      { mint: 'NoDecimals', symbol: 'X' }, // corrupt: decimals missing
      'garbage',
    ]);
    const recents = getRecentTokens();
    expect(recents.length).toBe(1);
    expect(recents[0]!.decimals).toBe(9);
  });

  it('a venue coin kept from before it had its picture is shown as the venue knows it now', () => {
    // What a browser stored when the curated BAYLA had another name and no picture.
    store['sol.recents'] = JSON.stringify([{ mint: BAYLA_MINT, symbol: 'BAYLA', name: 'An older name', decimals: 6 }]);
    store['sol.favs'] = store['sol.recents'];
    expect(getRecentTokens()[0]).toEqual(BAYLA);
    expect(getFavoriteTokens()[0]).toEqual(BAYLA);
    // A row the search gave, with its own picture and live fields, is kept as it is.
    const live = { ...BAYLA, name: 'BAYLA', logoURI: 'https://example.test/b.png', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' };
    store['sol.recents'] = JSON.stringify([live]);
    expect(getRecentTokens()[0]).toEqual(live);
  });

  it('toggles favorites and reports state', () => {
    expect(isFavoriteToken(USDC.mint)).toBe(false);
    expect(toggleFavoriteToken(USDC)).toBe(true);
    expect(isFavoriteToken(USDC.mint)).toBe(true);
    expect(getFavoriteTokens()[0]!.mint).toBe(USDC.mint);
    expect(toggleFavoriteToken(USDC)).toBe(false);
    expect(getFavoriteTokens()).toEqual([]);
  });

  it('degrades to empty, never throws, when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(() => rememberToken(SOL)).not.toThrow();
    expect(getRecentTokens()).toEqual([]);
    expect(getFavoriteTokens()).toEqual([]);
  });
});

// BAYLA's on-chain metadata and its Jupiter icon are https://ipfs.io/... URLs.
// Since that gateway was retired (2026-09-21) wsrv.nl answers 404 for them, so
// the icon rendered as initials. Measured: via ipfs.filebase.io wsrv answers 200.
describe('iconSrc moves IPFS icons off retired gateways before proxying', () => {
  const BAYLA_ICON = 'https://ipfs.io/ipfs/bafkreiav3na7d325rg5ia4vbq5gs2wxbpvmgyzctwuvq2354yb73iv72uq';
  const upstream = (src: string) => new URL(src).searchParams.get('url');

  it('proxies the BAYLA icon through a live gateway', () => {
    expect(upstream(iconSrc(BAYLA_ICON))).toBe(
      'https://ipfs.filebase.io/ipfs/bafkreiav3na7d325rg5ia4vbq5gs2wxbpvmgyzctwuvq2354yb73iv72uq',
    );
  });

  it('proxies an ipfs:// icon through a live gateway and leaves other hosts alone', () => {
    expect(upstream(iconSrc('ipfs://bafkreiabc'))).toBe('https://ipfs.filebase.io/ipfs/bafkreiabc');
    expect(upstream(iconSrc('https://static.jup.ag/jup/icon.png'))).toBe('https://static.jup.ag/jup/icon.png');
    expect(iconSrc('')).toBe('');
  });
});
