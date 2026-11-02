/**
 * STAKING RELEASE 1 points the site's LP farm at a new contract. The first farm
 * (OLD_LP_FARMING_ADDRESS) still holds 528.2 LP for one wallet (read 2026-10-14), and
 * without this card that LP would have no door on the site at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }));

import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';
import { OldLpFarmExit } from './OldLpFarmExit';
import { CHAIN_ID, OLD_LP_FARMING_ADDRESS } from '../../lib/constants';

const USER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`;

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(CHAIN_ID);
  wagmiMock.setAccount({ address: USER, isConnected: true });
});

describe('<OldLpFarmExit />', () => {
  it('shows the LP left in the old farm and withdraws it there with exit()', () => {
    wagmiMock.setReadResult({ address: OLD_LP_FARMING_ADDRESS, functionName: 'rawBalanceOf', result: 528_199_806_982_326_905_120n });
    wagmiMock.setReadResult({ address: OLD_LP_FARMING_ADDRESS, functionName: 'earned', result: 0n });
    renderWithProviders(<OldLpFarmExit />);
    const button = screen.getByRole('button', { name: /withdraw 528\.1998 LP/i });
    fireEvent.click(button);
    expect(wagmiMock.writeContract()).toHaveBeenCalledWith(expect.objectContaining({
      address: OLD_LP_FARMING_ADDRESS, functionName: 'exit', chainId: CHAIN_ID,
    }));
  });

  it('renders nothing for a wallet with no LP there', () => {
    wagmiMock.setReadResult({ address: OLD_LP_FARMING_ADDRESS, functionName: 'rawBalanceOf', result: 0n });
    renderWithProviders(<OldLpFarmExit />);
    expect(screen.queryByTestId('old-lp-farm-exit')).toBeNull();
    expect(screen.queryByTestId('old-lp-farm-unread')).toBeNull();
  });

  it('an unanswered read is said, never shown as "no LP"', () => {
    renderWithProviders(<OldLpFarmExit />);
    expect(screen.getByTestId('old-lp-farm-unread')).toBeInTheDocument();
  });
});
