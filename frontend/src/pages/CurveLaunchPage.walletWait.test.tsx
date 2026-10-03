// The read-only /curve-launch page has its own Connect button on the Wallet card. Like
// the shared one (components/solana/SolanaConnectButton.tsx), it was switched off for as
// long as a wallet was being waited on, and a wallet that never answers (a locked one, an
// approval window nobody saw) is waited on for ever. A press while it waits now reaches
// the page's connect click, which opens the wallet list (useSolanaConnect).

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CurveLaunchView } from './CurveLaunchPage';

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x' }),
}));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('../lib/heat/heatClient', () => ({
  fetchHeat: () => new Promise(() => {}),
  isSupportedHeatAddress: () => true,
  clearHeatCache: () => {},
  HeatUnavailableError: class HeatUnavailableError extends Error {},
}));

function view(connecting: boolean, onConnect: () => void) {
  return (
    <MemoryRouter>
      <CurveLaunchView
        probe={{ kind: 'deployed', executable: true }}
        snapshot={null}
        mint={null}
        mintInput=""
        onMintInput={vi.fn()}
        onLookup={vi.fn()}
        loading={false}
        wallet={{ address: null, connecting, onConnect }}
      />
    </MemoryRouter>
  );
}

/** The Wallet card's own button (the door above it has a connect button of its own). */
function walletCardButton(name: string) {
  const card = screen.getByText(/Connecting only fills in your address/).closest('section, div');
  if (!(card instanceof HTMLElement)) throw new Error('no Wallet card');
  return within(card.parentElement ?? card).getByRole('button', { name });
}

describe('/curve-launch Wallet card while a wallet is being waited on', () => {
  it('connects on a press when nothing is being waited on (the control)', () => {
    const onConnect = vi.fn();
    render(view(false, onConnect));
    fireEvent.click(walletCardButton('Connect Solana Wallet'));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('stays pressable while it waits, and the press reaches the page\'s connect click', () => {
    const onConnect = vi.fn();
    render(view(true, onConnect));
    const button = walletCardButton('Connecting…');
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});
