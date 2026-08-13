import { describe, it, expect } from 'vitest';
import { explorerEnvelopeFailure, marketFor, txListUrl, TXLIST_OFFSET } from './useDeployerReputation';
import { classifyLaunch } from '../lib/detection/deployerReputation';
import type { OutcomeRecord } from '../lib/launcher/outcomes';

// The Deployer Reputation Graph publishes claims about somebody's ADDRESS. Two reads
// feed it, and both used to launder their own failures into those claims:
//
//   Etherscan discovery — a NOTOK envelope became "No direct contract-creation
//   transactions were found for this address."
//   GeckoTerminal enrichment — a 429 became "No live market found", with a note
//   speculating the pool "may have been withdrawn".
//
// These pin the distinction at both boundaries. The core already ships `unobserved`
// for exactly this; the bug was that neither caller could ever reach it.

const TOKEN = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D';

describe('explorerEnvelopeFailure — Etherscan puts the reason in `result`, not `message`', () => {
  it('catches the documented NOTOK auth body', () => {
    // ⚠ THE BUG. Reproduced live 2026-08-01, and documented in this repo at
    // api/etherscan.js:14. `message` is "NOTOK" — it contains no "rate limit" — so
    // the old guard passed the STRING `result` to parseCreatedContracts, which
    // returns [] for a non-array, landing the page on `empty`: "No direct
    // contract-creation transactions were found for this address."
    const failure = explorerEnvelopeFailure({
      status: '0',
      message: 'NOTOK',
      result: 'Missing/Invalid API Key',
    });
    expect(failure).toBeTruthy();
    expect(failure).toMatch(/nothing was concluded about this address/i);
  });

  it('catches the other live NOTOK variant', () => {
    expect(
      explorerEnvelopeFailure({ status: '0', message: 'NOTOK', result: 'Invalid API Key (#err2)' }),
    ).toBeTruthy();
  });

  it('still recognises a rate-limit, whichever field carries the wording', () => {
    // Etherscan puts it in `result`; keep the older `message` path working too.
    expect(explorerEnvelopeFailure({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' })).toMatch(
      /rate-limiting/i,
    );
    expect(explorerEnvelopeFailure({ status: '0', message: 'Max rate limit reached', result: '' })).toMatch(
      /rate-limiting/i,
    );
  });

  it('leaves a GENUINE empty answer alone — the shape is the test, not the prose', () => {
    // Etherscan's real "this address has no transactions" is status 0 with an ARRAY
    // result. That must keep reaching the honest `empty` state, in any wording.
    expect(explorerEnvelopeFailure({ status: '0', message: 'No transactions found', result: [] })).toBeNull();
  });

  it('leaves a successful envelope alone', () => {
    expect(explorerEnvelopeFailure({ status: '1', message: 'OK', result: [{ hash: '0xabc' }] })).toBeNull();
  });
});

describe('marketFor → classifyLaunch — an unread market is `unobserved`, never `no-market`', () => {
  const rec = (over: Partial<OutcomeRecord>): Record<string, OutcomeRecord> => ({
    [TOKEN.toLowerCase()]: {
      token: TOKEN,
      tier: 'listable',
      launchedAt: 1_780_000_000,
      observedAt: 1_785_000_000,
      priceEth: 0,
      launchPriceEth: 0.000001,
      liquidityEth: 0,
      launchLiquidityEth: 4,
      holderCount: 0,
      unlocks: [],
      lastTeamActivityAt: null,
      marketObserved: false,
      ...over,
    } as OutcomeRecord,
  });

  const statusFor = (outcomes: Record<string, OutcomeRecord>) =>
    classifyLaunch(
      { token: TOKEN, createdAt: 1_780_000_000, txHash: '0xdead', market: marketFor(TOKEN, outcomes) },
      1_785_000_000,
    ).status;

  it('routes a failed read to `unobserved`', () => {
    // ⚠ THE BUG. GeckoTerminal's keyless ceiling is ~30/min and one /deployer request
    // can issue up to 50 reads, so this is the routine case. It used to render a "No
    // live market" pill plus "the pool ... may have been withdrawn".
    expect(marketFor(TOKEN, rec({ marketReadFailed: true }))).toBeNull();
    expect(statusFor(rec({ marketReadFailed: true }))).toBe('unobserved');
  });

  it('keeps a REAL absence as `no-market`', () => {
    // The read worked and there is no pool. This is the case the copy was written
    // for, and the fix must not blunt it.
    expect(statusFor(rec({ marketReadFailed: false, marketObserved: false }))).toBe('no-market');
  });

  it('treats a record predating the field as a successful read', () => {
    // Back-compat: `marketReadFailed` absent must not turn every cached record into
    // `unobserved`, which would erase real findings.
    expect(statusFor(rec({ marketObserved: false }))).toBe('no-market');
  });

  it('still reports a healthy observed pool', () => {
    expect(
      statusFor(rec({ marketReadFailed: false, marketObserved: true, liquidityEth: 8, priceEth: 0.000002 })),
    ).toBe('active-market');
  });

  it('never lets an unread market produce a liquidity claim', () => {
    // The invariant behind the case above, stated without reference to a status: a
    // failed read yields no number for the UI to render as a finding.
    const t = classifyLaunch(
      { token: TOKEN, createdAt: 1_780_000_000, txHash: '0xdead', market: marketFor(TOKEN, rec({ marketReadFailed: true })) },
      1_785_000_000,
    );
    expect(t.liquidityEth).toBeNull();
    expect(t.priceEth).toBeNull();
    expect(t.note).not.toMatch(/withdrawn|thin/i);
  });
});

// /deployer was permanently broken for busy addresses, and it did not look like a bug —
// it looked like the explorer was down. Without page/offset, Etherscan returns its
// 10,000-row default; ~700 B/row is ~7 MB, over MAX_RESPONSE_BYTES in
// api/_lib/bodycap.js, so /api/etherscan answers 502 every single time for that address.
//
// The invariant is the BOUND, not the literal: this read must never ask the explorer for
// an unbounded page. Asserting the exact URL string would fail on any harmless reorder
// and would not notice the offset being raised past the proxy's clamp.
describe('txListUrl — the deployer read is always bounded', () => {
  const ADDR = '0x1489825812345678901234567890123456789ABC';

  it('always sends a page size, and never one the proxy would clamp', () => {
    const q = new URL(txListUrl(ADDR), 'https://memetic.fun').searchParams;
    expect(q.get('offset'), 'offset must be present — its absence IS the bug').not.toBeNull();
    // 500 == MAX_OFFSET in api/etherscan.js. Above it the proxy clamps, which would make
    // the effective page size disagree with what this module thinks it asked for.
    expect(Number(q.get('offset'))).toBeGreaterThan(0);
    expect(Number(q.get('offset'))).toBeLessThanOrEqual(500);
    // Etherscan pages from 1 when offset is supplied without page; pin it explicitly so
    // the window can never silently shift.
    expect(q.get('page')).toBe('1');
  });

  it('asks for enough rows to satisfy the 50 creations the page actually renders', () => {
    expect(TXLIST_OFFSET).toBeGreaterThanOrEqual(50);
  });

  it('still omits the block range and sorts newest-first', () => {
    // The proxy rejects a range wider than 10k; omitting it is what gets full history.
    const q = new URL(txListUrl(ADDR), 'https://memetic.fun').searchParams;
    expect(q.get('startblock')).toBeNull();
    expect(q.get('endblock')).toBeNull();
    expect(q.get('sort')).toBe('desc');
    expect(q.get('address')).toBe(ADDR.toLowerCase());
  });
});
