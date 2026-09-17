/**
 * OUTAGE-AS-EMPTY-WALLET — LiquidityTab's balances and its add CTA.
 *
 * `useAddLiquidity` reads the wallet's token balances in a batch ([5] token A,
 * [7] token B) and collapsed a failed read to 0n; the tab reads native ETH with
 * `useBalance` and collapsed a missing answer to 0 the same way. On this tab a 0
 * is a CLAIM, twice over:
 *
 *   - "Balance: 0.0000" beside the input, and
 *   - "Not enough TOWELI" on the CTA the moment an amount is typed,
 *
 * both about a wallet nobody read. (`lpUnread` had already fixed the same claim
 * for the LP balance — "You don't hold any LP" — in this very file.) The CTA was
 * disabled in that state before and stays disabled after: what changes is only
 * what it asserts. Both directions are pinned; a READ 0 is a real empty wallet.
 *
 * Driven through the REAL hook. The wagmi mock below answers each read by
 * `functionName:address`, never by position, so a desynced batch index surfaces
 * as the wrong token's balance going missing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { parseEther } from 'viem';
import { TOWELI_ADDRESS } from '../../lib/constants';

type Answer = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };

const h = vi.hoisted(() => ({
  reads: new Map<string, Answer>(),
  native: { data: undefined as undefined | { value: bigint; decimals: number }, isError: false },
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xdddddddddddddddddddddddddddddddddddddddd', isConnected: true }),
  useChainId: () => 1,
  useWalletClient: () => ({ data: undefined }),
  useBalance: (opts: { query?: { enabled?: boolean } }) =>
    opts?.query?.enabled ? { data: h.native.data, isError: h.native.isError } : { data: undefined, isError: false },
  // getPair: unstubbed → no pair → an empty pool, so the two amounts are independent.
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: ({ contracts }: { contracts: Array<{ functionName: string; address: string }> }) => ({
    data: contracts.map(
      (c) => h.reads.get(`${c.functionName}:${c.address.toLowerCase()}`)
        ?? ({ status: 'failure', error: new Error('no stub') } as Answer),
    ),
    refetch: vi.fn(),
    isLoading: false,
  }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, reset: vi.fn(), error: null }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isLoading: false, isSuccess: false, isError: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => <button type="button">Connect</button> }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('./TokenSelectModal', () => ({ TokenSelectModal: () => null }));

import { LiquidityTab } from './LiquidityTab';

const TOWELI = TOWELI_ADDRESS.toLowerCase();

function ok(key: string, result: unknown) {
  h.reads.set(key, { status: 'success', result });
}
function failed(key: string) {
  h.reads.set(key, { status: 'failure', error: new Error('read failed') });
}
/** The default pair is native ETH (A) + TOWELI (B). TOWELI's router allowance is ample, so no Approve step intervenes. */
function stubToweli(balance: bigint | 'failed') {
  ok(`allowance:${TOWELI}`, 2n ** 255n);
  if (balance === 'failed') failed(`balanceOf:${TOWELI}`);
  else ok(`balanceOf:${TOWELI}`, balance);
}
function nativeEth(state: bigint | 'failed' | 'pending') {
  h.native.data = typeof state === 'bigint' ? { value: state, decimals: 18 } : undefined;
  h.native.isError = state === 'failed';
}

function renderAndType(amountEth: string, amountToweli: string) {
  render(<LiquidityTab />);
  const [a, b] = screen.getAllByRole('spinbutton');
  fireEvent.change(a!, { target: { value: amountEth } });
  fireEvent.change(b!, { target: { value: amountToweli } });
}
const cta = () => screen.getByTestId('liquidity-submit');
/** "Balance: …" beside the named input. */
const balanceOf = (side: 'Token A' | 'Token B') => screen.getByText(side).nextElementSibling?.textContent ?? '';
const notice = () => screen.queryByTestId('liquidity-balance-unread');

beforeEach(() => {
  h.reads.clear();
  nativeEth(parseEther('1'));
});

describe('LiquidityTab — balance UNREAD', () => {
  it('does not say "Not enough TOWELI" about a TOWELI balance it could not read', () => {
    // OLD: balanceOf(TOWELI) collapsed to 0n → "Balance: 0.0000" and a CTA
    // reading "Not enough TOWELI" on a wallet that may hold millions.
    stubToweli('failed');
    renderAndType('0.1', '100');

    expect(cta()).not.toHaveTextContent(/not enough/i);
    expect(cta()).toHaveTextContent(/TOWELI balance unavailable/i);
    expect(cta()).toBeDisabled();
    expect(balanceOf('Token B')).toBe('Balance: –');
    expect(notice()).toHaveTextContent(/your TOWELI balance could not be read/i);
    expect(notice()).toHaveTextContent(/not a statement that you hold none/i);
    // Token A was read, and still says so.
    expect(balanceOf('Token A')).toBe('Balance: 1.0000');
  });

  it('does not say "Not enough ETH" about a native balance it could not read', () => {
    // OLD: useBalance's missing answer collapsed to 0 → "Not enough ETH".
    nativeEth('failed');
    stubToweli(parseEther('1000'));
    renderAndType('0.1', '100');

    expect(cta()).not.toHaveTextContent(/not enough/i);
    expect(cta()).toHaveTextContent(/ETH balance unavailable/i);
    expect(cta()).toBeDisabled();
    expect(balanceOf('Token A')).toBe('Balance: –');
    expect(notice()).toHaveTextContent(/your ETH balance could not be read/i);
  });

  it('calls a balance still in flight "Reading…", not empty — and raises no outage', () => {
    // OLD: a pending read is also 0 → "Not enough ETH" for the first seconds.
    nativeEth('pending');
    stubToweli(parseEther('1000'));
    renderAndType('0.1', '100');

    expect(cta()).toHaveTextContent(/Reading ETH balance/i);
    expect(cta()).toBeDisabled();
    expect(notice()).toBeNull();
  });
});

describe('LiquidityTab — balance GENUINE', () => {
  // NOT DISCRIMINATING against the old code — identical before and after. They
  // fail if the fix is ever widened into treating a READ 0 as unknown.
  it('a TOWELI balance READ as 0 is a real empty wallet, and says so', () => {
    stubToweli(0n);
    renderAndType('0.1', '100');

    expect(cta()).toHaveTextContent('Not enough TOWELI');
    expect(cta()).toBeDisabled();
    expect(balanceOf('Token B')).toBe('Balance: 0.0000');
    expect(notice()).toBeNull();
  });

  it('known, sufficient balances arm the add', () => {
    stubToweli(parseEther('1000'));
    renderAndType('0.1', '100');

    expect(cta()).toHaveTextContent('Grow the Crop');
    expect(cta()).toBeEnabled();
  });
});
