import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { clearZapRun, loadZapRun, restoreRunAgainstPlan, saveZapRun, zapRunKey } from './persistence';
import { initialRunState, applyZapEvent } from './machine';
import { planZap, type ZapDescriptor } from './planner';
import { SWAP_FEE_ROUTER_ADDRESS, TOWELI_ADDRESS, WETH_ADDRESS } from '../constants';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const ONE_ETH = 10n ** 18n;

function plan() {
  const d: ZapDescriptor = {
    venueId: 'lp-farm',
    account: ACCOUNT,
    chainId: 1,
    inputToken: WETH_ADDRESS,
    inputSymbol: 'ETH',
    inputIsNative: true,
    amountIn: ONE_ETH.toString(),
    slippageBps: 50,
  };
  const r = planZap(
    d,
    {
      toTowelie: {
        executor: SWAP_FEE_ROUTER_ADDRESS,
        executorTakesMaxFee: true,
        amountIn: ONE_ETH / 2n,
        minOut: 1n,
        path: [WETH_ADDRESS, TOWELI_ADDRESS],
        slippageBps: 50,
      },
    },
    1,
  );
  if (!r.ok) throw new Error(r.detail);
  return r.plan;
}

describe('the resume record', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round-trips a half-finished run', () => {
    const p = plan();
    let run = initialRunState(p, { towelie: 0n, lp: 0n }, 1);
    run = applyZapEvent(run, { type: 'confirmed', steps: [0], txHash: '0xswap', at: 2 });

    expect(saveZapRun(p.descriptor, run)).toEqual({ stored: true });
    const loaded = loadZapRun(ACCOUNT, 1);
    expect(loaded.kind).toBe('run');
    const record = (loaded as { record: { run: typeof run } }).record;
    expect(record.run.steps[0]!.status).toBe('confirmed');
    expect(record.run.steps[0]!.txHash).toBe('0xswap');
  });

  it('keeps the baseline balances — a fresh tab that re-read them would over-deposit', () => {
    const p = plan();
    const run = initialRunState(p, { towelie: 12345n, lp: 6n }, 1);
    saveZapRun(p.descriptor, run);
    const loaded = loadZapRun(ACCOUNT, 1);
    expect((loaded as { record: { run: { baseline: Record<string, string> } } }).record.run.baseline).toEqual({
      towelie: '12345',
      lp: '6',
    });
  });

  it('is keyed per account and chain, so two wallets do not share one run', () => {
    expect(zapRunKey(ACCOUNT, 1)).not.toBe(zapRunKey(ACCOUNT, 8453));
    expect(zapRunKey(ACCOUNT.toUpperCase(), 1)).toBe(zapRunKey(ACCOUNT, 1));
  });

  it('uses an evictable key prefix, so quota pressure cannot orphan it', () => {
    expect(zapRunKey(ACCOUNT, 1).startsWith('tegridy_')).toBe(true);
  });

  it('says so when the browser refuses to store it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const p = plan();
    const result = saveZapRun(p.descriptor, initialRunState(p, {}, 1));
    expect(result.stored).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/check your balances by hand/i);
  });
});

describe('loading a record that cannot be trusted', () => {
  beforeEach(() => localStorage.clear());

  it('reports garbage rather than dropping it silently', () => {
    localStorage.setItem(zapRunKey(ACCOUNT, 1), 'not json');
    expect(loadZapRun(ACCOUNT, 1)).toMatchObject({ kind: 'unreadable' });
  });

  it('refuses a record from another version', () => {
    localStorage.setItem(zapRunKey(ACCOUNT, 1), JSON.stringify({ version: 0, descriptor: {}, run: {} }));
    expect(loadZapRun(ACCOUNT, 1)).toMatchObject({ kind: 'unreadable' });
  });

  it('refuses a record written for a different account', () => {
    const p = plan();
    saveZapRun(p.descriptor, initialRunState(p, {}, 1));
    const other = '0x2222222222222222222222222222222222222222';
    // Same key, wrong owner inside — only reachable by hand-editing storage, which is
    // exactly the case a positional trust would get wrong.
    localStorage.setItem(zapRunKey(other, 1), localStorage.getItem(zapRunKey(ACCOUNT, 1))!);
    expect(loadZapRun(other, 1)).toMatchObject({ kind: 'unreadable' });
  });

  it('reports nothing stored as nothing stored', () => {
    expect(loadZapRun(ACCOUNT, 1)).toEqual({ kind: 'none' });
  });

  it('clears cleanly', () => {
    const p = plan();
    saveZapRun(p.descriptor, initialRunState(p, {}, 1));
    clearZapRun(ACCOUNT, 1);
    expect(loadZapRun(ACCOUNT, 1)).toEqual({ kind: 'none' });
  });
});

describe('restoring a record against a freshly built plan', () => {
  it('accepts a plan with the same step sequence', () => {
    const p = plan();
    const run = initialRunState(p, {}, 1);
    const restored = restoreRunAgainstPlan(
      { version: 1, descriptor: p.descriptor, run },
      p.id,
      p.steps.map((s) => s.id),
    );
    expect(restored.kind).toBe('ok');
  });

  it('refuses when the plan gained a leg — positional restore would shift every status', () => {
    const p = plan();
    const run = initialRunState(p, {}, 1);
    const restored = restoreRunAgainstPlan(
      { version: 1, descriptor: p.descriptor, run },
      p.id,
      ['approve-swap-towelie', ...p.steps.map((s) => s.id)],
    );
    expect(restored.kind).toBe('mismatch');
    expect((restored as { reason: string }).reason).toMatch(/Check your balances/);
  });

  it('refuses when the same steps were composed for a different amount', () => {
    const p = plan();
    const run = initialRunState(p, {}, 1);
    const restored = restoreRunAgainstPlan(
      { version: 1, descriptor: p.descriptor, run },
      `${p.id}-different`,
      p.steps.map((s) => s.id),
    );
    expect(restored.kind).toBe('mismatch');
  });
});
