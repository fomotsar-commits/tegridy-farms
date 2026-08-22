import { describe, it, expect } from 'vitest';
import {
  BLOCKER,
  canOfferOneClickFill,
  secondsUntilReleasable,
  toFillVerdict,
  type FillVerdict,
} from './usePositionMarketFillability';

const OK = { deployed: true, onExpectedChain: true, isError: false, isLoading: false };
const AT = 1_800_000_000n;

describe('toFillVerdict', () => {
  // ── The gate this whole module exists for ────────────────────────────────

  it('never reports an incomplete check as clear', () => {
    // `certain === false` is what TegridyPositionMarket returns for a contract
    // recipient, because TegridyStaking's per-holder position count is
    // `internal` and cannot be read. Nothing blocking was found; that is not a
    // pass, and collapsing the two would put a confirmed-looking Buy button on
    // a check that never completed.
    const verdict = toFillVerdict([BLOCKER.None, false, AT], OK);
    expect(verdict.kind).toBe('unverified');
    expect(canOfferOneClickFill(verdict)).toBe(false);
  });

  it('reports a completed, unblocked check as clear', () => {
    const verdict = toFillVerdict([BLOCKER.None, true, AT], OK);
    expect(verdict).toEqual({ kind: 'clear', releasableAt: Number(AT) });
    expect(canOfferOneClickFill(verdict)).toBe(true);
  });

  it('is the ONLY verdict that authorises a one-click fill', () => {
    const everyVerdict: FillVerdict[] = [
      toFillVerdict([BLOCKER.None, true, AT], OK),
      toFillVerdict([BLOCKER.None, false, AT], OK),
      toFillVerdict([BLOCKER.RateLimited, true, AT], OK),
      toFillVerdict([BLOCKER.RecipientAlreadyHoldsPosition, true, AT], OK),
      toFillVerdict([BLOCKER.OrderNotOpen, true, 0n], OK),
      toFillVerdict([BLOCKER.ZeroRecipient, true, AT], OK),
      toFillVerdict(undefined, { ...OK, isError: true }),
      toFillVerdict(undefined, { ...OK, isLoading: true }),
      toFillVerdict(undefined, { ...OK, deployed: false }),
      toFillVerdict(undefined, { ...OK, onExpectedChain: false }),
    ];
    expect(everyVerdict.filter(canOfferOneClickFill)).toHaveLength(1);
  });

  // ── Outages are never legitimate answers ─────────────────────────────────

  it('an undeployed market is unavailable, not clear and not blocked', () => {
    const verdict = toFillVerdict(undefined, { ...OK, deployed: false });
    expect(verdict.kind).toBe('unavailable');
  });

  it('a failed read is unavailable rather than a refusal', () => {
    // A refusal would tell the buyer something about their wallet. A read that
    // did not land tells them nothing, and must say so.
    const verdict = toFillVerdict(undefined, { ...OK, isError: true });
    expect(verdict.kind).toBe('unavailable');
    if (verdict.kind === 'unavailable') expect(verdict.reason).toMatch(/unknown/i);
  });

  it('the wrong chain is unavailable', () => {
    expect(toFillVerdict(undefined, { ...OK, onExpectedChain: false }).kind).toBe('unavailable');
  });

  it('an in-flight read is unavailable, never a provisional pass', () => {
    expect(toFillVerdict(undefined, { ...OK, isLoading: true }).kind).toBe('unavailable');
  });

  it('an unrecognised blocker code is unavailable rather than treated as None', () => {
    // A deployed contract ahead of this client must not have its new enum value
    // silently read as "nothing blocking".
    const verdict = toFillVerdict([99, true, AT], OK);
    expect(verdict.kind).toBe('unavailable');
    expect(canOfferOneClickFill(verdict)).toBe(false);
  });

  // ── Blockers ─────────────────────────────────────────────────────────────

  it('surfaces the single-position guard with an actionable message', () => {
    const verdict = toFillVerdict([BLOCKER.RecipientAlreadyHoldsPosition, true, AT], OK);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') {
      expect(verdict.code).toBe(BLOCKER.RecipientAlreadyHoldsPosition);
      // The escape hatch has to be in the message; a bare refusal strands the buyer.
      expect(verdict.message).toMatch(/wallet with no position|contract wallet/i);
    }
  });

  it('surfaces the transfer rate limit with the deadline attached', () => {
    const verdict = toFillVerdict([BLOCKER.RateLimited, true, AT], OK);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') expect(verdict.releasableAt).toBe(Number(AT));
  });

  it('reports a closed order as blocked, not as missing data', () => {
    const verdict = toFillVerdict([BLOCKER.OrderNotOpen, true, 0n], OK);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') expect(verdict.releasableAt).toBeNull();
  });
});

describe('secondsUntilReleasable', () => {
  it('counts down and floors at zero', () => {
    const verdict = toFillVerdict([BLOCKER.RateLimited, true, 1_000n], OK);
    expect(secondsUntilReleasable(verdict, 400)).toBe(600);
    expect(secondsUntilReleasable(verdict, 1_000)).toBe(0);
    expect(secondsUntilReleasable(verdict, 5_000)).toBe(0);
  });

  it('is zero when nothing was read', () => {
    expect(secondsUntilReleasable(toFillVerdict(undefined, { ...OK, isError: true }), 400)).toBe(0);
  });
});
