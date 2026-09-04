import { describe, it, expect } from 'vitest';
import type { MarketRow } from '../geckoTerminal/pools';
import {
  MARKET_VIEW_LABEL,
  NOT_A_ZERO,
  feedBanner,
  type MarketFeedState,
  type MarketFeedUnreadReason,
  type MarketView,
} from './feedBanner';

// THE CENTRAL CLAIM OF THIS PAGE IS TESTED HERE: "could not read" and "nothing
// found" never render the same way, and no state is ever left without words.
//
// Both failures are silent by nature. A state with no sentence renders as an
// empty box that reads like an answer, and a refusal rendered as an empty table
// reads as a statement about an entire chain. Neither would fail a test that
// only checked the happy path.

const CTX = { network: 'eth' as const, view: 'new' as MarketView };

function row(over: Partial<MarketRow> = {}): MarketRow {
  return {
    key: 'eth:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    network: 'eth',
    pool: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    token: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    quoteToken: null,
    name: 'X / WETH',
    dex: 'uniswap_v3',
    createdAt: 1_700_000_000,
    priceUsd: 1,
    liquidityUsd: 1000,
    fdvUsd: null,
    volume24hUsd: 10,
    change24hPct: 1,
    tx24h: null,
    tx5m: null,
    withheld: false,
    ...over,
  };
}

const READ_AT = 1_700_000_600;
const ALL_REASONS: MarketFeedUnreadReason[] = ['network', 'http', 'rate-limited', 'malformed'];

const ALL_STATES: MarketFeedState[] = [
  { status: 'idle' },
  { status: 'loading' },
  { status: 'ready', rows: [row()], dropped: 0, readAt: READ_AT },
  { status: 'ready', rows: [], dropped: 0, readAt: READ_AT },
  ...ALL_REASONS.map(
    (reason): MarketFeedState => ({ status: 'unreachable', reason, detail: 'upstream said so' }),
  ),
];

describe('no state is left without words', () => {
  it('every variant yields a non-empty title and at least one line', () => {
    // The mutation this catches: adding a state to the union and letting the
    // Record fall through to undefined, which renders as a blank banner.
    for (const state of ALL_STATES) {
      const banner = feedBanner(state, CTX);
      expect(banner.title.length, JSON.stringify(state)).toBeGreaterThan(0);
      expect(banner.lines.length, JSON.stringify(state)).toBeGreaterThan(0);
      for (const line of banner.lines) expect(line.length).toBeGreaterThan(0);
    }
  });

  it('every view and network has a label, so the banner can always say where rows came from', () => {
    for (const view of Object.keys(MARKET_VIEW_LABEL) as MarketView[]) {
      for (const network of ['eth', 'base', 'solana'] as const) {
        const banner = feedBanner(
          { status: 'ready', rows: [row()], dropped: 0, readAt: READ_AT },
          { network, view },
        );
        expect(banner.lines.join(' ')).toContain(MARKET_VIEW_LABEL[view]);
      }
    }
  });
});

describe('a refusal is not an empty market', () => {
  it('every unreachable reason gets its OWN sentence — they are not interchangeable', () => {
    const sentences = ALL_REASONS.map(
      (reason) => feedBanner({ status: 'unreachable', reason, detail: 'd' }, CTX).lines[0],
    );
    expect(new Set(sentences).size).toBe(ALL_REASONS.length);
  });

  it('a 429 says the LIMIT refused the read, not that the market is empty', () => {
    const banner = feedBanner(
      { status: 'unreachable', reason: 'rate-limited', detail: 'HTTP 429' },
      CTX,
    );
    expect(banner.title).toMatch(/could not be read/i);
    const text = banner.lines.join(' ');
    expect(text).toMatch(/limit on the read, not a statement about the market/i);
    // And it must never be phrased as an observation about pools.
    expect(text).not.toMatch(/no pools/i);
    expect(banner.showRetry).toBe(true);
    expect(banner.notAZero).toBe(true);
  });

  it('carries the reader’s own factual sentence too — the only place an HTTP code appears', () => {
    const banner = feedBanner(
      { status: 'unreachable', reason: 'http', detail: 'The market feed refused this request (HTTP 503).' },
      CTX,
    );
    expect(banner.lines.join(' ')).toContain('HTTP 503');
  });

  it('unreachable and idle both carry NOT_A_ZERO', () => {
    expect(feedBanner({ status: 'idle' }, CTX).notAZero).toBe(true);
    for (const reason of ALL_REASONS) {
      expect(feedBanner({ status: 'unreachable', reason, detail: 'd' }, CTX).notAZero).toBe(true);
    }
  });
});

describe('an upstream zero is the upstream’s answer, and is attributed', () => {
  it('says so in words and does not read as a refusal', () => {
    const banner = feedBanner({ status: 'ready', rows: [], dropped: 0, readAt: READ_AT }, CTX);
    expect(banner.lines.join(' ')).toMatch(/answered with no pools/i);
    // The attribution is the whole point: whose answer is this?
    expect(banner.lines.join(' ')).toMatch(/not this venue/i);
    expect(banner.notAZero).toBe(true);
    // A zero-row read is NOT the same banner as an unreachable one.
    expect(banner.title).not.toBe(
      feedBanner({ status: 'unreachable', reason: 'network', detail: 'd' }, CTX).title,
    );
  });
});

describe('a ready feed states its source, its window and what it dropped', () => {
  const ready: MarketFeedState = {
    status: 'ready',
    rows: [row(), row({ key: 'eth:0xcc' })],
    dropped: 2,
    readAt: READ_AT,
  };

  it('names GeckoTerminal, the network, the view and the ISO read time', () => {
    const text = feedBanner(ready, CTX).lines.join(' ');
    expect(text).toContain('GeckoTerminal');
    expect(text).toContain('Ethereum');
    expect(text).toContain('new pools');
    expect(text).toContain(new Date(READ_AT * 1000).toISOString());
  });

  it('renders the dropped count rather than presenting the survivors as the whole answer', () => {
    // parseGeckoPoolList guarantees rows.length + dropped === what upstream
    // sent. Dropping the count here would show 2 of 4 pools as "2 pools".
    expect(feedBanner(ready, CTX).lines.join(' ')).toMatch(/2 pools were withheld/i);
    const clean = feedBanner({ ...ready, dropped: 0 }, CTX).lines.join(' ');
    expect(clean).not.toMatch(/withheld/i);
  });

  it('attributes the trending ORDER to the upstream, so this venue never appears to rank', () => {
    const text = feedBanner(ready, { network: 'eth', view: 'trending' }).lines.join(' ');
    expect(text).toMatch(/GeckoTerminal’s trending score, not a ranking by this venue/i);
  });

  it('says island membership is a registry fact, not a safety result', () => {
    const text = feedBanner(ready, { network: 'eth', view: 'island' }).lines.join(' ');
    expect(text).toMatch(/not a safety result/i);
  });

  it('says nothing here is endorsed or vetted', () => {
    expect(feedBanner(ready, CTX).lines.join(' ')).toMatch(
      /nothing here is endorsed, ranked or vetted/i,
    );
  });

  it('does not repeat NOT_A_ZERO when it is showing actual rows', () => {
    expect(feedBanner(ready, CTX).notAZero).toBe(false);
    expect(feedBanner(ready, CTX).lines.join(' ')).not.toContain(NOT_A_ZERO);
  });
});
