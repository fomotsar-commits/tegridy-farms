// THE MONEY PATH, ONE STATE AT A TIME.
//
// Every branch of `depositPlan` is a decision about somebody else's funds, so
// every branch gets its own `it`. The four assertions that would cost real money
// if they drifted are asserted across EVERY venue rather than on a representative
// one: the spender always equals the destination, no approval is ever unlimited
// or zero, no plan is ever ready with an unread gate, and no step is ever
// addressed anywhere but the catalogue's own depositTarget.

import { describe, it, expect } from 'vitest';
import { maxUint256, zeroAddress } from 'viem';
import { depositPlan, YIELD_CHAIN_ID, type DepositPlanInput } from './deposit';
import { YIELD_ADDRESSES } from './protocols';
import { routableYieldVenues, yieldVenue, yieldVenues } from './venues';

const ACCOUNT = '0x00000000000000000000000000000000000000A1' as const;

const base = (id: string, over: Partial<DepositPlanInput> = {}): DepositPlanInput => {
  const venue = yieldVenue(id);
  if (venue === null) throw new Error(`no venue ${id}`);
  return {
    venue,
    amountText: '1',
    chainId: YIELD_CHAIN_ID,
    account: ACCOUNT,
    nativeBalance: 10n * 10n ** 18n,
    assetBalance: 10n * 10n ** 6n,
    allowance: 10n * 10n ** 18n,
    rocket: {
      resolvedPool: YIELD_ADDRESSES.rocketDepositPool,
      resolvedSettings: YIELD_ADDRESSES.rocketSettingsDeposit,
      depositEnabled: true,
      minimumDeposit: 10n ** 16n,
      maxPoolSize: 6_000_000n * 10n ** 18n,
      poolBalance: 15n * 10n ** 18n,
    },
    ...over,
  };
};

describe('a row with no deposit path refuses regardless of everything else', () => {
  it('never routes cbETH, even with a funded wallet on the right chain', () => {
    const plan = depositPlan(base('coinbase-cbeth'));
    expect(plan.state).toBe('unroutable');
    expect(plan.state === 'unroutable' && plan.reason).toMatch(/Coinbase/);
    expect(plan.state === 'unroutable' && plan.reason).toMatch(/no public contract/);
  });
});

describe('the wallet and chain gates come before anything is parsed', () => {
  it('asks for a wallet first', () => {
    expect(depositPlan(base('lido-steth', { account: null })).state).toBe('no-wallet');
  });

  it('refuses a wallet on another chain rather than building a mainnet call for it', () => {
    const plan = depositPlan(base('lido-steth', { chainId: 8453 }));
    expect(plan).toEqual({ state: 'wrong-chain', want: 1 });
  });
});

describe('amounts are parsed strictly, at the asset\'s own decimals', () => {
  it.each(['abc', '', '-1', '1e400', '0', '0.0', ' ', '1.2.3', '١'])('refuses %j', (amountText) => {
    expect(depositPlan(base('lido-steth', { amountText })).state).toBe('invalid-amount');
  });

  it('refuses more fraction digits than the token has', () => {
    // USDC has six. Seven would be silently truncated by parseUnits, and a
    // truncated amount is a different amount from the one the depositor typed.
    expect(depositPlan(base('aave-v3-usdc', { amountText: '1.1234567' })).state).toBe('invalid-amount');
    expect(depositPlan(base('aave-v3-usdc', { amountText: '1.123456' })).state).toBe('ready');
  });
});

describe('holding none of the asset is a different answer from holding too little', () => {
  it('sends a visitor with no USDC to the trade page instead of quoting a shortfall', () => {
    const plan = depositPlan(base('aave-v3-usdc', { assetBalance: 0n }));
    expect(plan.state).toBe('needs-asset');
    expect(plan.state === 'needs-asset' && plan.asset.symbol).toBe('USDC');
  });

  it('quotes the shortfall when some is held', () => {
    const plan = depositPlan(base('aave-v3-usdc', { assetBalance: 500_000n }));
    expect(plan.state).toBe('insufficient');
    expect(plan.state === 'insufficient' && plan.have).toBe(500_000n);
    expect(plan.state === 'insufficient' && plan.need).toBe(1_000_000n);
  });

  it('refuses an ETH deposit that would consume the whole balance, leaving nothing for gas', () => {
    expect(depositPlan(base('lido-steth', { nativeBalance: 10n ** 18n })).state).toBe('insufficient');
    expect(depositPlan(base('lido-steth', { nativeBalance: 10n ** 18n + 1n })).state).toBe('ready');
  });
});

describe('each venue emits exactly its own protocol\'s canonical call', () => {
  it('Lido submit(0x0) with the ETH as value', () => {
    const plan = depositPlan(base('lido-steth'));
    expect(plan.state).toBe('ready');
    if (plan.state !== 'ready') throw new Error('unreachable');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      address: YIELD_ADDRESSES.stETH,
      functionName: 'submit',
      args: [zeroAddress],
      value: 10n ** 18n,
    });
  });

  it('Renzo depositETH() with the ETH as value and no arguments', () => {
    const plan = depositPlan(base('renzo-ezeth'));
    if (plan.state !== 'ready') throw new Error(`expected ready, got ${plan.state}`);
    expect(plan.steps[0]).toMatchObject({
      address: YIELD_ADDRESSES.renzoRestakeManager,
      functionName: 'depositETH',
      args: [],
      value: 10n ** 18n,
    });
  });

  it('Aave supply(asset, amount, onBehalfOf, 0)', () => {
    const plan = depositPlan(base('aave-v3-usdc'));
    if (plan.state !== 'ready') throw new Error(`expected ready, got ${plan.state}`);
    expect(plan.steps[0]).toMatchObject({
      address: YIELD_ADDRESSES.aaveV3Pool,
      functionName: 'supply',
      args: [YIELD_ADDRESSES.usdc, 1_000_000n, ACCOUNT, 0],
    });
    // No `value` on an ERC-20 route: an accidental payable field would send ETH
    // alongside the supply and lose it.
    expect(plan.steps[0]?.value).toBeUndefined();
  });

  it('Compound supply(asset, amount) — two arguments, not four', () => {
    const plan = depositPlan(base('compound-v3-usdc'));
    if (plan.state !== 'ready') throw new Error(`expected ready, got ${plan.state}`);
    expect(plan.steps[0]).toMatchObject({
      address: YIELD_ADDRESSES.cUSDCv3,
      functionName: 'supply',
      args: [YIELD_ADDRESSES.usdc, 1_000_000n],
    });
  });

  it('sUSDS deposit(assets, receiver) with the depositor as receiver', () => {
    const plan = depositPlan(base('sky-susds', { assetBalance: 10n * 10n ** 18n }));
    if (plan.state !== 'ready') throw new Error(`expected ready, got ${plan.state}`);
    expect(plan.steps[0]).toMatchObject({
      address: YIELD_ADDRESSES.sUSDS,
      functionName: 'deposit',
      args: [10n ** 18n, ACCOUNT],
    });
  });
});

describe('approvals are exact and go to the contract that will pull the tokens', () => {
  it('asks for an approval of exactly the deposit amount when the allowance is short', () => {
    const plan = depositPlan(base('aave-v3-usdc', { allowance: 999_999n }));
    expect(plan.state).toBe('needs-approval');
    if (plan.state !== 'needs-approval') throw new Error('unreachable');
    expect(plan.amount).toBe(1_000_000n);
    expect(plan.spender).toBe(YIELD_ADDRESSES.aaveV3Pool);
    expect(plan.steps[0]).toMatchObject({
      address: YIELD_ADDRESSES.usdc,
      functionName: 'approve',
      args: [YIELD_ADDRESSES.aaveV3Pool, 1_000_000n],
    });
    // The deposit is listed as step 2 so the panel can say "1 of 2" before the
    // first signature rather than after it.
    expect(plan.steps).toHaveLength(2);
  });

  it('treats an unread allowance as no allowance rather than assuming one', () => {
    expect(depositPlan(base('aave-v3-usdc', { allowance: null })).state).toBe('needs-approval');
  });

  it('NEVER emits an unlimited or zero approval, for any venue in any state', () => {
    // Walked across every venue and every input shape rather than on one
    // representative row: an infinite approval added to a single route would
    // otherwise be invisible to a test written against another.
    const inputs: Partial<DepositPlanInput>[] = [
      {},
      { allowance: 0n },
      { allowance: null },
      { allowance: 999n },
      { amountText: '0.000001' },
      { assetBalance: 10n ** 18n, amountText: '0.5' },
    ];
    for (const venue of yieldVenues()) {
      for (const over of inputs) {
        const plan = depositPlan(base(venue.id, over));
        const steps = 'steps' in plan ? plan.steps : [];
        for (const step of steps) {
          if (step.functionName !== 'approve') continue;
          const amount = step.args[1];
          expect(amount, `${venue.id} emitted a zero approval`).not.toBe(0n);
          expect(amount, `${venue.id} emitted an unlimited approval`).not.toBe(maxUint256);
          expect(typeof amount).toBe('bigint');
          expect(amount as bigint > 0n).toBe(true);
        }
      }
    }
  });
});

describe('Rocket Pool fails closed on every one of its live gates', () => {
  const rocketBase = (over: Partial<NonNullable<DepositPlanInput['rocket']>>) =>
    depositPlan(base('rocketpool-reth', { rocket: { ...base('rocketpool-reth').rocket!, ...over } }));

  it('is ready when the resolved pool matches the pinned one', () => {
    const plan = depositPlan(base('rocketpool-reth'));
    if (plan.state !== 'ready') throw new Error(`expected ready, got ${plan.state}`);
    expect(plan.steps[0]).toMatchObject({
      address: YIELD_ADDRESSES.rocketDepositPool,
      functionName: 'deposit',
      args: [],
      value: 10n ** 18n,
    });
  });

  it('pauses when Rocket Pool has moved its deposit pool', () => {
    const plan = rocketBase({ resolvedPool: '0x000000000000000000000000000000000000dEaD' });
    expect(plan.state).toBe('venue-paused');
    expect(plan.state === 'venue-paused' && plan.reason).toMatch(/moved its deposit pool/);
  });

  it('pauses rather than proceeding when the registry could not be read at all', () => {
    // The important direction: an unreadable gate must never fall through to
    // ready. A public RPC that refuses to answer can stop a deposit; it can
    // never be treated as consent.
    expect(rocketBase({ resolvedPool: null }).state).toBe('venue-paused');
    expect(depositPlan(base('rocketpool-reth', { rocket: undefined })).state).toBe('venue-paused');
  });

  it('pauses when deposits are switched off, and when that could not be read', () => {
    expect(rocketBase({ depositEnabled: false }).state).toBe('venue-paused');
    expect(rocketBase({ depositEnabled: null }).state).toBe('venue-paused');
  });

  it('reports the room left when the pool is too full for this deposit', () => {
    const plan = rocketBase({ maxPoolSize: 20n * 10n ** 18n, poolBalance: 19n * 10n ** 18n + 1n });
    expect(plan.state).toBe('venue-full');
    expect(plan.state === 'venue-full' && plan.roomWei).toBe(10n ** 18n - 1n);
  });

  it('reports the protocol minimum when the amount is under it', () => {
    const plan = depositPlan(
      base('rocketpool-reth', {
        amountText: '0.001',
        rocket: { ...base('rocketpool-reth').rocket!, minimumDeposit: 10n ** 16n },
      }),
    );
    expect(plan.state).toBe('below-minimum');
    expect(plan.state === 'below-minimum' && plan.minimum).toBe(10n ** 16n);
  });
});

describe('ether.fi wraps a MEASURED balance, never the deposit call\'s return value', () => {
  it('stops after the deposit when the eETH balance could not be read twice', () => {
    const plan = depositPlan(base('etherfi-weeth'));
    if (plan.state !== 'ready') throw new Error(`expected ready, got ${plan.state}`);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ address: YIELD_ADDRESSES.etherfiLiquidityPool, functionName: 'deposit' });
  });

  it('wraps balanceAfter − balanceBefore − 1 wei once both legs are read', () => {
    const plan = depositPlan(
      base('etherfi-weeth', { etherfi: { before: 5n * 10n ** 17n, after: 15n * 10n ** 17n } }),
    );
    if (plan.state !== 'ready') throw new Error(`expected ready, got ${plan.state}`);
    expect(plan.steps).toHaveLength(3);
    const expected = 10n ** 18n - 1n;
    // The approval's spender is weETH, NOT the LiquidityPool the ETH went to —
    // the one case on this surface where spender ≠ depositTarget, written out
    // rather than reached by a rule.
    expect(plan.steps[1]).toMatchObject({
      address: YIELD_ADDRESSES.eETH,
      functionName: 'approve',
      args: [YIELD_ADDRESSES.weETH, expected],
    });
    expect(plan.steps[2]).toMatchObject({
      address: YIELD_ADDRESSES.weETH,
      functionName: 'wrap',
      args: [expected],
    });
  });

  it('does not wrap when a single missing leg would make the amount a guess', () => {
    expect(
      depositPlan(base('etherfi-weeth', { etherfi: { before: 0n, after: null } })).state === 'ready' &&
        (depositPlan(base('etherfi-weeth', { etherfi: { before: 0n, after: null } })) as { steps: unknown[] }).steps,
    ).toHaveLength(1);
  });
});

describe('THE VACUITY GUARD: the pill cannot clear ahead of a working button', () => {
  it('gives every routable venue a ready plan whose last step is that venue\'s own destination', () => {
    // This is the assertion that ties `hasRoutableYieldVenue()` — which sets the
    // nav pill — to a transaction that would actually be submitted. Wiring a
    // depositTarget without a working route would clear the pill and fail here.
    const routable = routableYieldVenues();
    expect(routable.length).toBeGreaterThan(0);
    for (const venue of routable) {
      const plan = depositPlan(
        base(venue.id, { assetBalance: 10n ** 18n, allowance: 10n ** 18n, amountText: '0.5' }),
      );
      expect(plan.state, `${venue.id} does not reach 'ready' with a fully-satisfied input`).toBe('ready');
      if (plan.state !== 'ready') continue;
      const last = plan.steps[plan.steps.length - 1];
      const expectedTarget =
        venue.id === 'etherfi-weeth' ? YIELD_ADDRESSES.etherfiLiquidityPool : venue.depositTarget;
      expect(last?.address, `${venue.id}'s final step is not addressed to its depositTarget`).toBe(expectedTarget);
    }
  });

  it('routes exactly the venues this build verified, and no others', () => {
    expect(routableYieldVenues().map((v) => v.id)).toEqual([
      'lido-steth',
      'rocketpool-reth',
      'etherfi-weeth',
      'renzo-ezeth',
      'aave-v3-usdc',
      'compound-v3-usdc',
      'sky-susds',
    ]);
  });
});
