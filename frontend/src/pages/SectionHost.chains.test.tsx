/**
 * A section that runs on several networks: the drop-down leads the strip, the strip shows that
 * network's tabs, and a pick goes to the network's tab. A connected EVM wallet on another chain
 * is asked to switch; with no wallet nothing is switched and the URL carries the network.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

const wallet = vi.hoisted(() => ({ isConnected: false, chainId: 1, switchChain: vi.fn() }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: wallet.isConnected }),
  useChainId: () => wallet.chainId,
  useSwitchChain: () => ({ switchChain: wallet.switchChain }),
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

import { SectionHost } from './SectionHost';
import { LAUNCH_SECTION, POOLS_SECTION, type NavSection } from '../lib/navConfig';

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

const panels = (section: NavSection) =>
  Object.fromEntries(section.items.map((i) => [i.to, () => <div>{i.to} panel</div>]));

function at(section: NavSection, url: string, label: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <SectionHost
        section={section}
        idPrefix="t"
        ariaLabel="Test sections"
        panels={panels(section)}
        chains={{ label, missing: 'Nothing here' }}
      />
      <Where />
    </MemoryRouter>,
  );
}

const tabs = () => screen.getAllByRole('tab').map((t) => t.textContent);
const where = () => screen.getByTestId('where').textContent;

beforeEach(() => {
  window.localStorage.clear();
  wallet.isConnected = false;
  wallet.chainId = 1;
  wallet.switchChain.mockReset();
  toastError.mockReset();
});

describe('Pools, with its network drop-down', () => {
  it("shows only Solana's tabs on a Solana page", () => {
    at(POOLS_SECTION, '/solana-lp', 'Pools network');
    expect(screen.getByRole('button', { name: 'Pools network: Solana' })).toBeInTheDocument();
    expect(tabs()).toEqual(['Solana LP', 'Range', 'Venue AMM']);
  });

  it("shows Ethereum's tabs on the add / remove form with no wallet", () => {
    at(POOLS_SECTION, '/liquidity', 'Pools network');
    expect(screen.getByRole('button', { name: 'Pools network: Ethereum' })).toBeInTheDocument();
    expect(tabs()).toEqual(['Add / Remove', 'Zap']);
  });

  it('opens Base on the add / remove form by its URL, without a wallet prompt', () => {
    at(POOLS_SECTION, '/solana-lp', 'Pools network');
    fireEvent.click(screen.getByRole('button', { name: 'Pools network: Solana' }));
    fireEvent.click(screen.getByRole('option', { name: /^Base/ }));
    expect(where()).toBe('/liquidity?c=8453');
    expect(wallet.switchChain).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pools network: Base' })).toBeInTheDocument();
    expect(tabs()).toEqual(['Add / Remove']);
  });

  it('asks a connected wallet on another chain to switch, as Uniswap does', () => {
    wallet.isConnected = true;
    at(POOLS_SECTION, '/liquidity', 'Pools network');
    fireEvent.click(screen.getByRole('button', { name: 'Pools network: Ethereum' }));
    fireEvent.click(screen.getByRole('option', { name: /Robinhood Chain/ }));
    expect(wallet.switchChain).toHaveBeenCalledWith({ chainId: 4663 }, expect.anything());
  });

  it('says so when the wallet refuses the switch, instead of snapping back in silence', () => {
    wallet.isConnected = true;
    at(POOLS_SECTION, '/liquidity', 'Pools network');
    fireEvent.click(screen.getByRole('button', { name: 'Pools network: Ethereum' }));
    fireEvent.click(screen.getByRole('option', { name: /^Base/ }));
    expect(toastError).not.toHaveBeenCalled();
    const [, handlers] = wallet.switchChain.mock.calls[0] as [unknown, { onError: (e: Error) => void }];
    handlers.onError(new Error('User rejected the request.'));
    expect(toastError).toHaveBeenCalledWith('Your wallet did not switch to Base. Switch it in your wallet to use Base here.');
  });

  it('leaves the wallet alone when the pick is Solana', () => {
    wallet.isConnected = true;
    at(POOLS_SECTION, '/liquidity', 'Pools network');
    fireEvent.click(screen.getByRole('button', { name: 'Pools network: Ethereum' }));
    fireEvent.click(screen.getByRole('option', { name: /Solana/ }));
    expect(where()).toBe('/solana-lp');
    expect(wallet.switchChain).not.toHaveBeenCalled();
  });
});

describe('Launch, with its network drop-down', () => {
  it("reads the curve's own ?c= and keeps it when a tab that names no chain is opened", () => {
    at(LAUNCH_SECTION, '/eth-curve?c=8453', 'Launch network');
    expect(screen.getByRole('button', { name: 'Launch network: Base' })).toBeInTheDocument();
    expect(tabs()).not.toContain('Launchpad');
    fireEvent.click(screen.getByRole('tab', { name: 'Simulator' }));
    expect(where()).toBe('/launch-simulator?chain=base');
    expect(screen.getByRole('button', { name: 'Launch network: Base' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Memetics Curve/ }));
    expect(where()).toBe('/eth-curve?c=8453');
  });

  it('keeps the visitor on the curve when the network changes', () => {
    at(LAUNCH_SECTION, '/eth-curve?c=8453', 'Launch network');
    fireEvent.click(screen.getByRole('button', { name: 'Launch network: Base' }));
    fireEvent.click(screen.getByRole('option', { name: /Ethereum/ }));
    expect(where()).toBe('/eth-curve?c=1');
  });
});
