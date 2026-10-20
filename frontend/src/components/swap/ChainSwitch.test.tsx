import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false }),
  useChainId: () => 1,
  useSwitchChain: () => ({ switchChain: vi.fn() }),
}));

import { ChainSwitch } from './ChainSwitch';

/**
 * Swap's network drop-down. The URL is the only thing these tests give it: the page names the
 * network, so the drop-down cannot say Solana over the Ethereum form. Since 2026-10-17 Base and
 * Robinhood Chain swap too, on the same /swap page (`?c=` names the chain with no wallet).
 */
function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

function mount(url = '/swap', at?: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ChainSwitch at={at} />
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('ChainSwitch, the Swap network drop-down', () => {
  it('names the network of the page it is on', () => {
    mount('/swap');
    expect(screen.getByRole('button', { name: 'Swap network: Ethereum' })).toBeInTheDocument();
  });

  it('names Base when a visitor with no wallet opens /swap?c=8453', () => {
    mount('/swap?c=8453');
    expect(screen.getByRole('button', { name: 'Swap network: Base' })).toBeInTheDocument();
  });

  it('lists all four networks, says where each routes, and greys none', () => {
    mount('/solana');
    fireEvent.click(screen.getByRole('button', { name: 'Swap network: Solana' }));
    expect(screen.getByRole('option', { name: /Ethereum.*Uniswap \/ CoW/ })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /Solana.*Our pools \+ Jupiter/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /Base.*Our pools \+ Uniswap/ })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /Robinhood Chain.*Our pools \+ Uniswap/ })).not.toHaveAttribute('aria-disabled', 'true');
  });

  // The home's swap card is /solana's form on `/` (owner, 2026-10-17: "swap and add liquidity
  // missing chain drop down"): its drop-down says Solana there, and Base leaves for Base's swap.
  it('on the home card, names Solana and sends Base to /swap?c=8453', () => {
    mount('/', '/solana');
    fireEvent.click(screen.getByRole('button', { name: 'Swap network: Solana' }));
    fireEvent.click(screen.getByRole('option', { name: /Base/ }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/swap\?c=8453$/);
  });

  it('goes to the other swap and back, so neither is a dead end', () => {
    mount('/solana?out=7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
    fireEvent.click(screen.getByRole('button', { name: 'Swap network: Solana' }));
    fireEvent.click(screen.getByRole('option', { name: /Ethereum/ }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/swap\?c=1$/);
    fireEvent.click(screen.getByRole('button', { name: 'Swap network: Ethereum' }));
    fireEvent.click(screen.getByRole('option', { name: /Solana/ }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/solana$/);
  });
});
