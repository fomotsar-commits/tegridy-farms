import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The section shows only with every address set: fake ones, which are not contracts.
vi.mock('../../lib/chains/hyperEvmDeployment', () => ({
  HYPEREVM_DEPLOYMENT: {
    factory: '0x1000000000000000000000000000000000000001',
    positionManager: '0x1000000000000000000000000000000000000002',
    quoterV2: '0x1000000000000000000000000000000000000003',
    universalRouter: '0x1000000000000000000000000000000000000004',
    feeAdapter: '0x1000000000000000000000000000000000000005',
    treasury: '0x1000000000000000000000000000000000000006',
    siteFeeBps: 30,
  },
}));

// No chain: the pools read did not come back, and a wallet is connected on HyperEVM.
vi.mock('./useHyperEvm', () => ({
  asReader: (c: unknown) => c,
  useHyperEvmClient: () => ({}),
  useBalance: () => null,
  usePools: () => ({ state: { status: 'unread' }, reload: () => {} }),
  useHyperEvmSend: () => ({
    state: { kind: 'idle' }, run: async () => false, reset: () => {}, onChain: true,
    switchToHyperEvm: async () => {}, address: '0x7000000000000000000000000000000000000007', isConnected: true,
  }),
}));

import HyperEvmPoolsSection from './HyperEvmPoolsSection';

describe('the HyperEVM pools section, when the chain does not answer', () => {
  it('says the pools and the positions could not be read, and never keeps saying "reading"', () => {
    render(<HyperEvmPoolsSection />);
    expect(screen.getByText('Our pools could not be read just now.')).toBeTruthy();
    expect(screen.getByText('Your positions could not be read just now.')).toBeTruthy();
    expect(screen.queryByText(/Reading your positions/)).toBeNull();
  });
});
