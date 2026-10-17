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
 * network, so the drop-down cannot say Solana over the Ethereum form. Base and Robinhood Chain
 * are listed and greyed, because the swap stack trades on mainnet only.
 */
function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

function mount(url = '/swap') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ChainSwitch />
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

  it('lists all four networks, says where each routes, and greys the two with no swap', () => {
    mount('/solana');
    fireEvent.click(screen.getByRole('button', { name: 'Swap network: Solana' }));
    expect(screen.getByRole('option', { name: /Ethereum.*Uniswap \/ CoW/ })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /Solana.*Our pools \+ Jupiter/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /Base.*No swap here/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /Robinhood Chain.*No swap here/ })).toHaveAttribute('aria-disabled', 'true');
  });

  it('goes to the other swap and back, so neither is a dead end', () => {
    mount('/solana?out=7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
    fireEvent.click(screen.getByRole('button', { name: 'Swap network: Solana' }));
    fireEvent.click(screen.getByRole('option', { name: /Ethereum/ }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/swap$/);
    fireEvent.click(screen.getByRole('button', { name: 'Swap network: Ethereum' }));
    fireEvent.click(screen.getByRole('option', { name: /Solana/ }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/solana$/);
  });
});
