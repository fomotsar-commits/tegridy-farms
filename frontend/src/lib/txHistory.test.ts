import { describe, it, expect } from 'vitest';
import { categorizeTx, HISTORY_CONTRACTS, parseTxRecords, type TxRecord } from './txHistory';
import {
  LP_FARMING_ADDRESS, TEGRIDY_ROUTER_ADDRESS, TEGRIDY_STAKING_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS, isDeployed,
} from './constants';

// Minimal valid TxRecord factory for categorize tests.
function tx(to: string, functionName = ''): TxRecord {
  return {
    hash: '0x' + 'a'.repeat(64),
    to,
    timeStamp: '1700000000',
    value: '0',
    functionName,
    isError: '0',
  };
}

describe('categorizeTx', () => {
  it('labels native SwapFeeRouter swaps as Swap', () => {
    expect(categorizeTx(tx(SWAP_FEE_ROUTER_ADDRESS, 'swapExactETHForTokens()')).type).toBe('Swap');
  });

  it('labels staking stake/withdraw/claim', () => {
    expect(categorizeTx(tx(TEGRIDY_STAKING_ADDRESS, 'stake()')).type).toBe('Stake');
    expect(categorizeTx(tx(TEGRIDY_STAKING_ADDRESS, 'withdraw()')).type).toBe('Unstake');
    expect(categorizeTx(tx(TEGRIDY_STAKING_ADDRESS, 'getReward()')).type).toBe('Claim');
  });

  it('F382: labels live LP Farming stakes/claims', () => {
    // LP Farming is live post-relaunch; guard so the test is meaningful only
    // when the address is non-zero.
    if (!isDeployed(LP_FARMING_ADDRESS)) return;
    expect(categorizeTx(tx(LP_FARMING_ADDRESS, 'stake()')).type).toBe('Stake LP');
    expect(categorizeTx(tx(LP_FARMING_ADDRESS, 'withdraw()')).type).toBe('Unstake LP');
    expect(categorizeTx(tx(LP_FARMING_ADDRESS, 'getReward()')).type).toBe('Claim');
  });

  it('F382: labels native Tegridy Router liquidity adds + swaps', () => {
    if (!isDeployed(TEGRIDY_ROUTER_ADDRESS)) return;
    expect(categorizeTx(tx(TEGRIDY_ROUTER_ADDRESS, 'addLiquidity()')).type).toBe('Liquidity');
    expect(categorizeTx(tx(TEGRIDY_ROUTER_ADDRESS, 'swapExactTokensForETH()')).type).toBe('Swap');
  });

  it('falls back to Approve for an approve to an untracked address', () => {
    expect(categorizeTx(tx('0x' + '9'.repeat(40), 'approve()')).type).toBe('Approve');
  });

  it('falls back to Other for unknown destinations', () => {
    expect(categorizeTx(tx('0x' + '9'.repeat(40), 'frobnicate()')).type).toBe('Other');
  });
});

describe('HISTORY_CONTRACTS', () => {
  it('contains only deployed (non-zero), lowercased addresses', () => {
    expect(HISTORY_CONTRACTS.length).toBeGreaterThan(0);
    for (const a of HISTORY_CONTRACTS) {
      expect(a).toBe(a.toLowerCase());
      expect(a).not.toBe('0x0000000000000000000000000000000000000000');
    }
  });

  it('F382: includes live LP Farming + native Tegridy Router when deployed', () => {
    if (isDeployed(LP_FARMING_ADDRESS)) {
      expect(HISTORY_CONTRACTS).toContain(LP_FARMING_ADDRESS.toLowerCase());
    }
    if (isDeployed(TEGRIDY_ROUTER_ADDRESS)) {
      expect(HISTORY_CONTRACTS).toContain(TEGRIDY_ROUTER_ADDRESS.toLowerCase());
    }
  });
});

describe('parseTxRecords', () => {
  it('drops malformed rows and keeps valid ones', () => {
    const valid = {
      hash: '0x' + 'b'.repeat(64),
      to: '0x' + 'c'.repeat(40),
      timeStamp: '1700000000',
      value: '1000',
      functionName: 'stake()',
      isError: '0',
    };
    const out = parseTxRecords([valid, { hash: 'nope' }, null, 42]);
    expect(out).toHaveLength(1);
    expect(out[0]!.hash).toBe(valid.hash);
  });

  it('returns [] for non-array input', () => {
    expect(parseTxRecords(null)).toEqual([]);
    expect(parseTxRecords({})).toEqual([]);
  });
});
