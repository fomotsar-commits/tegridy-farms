// OUTAGE-AS-EMPTY-WALLET — the hook half. LiquidityTab's tests drive the default
// ETH/TOWELI pair, where side A is native and never reaches batch index [5]. This
// pins both ERC20 legs against their OWN reads: the shared mock answers balanceOf
// by token address, so a desynced index shows up as the wrong side going unread.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import type { TokenInfo } from '../lib/tokenList';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { useAddLiquidity } from './useAddLiquidity';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
const A: TokenInfo = { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'AAA', name: 'Token A', decimals: 18, logoURI: '' };
const B: TokenInfo = { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', symbol: 'BBB', name: 'Token B', decimals: 6, logoURI: '' };

function balance(token: TokenInfo, result: bigint | 'failed') {
  wagmiMock.setReadResult(
    result === 'failed'
      ? { functionName: 'balanceOf', address: token.address, result: undefined, status: 'failure' }
      : { functionName: 'balanceOf', address: token.address, result },
  );
}

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: USER, isConnected: true });
});

describe('useAddLiquidity — wallet balances are read per side', () => {
  it('an unread token-A balance is unread; token B is judged on its own read', () => {
    balance(A, 'failed');
    balance(B, 0n);
    const { result } = renderHook(() => useAddLiquidity(A, B));

    expect(result.current.tokenABalanceReadOk).toBe(false);
    expect(result.current.tokenABalanceUnread).toBe(true);
    // The collapse stays, deliberately — that is why the flag has to exist.
    expect(result.current.tokenABalance).toBe(0n);
    // B's 0 was READ: a real empty wallet, not an outage.
    expect(result.current.tokenBBalanceReadOk).toBe(true);
    expect(result.current.tokenBBalanceUnread).toBe(false);
  });

  it('an unread token-B balance is unread; token A is judged on its own read', () => {
    balance(A, 0n);
    balance(B, 'failed');
    const { result } = renderHook(() => useAddLiquidity(A, B));

    expect(result.current.tokenABalanceReadOk).toBe(true);
    expect(result.current.tokenABalanceUnread).toBe(false);
    expect(result.current.tokenBBalanceReadOk).toBe(false);
    expect(result.current.tokenBBalanceUnread).toBe(true);
  });
});
