// Harvest's run: the order claims go in, where the wallet switches network, and where a
// run stops. The stops are the Buy-all order's (IslandBasketEvm): a cancel, and a sent
// claim whose outcome is unknown. One pool's failure never blocks the next pool.
import { describe, it, expect, vi } from 'vitest';
import { runHarvest, runSummary, type SwitchResult } from './run';
import { orderClaims, type ClaimResult, type ClaimState, type HarvestChain, type HarvestClaim } from './types';

const claim = (key: string, chain: HarvestChain, caution: string | null = null): HarvestClaim => ({
  key, chain, caution, roomId: key, symbol: key.toUpperCase(), where: 'pool', detail: null, amountRaw: 1n, decimals: 0,
});

function harness(answers: Record<string, ClaimResult> = {}, switches: Partial<Record<HarvestChain, SwitchResult>> = {}) {
  const sent: string[] = [];
  const switched: string[] = [];
  const states = new Map<string, ClaimState>();
  const deps = {
    send: vi.fn(async (c: HarvestClaim) => {
      sent.push(c.key);
      return answers[c.key] ?? { kind: 'claimed' as const, tx: `tx-${c.key}` };
    }),
    switchTo: vi.fn(async (ch: Exclude<HarvestChain, 'solana'>) => {
      switched.push(ch);
      return switches[ch] ?? { kind: 'ok' as const };
    }),
    onState: (k: string, s: ClaimState) => states.set(k, s),
  };
  return { deps, sent, switched, states };
}

describe('orderClaims', () => {
  it('Solana first, then the EVM chain the wallet is on, then the other; cautioned claims last within a chain', () => {
    const cs = [claim('b1', 'base'), claim('e1', 'ethereum'), claim('s2', 'solana', 'may not pay'), claim('s1', 'solana')];
    expect(orderClaims(cs, 'base').map((c) => c.key)).toEqual(['s1', 's2', 'b1', 'e1']);
    expect(orderClaims(cs, 'ethereum').map((c) => c.key)).toEqual(['s1', 's2', 'e1', 'b1']);
    expect(orderClaims(cs, null).map((c) => c.key)).toEqual(['s1', 's2', 'e1', 'b1']);
  });
});

describe('runHarvest', () => {
  it('sends every claim, switching network once per EVM chain and never for the chain it is on', async () => {
    const h = harness();
    const out = await runHarvest([claim('e1', 'ethereum'), claim('s1', 'solana'), claim('b1', 'base'), claim('b2', 'base')], 'base', h.deps);
    expect(h.sent).toEqual(['s1', 'b1', 'b2', 'e1']);
    expect(h.switched).toEqual(['ethereum']);
    expect(out.every((s) => s.kind === 'claimed')).toBe(true);
  });

  it('a cancel in the wallet stops the run: nothing after it is sent', async () => {
    const h = harness({ s1: { kind: 'declined' } });
    await runHarvest([claim('s1', 'solana'), claim('s2', 'solana'), claim('e1', 'ethereum')], 'ethereum', h.deps);
    expect(h.sent).toEqual(['s1']);
    expect(h.states.get('s2')).toEqual({ kind: 'not-sent' });
    expect(h.states.get('e1')).toEqual({ kind: 'not-sent' });
  });

  it('a sent claim whose outcome is unknown stops the run', async () => {
    const h = harness({ e1: { kind: 'unconfirmed', reason: 'receipt unread', tx: '0x1', stop: true } });
    await runHarvest([claim('e1', 'ethereum'), claim('e2', 'ethereum')], 'ethereum', h.deps);
    expect(h.sent).toEqual(['e1']);
    expect(h.states.get('e2')).toEqual({ kind: 'not-sent' });
  });

  it('a claim that did not go through, or reverted, does not block the next pool', async () => {
    const h = harness({
      s1: { kind: 'unconfirmed', reason: 'vault short' },
      e1: { kind: 'reverted', reason: 'refused', tx: '0x1' },
    });
    const out = await runHarvest([claim('s1', 'solana'), claim('s2', 'solana'), claim('e1', 'ethereum'), claim('e2', 'ethereum')], 'ethereum', h.deps);
    expect(h.sent).toEqual(['s1', 's2', 'e1', 'e2']);
    expect(out.map((s) => s.kind)).toEqual(['unconfirmed', 'claimed', 'reverted', 'claimed']);
  });

  it('a network switch the visitor declines stops the run', async () => {
    const h = harness({}, { base: { kind: 'declined' } });
    await runHarvest([claim('e1', 'ethereum'), claim('b1', 'base')], 'ethereum', h.deps);
    expect(h.sent).toEqual(['e1']);
    expect(h.states.get('b1')).toEqual({ kind: 'not-sent' });
  });

  it('a network switch the wallet cannot make skips that chain only', async () => {
    const h = harness({}, { ethereum: { kind: 'failed', reason: 'unsupported' } });
    await runHarvest([claim('e1', 'ethereum'), claim('e2', 'ethereum'), claim('b1', 'base')], 'base', h.deps);
    expect(h.sent).toEqual(['b1']);
    expect(h.switched).toEqual(['ethereum']);
    expect(h.states.get('e1')).toMatchObject({ kind: 'unconfirmed' });
    expect(h.states.get('e2')).toMatchObject({ kind: 'unconfirmed' });
  });

  it('a send that throws is not assumed to have done nothing: the run stops', async () => {
    const h = harness();
    h.deps.send.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await runHarvest([claim('s1', 'solana'), claim('s2', 'solana')], null, h.deps);
    expect(h.states.get('s1')).toMatchObject({ kind: 'unconfirmed', stop: true });
    expect(h.states.get('s2')).toEqual({ kind: 'not-sent' });
  });
});

describe('runSummary', () => {
  it('names each outcome that happened, in a fixed order', () => {
    expect(runSummary([{ kind: 'claimed', tx: 'a' }, { kind: 'claimed', tx: 'b' }, { kind: 'not-sent' }, { kind: 'unconfirmed', reason: 'x' }]))
      .toBe('2 claimed · 1 not confirmed · 1 not sent');
  });
});
