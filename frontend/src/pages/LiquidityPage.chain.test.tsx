// The add / remove page names the chain its form is on. Picked from the network drop-down with
// no wallet (`?c=`), or the wallet's chain once one is connected; a wallet's chain always wins,
// so a write is never addressed to a chain the URL names. Off mainnet the Ethereum pool table
// is not shown over a Base form, and the money line says how the venue earns there.
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const wallet = vi.hoisted(() => ({ isConnected: false, chainId: 1 }));
const formMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: wallet.isConnected }),
  useChainId: () => wallet.chainId,
}));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../hooks/usePoolTVL', () => ({ usePoolTVL: () => ({}) }));
vi.mock('../components/swap/LiquidityTab', async () => {
  const { useEffect } = await import('react');
  return {
    LiquidityTab: ({ chainId }: { chainId?: number }) => {
      useEffect(() => { formMounts.count += 1; }, []);
      return <div data-testid="form">{chainId}</div>;
    },
  };
});
vi.mock('../components/farm/ILCalculator', () => ({ ILCalculator: () => null }));
vi.mock('../components/liquidity/LiquidityPrimer', () => ({ LiquidityPrimer: () => null }));
vi.mock('../components/liquidity/VenuePoolTable', () => ({ VenuePoolTable: () => <div data-testid="pool-table" /> }));

import LiquidityPage from './LiquidityPage';

const at = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <LiquidityPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  wallet.isConnected = false;
  wallet.chainId = 1;
  formMounts.count = 0;
});

describe('/liquidity on the picked chain', () => {
  it('is Ethereum by default, with its pool table and its own money line', () => {
    at('/liquidity');
    expect(screen.getByText(/^Ethereum pools\./)).toBeInTheDocument();
    expect(screen.getByTestId('pool-table')).toBeInTheDocument();
    expect(screen.getByTestId('form')).toHaveTextContent('1');
  });

  it('follows ?c= with no wallet: Base names Base, hides the Ethereum table and says where the venue cut goes', () => {
    at('/liquidity?c=8453');
    // The chain is named in the money line, not an eyebrow (owner, 2026-10-14).
    // A new pair starts with kLast = 0, so a Base pool's cut is off until the venue switches
    // it on; the line may not claim it is on (it did until 2026-10-17).
    expect(screen.getByText(/^Base pools\./)).toHaveTextContent(/all to providers until the venue switches on its one-sixth cut for that pool, which goes to the venue's fee Safe/);
    expect(screen.queryByText(/TOWELI\/ETH/)).toBeNull();
    expect(screen.queryByTestId('pool-table')).toBeNull();
    expect(screen.getByTestId('form')).toHaveTextContent('8453');
    // ...and the fine print under it says the same, not Ethereum's TOWELI/ETH split.
    expect(screen.getByText(/only on a pool where it has switched that on\. There is no pool here yet/)).toBeInTheDocument();
    expect(screen.queryByText(/since 16 October 2026/)).toBeNull();
  });

  it('refuses a ?c= with no venue on it', () => {
    at('/liquidity?c=42161');
    expect(screen.getByText(/^Ethereum pools\./)).toBeInTheDocument();
    expect(screen.getByTestId('form')).toHaveTextContent('1');
  });

  it('keeps the Ethereum header and table for a wallet on a chain we run no venue on', () => {
    wallet.isConnected = true;
    wallet.chainId = 42161;
    at('/liquidity');
    expect(screen.getByText(/^Ethereum pools\./)).toBeInTheDocument();
    expect(screen.getByTestId('pool-table')).toBeInTheDocument();
    expect(screen.queryByText(/until the venue switches on its one-sixth cut for that pool/)).toBeNull();
    // The form gets the wallet's chain and refuses it there, as before.
    expect(screen.getByTestId('form')).toHaveTextContent('42161');
  });

  // Walked live 2026-10-18: the form kept the pair (and the pasted tokens) of the chain it
  // was first mounted on, so a wallet moving to Base still held Ethereum's TOWELI.
  it('starts the form afresh when the wallet moves to another network', () => {
    wallet.isConnected = true;
    wallet.chainId = 1;
    const view = at('/liquidity');
    expect(formMounts.count).toBe(1);
    wallet.chainId = 8453;
    view.rerender(
      <MemoryRouter initialEntries={['/liquidity']}>
        <LiquidityPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('form')).toHaveTextContent('8453');
    expect(formMounts.count).toBe(2);
  });

  it("ignores ?c= once a wallet is connected: the wallet's chain is the one that signs", () => {
    wallet.isConnected = true;
    wallet.chainId = 4663;
    at('/liquidity?c=8453');
    expect(screen.getByText(/^Robinhood Chain pools\./)).toBeInTheDocument();
    expect(screen.getByTestId('form')).toHaveTextContent('4663');
  });
});
