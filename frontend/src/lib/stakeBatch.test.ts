import { describe, it, expect } from 'vitest';
import { buildApproveStakeCalls } from './stakeBatch';
import { TOWELI_ADDRESS, TEGRIDY_STAKING_ADDRESS } from './constants';

describe('buildApproveStakeCalls', () => {
  it('builds a 2-call approve+stake batch with the right targets and encoding', () => {
    const amount = 1_000_000n * 10n ** 18n;
    const lock = 2_592_000n; // 30 days
    const calls = buildApproveStakeCalls(amount, lock);

    expect(calls).toHaveLength(2);

    // Call 1 = approve on the TOWELI token.
    expect(calls[0]!.to.toLowerCase()).toBe(TOWELI_ADDRESS.toLowerCase());
    // ERC-20 approve(address,uint256) selector.
    expect(calls[0]!.data!.startsWith('0x095ea7b3')).toBe(true);
    // 4-byte selector + two 32-byte words.
    expect(calls[0]!.data!.length).toBe(2 + 8 + 64 + 64);
    // The amount is the second word of the approve args.
    expect(calls[0]!.data!.endsWith(amount.toString(16).padStart(64, '0'))).toBe(true);

    // Call 2 = stake on the staking contract, non-empty encoded data.
    expect(calls[1]!.to.toLowerCase()).toBe(TEGRIDY_STAKING_ADDRESS.toLowerCase());
    expect(calls[1]!.data!.startsWith('0x')).toBe(true);
    expect(calls[1]!.data!.length).toBeGreaterThan(10);
    // The stake amount + lock are both encoded (two 32-byte words after the selector).
    expect(calls[1]!.data!.includes(amount.toString(16).padStart(64, '0'))).toBe(true);
    expect(calls[1]!.data!.includes(lock.toString(16).padStart(64, '0'))).toBe(true);
  });

  it('encodes different amounts distinctly (no accidental constant)', () => {
    const a = buildApproveStakeCalls(1n, 100n);
    const b = buildApproveStakeCalls(2n, 100n);
    expect(a[0]!.data).not.toBe(b[0]!.data);
  });
});
