// @vitest-environment node
//
// Exposure (BUILD-SPEC 3.5 step 3): a signed order counts until the EARLIEST of its end time, a
// mined on-chain cancel, a counter bump past it, or a confirmed gasless cancel whose last fill
// signature has expired. Outstanding units, the 5-minute tail and the WETH approval target.
import { describe, it, expect } from 'vitest';
import { createExposure, allowanceTarget, fundingNeeded, reseedExposure, CLOCK_SLACK_SEC } from '../exposure.mjs';
import { testPolicy, milli } from '../../exec/__tests__/fakes.mjs';

const T = 1_794_800_000; // seconds
const h = (n) => `0x${String(n).padStart(64, '0')}`;
const order = (n, over = {}) => ({ orderHash: h(n), slug: 'junglebay', qty: 2, unitPriceWei: milli(35), startTime: T, endTime: T + 1800, counter: 7n, ...over });
const fill = (n, tokenId, over = {}) => ({ txHash: h(900 + Number(tokenId)), block: 1, time: T + 60, orderHash: h(n), slug: 'junglebay', tokenId: String(tokenId), unitPriceWei: milli(35), seller: '0x3333333333333333333333333333333333333333', fulfiller: '0x3333333333333333333333333333333333333333', ...over });

describe('exposure: when a signed order stops counting', () => {
  it('counts until its end time has passed (with clock slack)', () => {
    const x = createExposure();
    const o = x.add(order(1));
    expect(x.isLive(o, T + 1799)).toBe(true);
    expect(x.isLive(o, T + 1800 + CLOCK_SLACK_SEC - 1)).toBe(true);
    expect(x.isLive(o, T + 1800 + CLOCK_SLACK_SEC)).toBe(false);
    expect(x.deadReason(o, T + 1800 + CLOCK_SLACK_SEC)).toBe('expired');
  });

  it('counts while an on-chain cancel is pending, and stops once it is mined', () => {
    const x = createExposure();
    const o = x.add(order(1));
    x.recordOnChainCancel(o.orderHash, { at: 0, txHash: h(5), mined: false });
    expect(x.isLive(o, T + 10)).toBe(true);
    x.recordOnChainCancel(o.orderHash, { at: 0, txHash: h(5), mined: true });
    expect(x.deadReason(o, T + 10)).toBe('cancelled-on-chain');
  });

  it('stops counting once the Seaport counter moves past the one it was signed with', () => {
    const x = createExposure();
    const o = x.add(order(1, { counter: 7n }));
    x.setCounter(7n);
    expect(x.isLive(o, T + 10)).toBe(true);
    x.setCounter(8n);
    expect(x.deadReason(o, T + 10)).toBe('counter');
    x.setCounter(3n); // a counter never goes down
    expect(x.counter()).toBe(8n);
  });

  it('keeps a gaslessly cancelled order live until OpenSea’s last fill signature expires', () => {
    const x = createExposure();
    const o = x.add(order(1));
    x.recordGaslessCancel(o.orderHash, { at: 0, lastSignatureValidUntil: T + 300 });
    expect(x.isLive(o, T + 200)).toBe(true);
    expect(x.tailUnits('junglebay', T + 200)).toBe(2);
    expect(x.active('junglebay', T + 200)).toHaveLength(0); // no longer the standing bid
    expect(x.openTails(T + 200)).toHaveLength(1);
    expect(x.isLive(o, T + 300 + CLOCK_SLACK_SEC)).toBe(false);
  });

  it('ends a gasless cancel at once when OpenSea issued no fill signature (null or "0")', () => {
    const x = createExposure();
    const a = x.add(order(1));
    const b = x.add(order(2));
    x.recordGaslessCancel(a.orderHash, { at: 0, lastSignatureValidUntil: null });
    x.recordGaslessCancel(b.orderHash, { at: 0, lastSignatureValidUntil: 0 });
    expect(x.deadReason(a, T + 10)).toBe('cancelled-gasless');
    expect(x.deadReason(b, T + 10)).toBe('cancelled-gasless');
  });

  it('reads a tail given in milliseconds as the same moment', () => {
    const x = createExposure();
    const o = x.add(order(1));
    x.recordGaslessCancel(o.orderHash, { at: 0, lastSignatureValidUntil: (T + 300) * 1000 });
    expect(x.get(o.orderHash).cancel.validUntil).toBe(T + 300);
  });

  it('a cancel that was only asked for leaves the order live', () => {
    const x = createExposure();
    const o = x.add(order(1));
    x.recordCancelAsked(o.orderHash, { at: 0, reason: 'fair-value-moved' });
    expect(x.isLive(o, T + 10)).toBe(true);
    expect(x.active('junglebay', T + 10)).toHaveLength(0);
  });
});

describe('exposure: outstanding units and fills', () => {
  it('outstanding is the unfilled units of live orders', () => {
    const x = createExposure();
    x.add(order(1));
    expect(x.outstanding('junglebay', T + 10)).toBe(2);
    expect(x.recordFill(fill(1, 11)).fresh).toBe(true);
    expect(x.outstanding('junglebay', T + 10)).toBe(1);
    expect(x.recordFill(fill(1, 11)).fresh).toBe(false); // the same fill twice counts once
    x.recordFill(fill(1, 12));
    expect(x.outstanding('junglebay', T + 10)).toBe(0);
    expect(x.deadReason(x.get(h(1)), T + 10)).toBe('filled');
  });

  it('flags a fill of an order the house never signed, an overfill and an overpayment', () => {
    const x = createExposure();
    x.add(order(1, { qty: 1 }));
    expect(x.recordFill(fill(2, 11)).known).toBe(false);
    expect(x.recordFill(fill(1, 11)).overfill).toBe(false);
    expect(x.recordFill(fill(1, 12)).overfill).toBe(true);
    x.add(order(3, { qty: 1 }));
    expect(x.recordFill(fill(3, 13, { unitPriceWei: milli(36) })).overpaid).toBe(true);
  });
});

describe('the WETH approval target', () => {
  const policy = testPolicy('0x2222222222222222222222222222222222222222');

  it('is the room under the inventory cap times the highest live unit price, a tail included', () => {
    const x = createExposure();
    x.add(order(1, { qty: 1, unitPriceWei: milli(30) }));
    const old = x.add(order(2, { qty: 1, unitPriceWei: milli(35) }));
    x.recordGaslessCancel(old.orderHash, { at: 0, lastSignatureValidUntil: T + 300 });
    const { target, minPrice } = allowanceTarget({ policy, exposure: x, heldBySlug: { junglebay: 1 }, nowSec: T + 100 });
    expect(target).toBe(2n * milli(35)); // room 3 - 1 = 2, at the tail's 0.035
    expect(minPrice).toBe(milli(35));
    // after the tail closes only the 0.030 order is live
    expect(allowanceTarget({ policy, exposure: x, heldBySlug: { junglebay: 1 }, nowSec: T + 300 + CLOCK_SLACK_SEC }).target).toBe(2n * milli(30));
  });

  it('counts the price about to be posted, and is zero at full inventory', () => {
    const x = createExposure();
    expect(allowanceTarget({ policy, exposure: x, heldBySlug: {}, nowSec: T, standing: { junglebay: milli(40) } }).target).toBe(3n * milli(40));
    x.add(order(1, { qty: 1 }));
    expect(allowanceTarget({ policy, exposure: x, heldBySlug: { junglebay: 3 }, nowSec: T + 10, standing: { junglebay: milli(40) } }).target).toBe(0n);
  });

  it('funding needed is every unfilled unit at its price, plus the order about to be posted', () => {
    const x = createExposure();
    x.add(order(1, { qty: 2, unitPriceWei: milli(30) }));
    x.recordFill(fill(1, 11, { unitPriceWei: milli(30) }));
    expect(fundingNeeded({ exposure: x, nowSec: T + 10 })).toBe(milli(30));
    expect(fundingNeeded({ exposure: x, nowSec: T + 10, extra: { qty: 1, unitPriceWei: milli(31) } })).toBe(milli(61));
  });
});

describe('re-seeding on start', () => {
  it('rebuilds orders from the signer file, cancels from the ledger and fills from the chain', () => {
    const { exposure, findings } = reseedExposure({
      signerOrders: [{ hash: h(1), slug: 'junglebay', qty: 2, unitPriceWei: '35000000000000000', endTime: T + 1800, parameters: { startTime: T, counter: '7' } }],
      ledgerEntries: [{ kind: 'cancel', method: 'gasless', confirmed: true, orderHash: h(1), at: 0, lastSignatureValidUntil: T + 300 }],
      chainFills: [fill(1, 11)],
      nowSec: T + 100,
    });
    const o = exposure.get(h(1));
    expect(o.filled).toBe(1);
    expect(exposure.isLive(o, T + 100)).toBe(true); // in its tail
    expect(exposure.outstanding('junglebay', T + 100)).toBe(1);
    expect(findings).toEqual([]);
  });

  it('a chain fill or an OpenSea offer the house never signed is a finding', () => {
    const { findings } = reseedExposure({ signerOrders: [], ledgerEntries: [], chainFills: [fill(5, 11)], accountOffers: [{ orderHash: h(6), slug: 'junglebay', priceWei: milli(35), qty: 1, remainingQty: 1, endTime: T + 900 }], nowSec: T + 100 });
    expect(findings.map((f) => f.code).sort()).toEqual(['unknown-fill', 'unknown-offer']);
  });

  it('OpenSea can keep an order live, never end one: its word is advisory', () => {
    const seed = (accountOffers) =>
      reseedExposure({
        signerOrders: [{ orderHash: h(1), slug: 'junglebay', qty: 1, unitPriceWei: '35000000000000000', endTime: T + 1800, counter: '7' }],
        ledgerEntries: [{ kind: 'cancel', method: 'gasless', confirmed: true, orderHash: h(1), at: 0, lastSignatureValidUntil: null }],
        accountOffers,
        nowSec: T + 100,
      });
    // OpenSea still lists the gaslessly cancelled order: kept live until it ends
    const kept = seed([{ orderHash: h(1), slug: 'junglebay', priceWei: milli(35), qty: 1, remainingQty: 1, endTime: T + 1800 }]);
    expect(kept.exposure.isLive(kept.exposure.get(h(1)), T + 100)).toBe(true);
    expect(kept.findings.map((f) => f.code)).toContain('opensea-says-live');
    // a live order OpenSea does not list stays live
    const live = reseedExposure({ signerOrders: [{ orderHash: h(2), slug: 'junglebay', qty: 1, unitPriceWei: '35000000000000000', endTime: T + 1800, counter: '7' }], accountOffers: [], nowSec: T + 100 });
    expect(live.exposure.isLive(live.exposure.get(h(2)), T + 100)).toBe(true);
  });
});
