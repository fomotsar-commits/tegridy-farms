// @vitest-environment node
//
// The executor's order of operations (BUILD-SPEC 3.5 step 6), with a fake OpenSea and a fake
// signer that signs for real with a test key: no post without a verified signature; a build that
// is not the pinned shape never reaches the signer; any refusal halts and kills; the STOP path
// kills when a tail is open; re-prices are limited; the approval follows its target.
import { describe, it, expect } from 'vitest';
import { createExecutor, createShadowExecutor, CANCEL_REASONS } from '../executor.mjs';
import { createExposure } from '../../brain/exposure.mjs';
import { createRisk } from '../../brain/risk.mjs';
import { createLedger } from '../ledger.mjs';
import { localOrderHash } from '../verify.mjs';
import { fakeClock, fakeOpenSea, fakeSigner, testAccount, testPolicy, snapshotOf, memFs, milli, openSeaError, standardBuild } from './fakes.mjs';

const paths = { ledger: 'L/ledger.jsonl', trades: 'L/trades.csv', status: 'L/status.json' };

function setup({ signer: signerOpts = {}, opensea: osOpts = {}, getOrderHash = null, stop = false, policyOver = {} } = {}) {
  const clock = fakeClock();
  const calls = [];
  const house = testAccount(1).address.toLowerCase();
  const policy = testPolicy(house, policyOver);
  const signer = fakeSigner({ calls, policy, ...signerOpts });
  const opensea = fakeOpenSea({ calls, ...osOpts });
  const exposure = createExposure();
  const risk = createRisk({ now: clock.now });
  risk.noteRestRead({ ok: true, startedAt: clock.now() });
  const fs = memFs();
  const ledger = createLedger({ paths, fs, now: clock.now });
  const state = { stop };
  const orderHash = getOrderHash ?? (async (c) => {
    calls.push(['seaport.getOrderHash']);
    return localOrderHash(c);
  });
  const ex = createExecutor({ house, policy, opensea, signer, getOrderHash: orderHash, exposure, risk, ledger, stopRequested: () => state.stop, now: clock.now });
  const ctx = { snapshot: snapshotOf({ allowance: 0n }), heldBySlug: { junglebay: 0, gnssart: 0 } };
  return { clock, calls, house, policy, signer, opensea, exposure, risk, ledger, ex, ctx, state, kinds: () => ledger.read().map((e) => e.kind), names: () => calls.map((c) => c[0]) };
}
const plan = (over = {}) => ({ slug: 'junglebay', unitPriceWei: milli(35), qty: 2, binding: 'fair', edgeBps: 1200, ...over });

describe('post: the order of operations', () => {
  it('builds, checks, funds, signs, verifies on chain, then posts and records', async () => {
    const t = setup();
    const r = await t.ex.post(plan(), t.ctx);
    expect(r.posted).toBe(true);
    expect(t.names()).toEqual(['opensea.build', 'signer.sendTx', 'signer.signBid', 'seaport.getOrderHash', 'opensea.post']);
    expect(t.calls[1].slice(1)).toEqual(['approveWeth', { amountWei: (3n * milli(35)).toString() }]); // room 3 x 0.035
    expect(t.kinds()).toEqual(['tx', 'approve', 'signed', 'post']);
    expect(t.exposure.active('junglebay', t.clock.sec())).toHaveLength(1);
    // what OpenSea is given carries the counter and the signer's exact parameters
    const [, , params] = t.calls.find((c) => c[0] === 'opensea.post');
    expect(params.counter).toBe('7');
    expect(params.totalOriginalConsiderationItems).toBe(2);
  });

  it('does not approve again when the approval already covers the bid', async () => {
    const t = setup();
    await t.ex.post(plan(), { ...t.ctx, snapshot: snapshotOf({ allowance: milli(200) }) });
    expect(t.names()).not.toContain('signer.sendTx');
  });

  it('asks for a 30-minute bid starting now', async () => {
    const t = setup();
    await t.ex.post(plan(), t.ctx);
    const req = t.calls.find((c) => c[0] === 'signer.signBid')[1];
    expect(req.startTime).toBe(t.clock.sec());
    expect(req.endTime - req.startTime).toBe(1800);
  });

  it('holds an unfunded bid without signing anything', async () => {
    const t = setup();
    const r = await t.ex.post(plan(), { ...t.ctx, snapshot: snapshotOf({ weth: milli(60) }) });
    expect(r).toMatchObject({ posted: false, why: 'unfunded' });
    expect(t.names()).toEqual(['opensea.build']);
  });

  it('holds when an approval would pass the policy cap', async () => {
    const t = setup({ policyOver: { maxAllowanceWei: milli(100) } });
    const r = await t.ex.post(plan(), t.ctx);
    expect(r.why).toBe('over-allowance-cap');
    expect(t.names()).toEqual(['opensea.build']);
  });

  it('keeps one bid per collection', async () => {
    const t = setup();
    await t.ex.post(plan(), t.ctx);
    const again = await t.ex.post(plan(), t.ctx);
    expect(again.why).toBe('already-bidding');
  });

  it('bids one unit when the breakers say so after a market pause', async () => {
    const t = setup();
    t.risk.market('stream-silent', 'test');
    t.clock.advance(2 * 3600_000);
    await t.ex.post(plan(), t.ctx);
    expect(t.calls.find((c) => c[0] === 'signer.signBid')[1].qty).toBe(1);
  });
});

describe('post: nothing is posted without a verified signature', () => {
  it('halts and kills when the signature recovers to another key', async () => {
    const other = testAccount(2);
    const t = setup({
      signer: {
        tamper: async (a) => ({ ...a, signature: await other.signMessage({ message: 'not the order' }) }),
      },
    });
    const r = await t.ex.post(plan(), t.ctx);
    expect(r.posted).toBe(false);
    expect(t.names()).not.toContain('opensea.post');
    expect(t.risk.halted().reason).toBe('signature-mismatch');
    expect(t.names()).toContain('signer.kill');
  });

  it('halts when the signed order is not the one asked for (the offer amount)', async () => {
    const t = setup({
      signer: {
        tamper: (a) => ({ ...a, parameters: { ...a.parameters, offer: [{ ...a.parameters.offer[0], startAmount: '1', endAmount: '1' }] } }),
      },
    });
    await t.ex.post(plan(), t.ctx);
    expect(t.names()).not.toContain('opensea.post');
    expect(t.risk.halted().reason).toBe('signature-mismatch');
  });

  it('halts when Seaport 1.6 hashes the order differently from the signer', async () => {
    const t = setup({ getOrderHash: async () => `0x${'99'.repeat(32)}` });
    await t.ex.post(plan(), t.ctx);
    expect(t.names()).not.toContain('opensea.post');
    expect(t.risk.halted().reason).toBe('signature-mismatch');
  });

  it('holds, without halting, when Seaport cannot be asked; the signed order still counts as exposure', async () => {
    const t = setup({
      getOrderHash: async () => {
        throw new Error('rpc down');
      },
    });
    const r = await t.ex.post(plan(), t.ctx);
    expect(r.why).toBe('verify-unavailable');
    expect(t.names()).not.toContain('opensea.post');
    expect(t.risk.halted()).toBe(null);
    expect(t.exposure.outstanding('junglebay', t.clock.sec())).toBe(2);
  });

  it('halts when OpenSea stores a different order hash', async () => {
    const t = setup({ opensea: { postHash: `0x${'77'.repeat(32)}` } });
    await t.ex.post(plan(), t.ctx);
    expect(t.risk.halted().reason).toBe('ledger-mismatch');
  });
});

describe('post: the build is checked before the signer is asked', () => {
  const bad = {
    'an extra consideration line': (o, s, q) => ({ ...standardBuild(o, s, q), consideration: [...standardBuild(o, s, q).consideration, { itemType: 1, token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', identifierOrCriteria: '0', startAmount: '1', endAmount: '1', recipient: '0x6666666666666666666666666666666666666666' }] }),
    'the NFT paid to someone else': (o, s, q) => ({ ...standardBuild(o, s, q), consideration: [{ ...standardBuild(o, s, q).consideration[0], recipient: '0x6666666666666666666666666666666666666666' }] }),
    'another zone': (o, s, q) => ({ ...standardBuild(o, s, q), zone: '0x6666666666666666666666666666666666666666' }),
    'a non-zero zoneHash': (o, s, q) => ({ ...standardBuild(o, s, q), zoneHash: `0x${'01'.repeat(32)}` }),
    'a trait root': (o, s, q) => ({ ...standardBuild(o, s, q), consideration: [{ ...standardBuild(o, s, q).consideration[0], identifierOrCriteria: '123' }] }),
    'the wrong quantity': (o, s) => standardBuild(o, s, 5),
    'another collection': (o, s, q) => standardBuild(o, 'gnssart', q),
  };
  for (const [name, build] of Object.entries(bad)) {
    it(`halts on ${name}, and never calls signBid`, async () => {
      const t = setup({ opensea: { build: ({ offerer, slug, qty }) => build(offerer, slug, qty) } });
      const r = await t.ex.post(plan(), t.ctx);
      expect(r.posted).toBe(false);
      expect(t.names()).not.toContain('signer.signBid');
      expect(t.risk.halted().reason).toBe('build-mismatch');
    });
  }
});

describe('any refusal halts', () => {
  it('a signBid refusal halts and kills, and nothing is posted', async () => {
    const t = setup({ signer: { refuse: { signBid: 'P7' } } });
    await t.ex.post(plan(), t.ctx);
    expect(t.risk.halted().reason).toBe('signer-refusal');
    expect(t.names()).toContain('signer.kill');
    expect(t.names()).not.toContain('opensea.post');
    expect(t.kinds()).toContain('refusal');
  });

  it('an approval refusal halts before anything is signed', async () => {
    const t = setup({ signer: { refuse: { sendTx: ['approveWeth'] } } });
    await t.ex.post(plan(), t.ctx);
    expect(t.risk.halted().reason).toBe('signer-refusal');
    expect(t.names()).not.toContain('signer.signBid');
  });

  it('a signCancel refusal halts', async () => {
    const t = setup({ signer: { refuse: { signCancel: 'orderHash' } } });
    const { orderHash } = await t.ex.post(plan(), t.ctx);
    await t.ex.cancel(orderHash, 'fair-value-moved');
    expect(t.risk.halted().reason).toBe('signer-refusal');
  });

  it('STOP before anything: nothing is built or signed', async () => {
    const t = setup({ stop: true });
    const r = await t.ex.post(plan(), t.ctx);
    expect(r.why).toBe('stop');
    expect(t.names()).toEqual([]);
  });

  it('STOP appearing while OpenSea builds: checked again right before the signature', async () => {
    let t;
    t = setup({
      opensea: {
        build: ({ offerer, slug, qty }) => {
          t.state.stop = true;
          return standardBuild(offerer, slug, qty);
        },
      },
    });
    const r = await t.ex.post(plan(), { ...t.ctx, snapshot: snapshotOf({ allowance: milli(200) }) });
    expect(r.why).toBe('stop');
    expect(t.names()).toEqual(['opensea.build']);
  });

  it('STOP appearing while the signer signs: checked again right before the post', async () => {
    let t;
    t = setup({
      signer: {
        tamper: (a) => {
          t.state.stop = true;
          return a;
        },
      },
    });
    const r = await t.ex.post(plan(), t.ctx);
    expect(r.why).toBe('stop');
    expect(t.names()).not.toContain('opensea.post');
  });
});

describe('cancel', () => {
  it('cancels gaslessly and records when OpenSea’s last fill signature expires', async () => {
    const t = setup();
    const { orderHash } = await t.ex.post(plan(), t.ctx);
    const until = t.clock.sec() + 300;
    t.opensea.cancelOffer = async (a) => (t.calls.push(['opensea.cancel', a.orderHash]), { ok: true, lastSignatureValidUntil: until });
    const r = await t.ex.cancel(orderHash, 'fair-value-moved');
    expect(r).toMatchObject({ ok: true, method: 'gasless', tailUntil: until });
    const line = t.ledger.read().find((e) => e.kind === 'cancel');
    expect(line).toMatchObject({ reason: 'fair-value-moved', method: 'gasless', lastSignatureValidUntil: until });
    expect(t.exposure.tailUnits('junglebay', t.clock.sec())).toBe(2);
  });

  it('cancels on chain when OpenSea refuses the gasless cancel', async () => {
    const t = setup({ opensea: { cancelResult: { ok: false, reason: 'too new' } } });
    const { orderHash } = await t.ex.post(plan(), t.ctx);
    const r = await t.ex.cancel(orderHash, 'arbitrage-line');
    expect(r).toMatchObject({ ok: true, method: 'on-chain', mined: true });
    expect(t.calls.filter((c) => c[0] === 'signer.sendTx').map((c) => c[1])).toEqual(['approveWeth', 'cancelOnChain']);
  });

  it('cancels on chain when OpenSea does not answer', async () => {
    const t = setup({ opensea: { cancelResult: openSeaError('network', 0) } });
    const { orderHash } = await t.ex.post(plan(), t.ctx);
    expect((await t.ex.cancel(orderHash, 'error')).method).toBe('on-chain');
  });

  it('only takes reasons from the closed list', async () => {
    const t = setup();
    expect(() => t.ex.cancel(`0x${'01'.repeat(32)}`, 'felt-like-it')).toThrow();
    expect(CANCEL_REASONS).toEqual(['fair-value-moved', 'arbitrage-line', 'cap-reached', 'risk-halt', 'error', 'key-rotation', 'stop']);
  });

  it('sends one cancel even when a halt asks for the same order mid-cancel', async () => {
    const t = setup();
    const { orderHash } = await t.ex.post(plan(), t.ctx);
    await Promise.all([t.ex.cancel(orderHash, 'fair-value-moved'), t.ex.cancel(orderHash, 'risk-halt')]);
    expect(t.names().filter((n) => n === 'signer.signCancel')).toHaveLength(1);
  });
});

describe('STOP', () => {
  it('kills, and waits for the kill, when a cancelled bid is still inside its 5-minute tail', async () => {
    const t = setup();
    await t.ex.post(plan(), t.ctx);
    t.opensea.cancelOffer = async ({ orderHash }) => (t.calls.push(['opensea.cancel', orderHash]), { ok: true, lastSignatureValidUntil: t.clock.sec() + 240 });
    const r = await t.ex.stopPath();
    expect(r.killed).toBe(true);
    // every cancel answer is read first, then the kill, which is awaited before stopPath returns
    expect(t.names().slice(-3)).toEqual(['signer.signCancel', 'opensea.cancel', 'signer.kill']);
    expect(t.kinds().slice(-1)).toEqual(['kill']);
  });

  it('exits without a kill when every cancel is clean and no tail is open', async () => {
    const t = setup();
    await t.ex.post(plan(), t.ctx);
    const r = await t.ex.stopPath();
    expect(r.killed).toBe(false);
    expect(t.names()).not.toContain('signer.kill');
    expect(t.kinds()).toContain('stop-clean');
  });

  it('kills when a cancel fails', async () => {
    const t = setup();
    await t.ex.post(plan(), t.ctx);
    t.signer.signCancel = async () => {
      throw new Error('pipe closed');
    };
    expect((await t.ex.stopPath()).killed).toBe(true);
  });

  it('kills when a post failed in a way that leaves the order’s fate unknown', async () => {
    const t = setup({ opensea: { postError: openSeaError('network', 0) } });
    const r = await t.ex.post(plan(), t.ctx);
    expect(r.why).toBe('post-failed');
    expect(t.exposure.get(t.ledger.read().find((e) => e.kind === 'signed').orderHash).posted).toBe('unknown');
    t.opensea.cancelOffer = async () => ({ ok: true, lastSignatureValidUntil: t.clock.sec() + 120 });
    expect((await t.ex.stopPath()).killed).toBe(true);
  });
});

describe('re-price limit and the approval', () => {
  it('allows one discretionary re-price per collection per hour', async () => {
    const t = setup();
    expect(t.ex.mayReprice('junglebay')).toBe(true);
    await t.ex.post(plan(), { ...t.ctx, reprice: true });
    expect(t.ex.mayReprice('junglebay')).toBe(false);
    expect(t.ex.mayReprice('gnssart')).toBe(true);
    t.clock.advance(3600_000);
    expect(t.ex.mayReprice('junglebay')).toBe(true);
  });

  it('cuts the approval when it would buy one NFT more than the room, and leaves small moves alone', async () => {
    const t = setup();
    await t.ex.post(plan({ qty: 1 }), t.ctx);
    const target = 3n * milli(35);
    let r = await t.ex.syncAllowance({ snapshot: snapshotOf({ allowance: target + milli(10) }), heldBySlug: { junglebay: 0 }, why: 'tick' });
    expect(r.changed).toBe(false); // 0.01 over: less than one more NFT
    r = await t.ex.syncAllowance({ snapshot: snapshotOf({ allowance: target + milli(35) }), heldBySlug: { junglebay: 0 }, why: 'after-fill' });
    expect(r.changed).toBe(true);
    expect(t.calls.at(-1)).toEqual(['signer.sendTx', 'approveWeth', { amountWei: target.toString() }]);
  });

  it('revokes the approval at full inventory', async () => {
    const t = setup();
    const r = await t.ex.syncAllowance({ snapshot: snapshotOf({ allowance: milli(35) }), heldBySlug: { junglebay: 3, gnssart: 2 }, why: 'after-fill' });
    expect(r.changed).toBe(true);
    expect(t.calls.at(-1)).toEqual(['signer.sendTx', 'revokeWeth', {}]);
  });
});

describe('shadow executor', () => {
  it('never contacts a signer, and records its bids with shadow: true', async () => {
    const clock = fakeClock();
    const calls = [];
    const fs = memFs();
    const ledger = createLedger({ paths, fs, now: clock.now, shadow: true });
    const exposure = createExposure();
    const risk = createRisk({ now: clock.now });
    risk.noteRestRead({ ok: true, startedAt: clock.now() });
    const house = testAccount(1).address.toLowerCase();
    const ex = createShadowExecutor({ house, policy: testPolicy(house), opensea: fakeOpenSea({ calls }), exposure, risk, ledger, stopRequested: () => false, now: clock.now });
    const r = await ex.post(plan(), {});
    expect(r.posted).toBe(true);
    await ex.cancel(r.orderHash, 'fair-value-moved');
    expect(calls.map((c) => c[0])).toEqual(['opensea.build']);
    expect(ledger.read().every((e) => e.shadow === true)).toBe(true);
  });
});
