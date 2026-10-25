// The Harvest card on /earn: what it says before, during and after a run. The planning and
// the run order have their own tests (lib/harvest/*.test.ts); this is the screen.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { EvmClaim } from '../../lib/harvest/evm';
import type { ClaimResult, HarvestPlan } from '../../lib/harvest/types';

const evm = vi.hoisted(() => ({
  state: {
    address: null as string | null,
    chain: null as 'ethereum' | 'base' | null,
    plan: null as HarvestPlan<EvmClaim> | null,
  },
  send: vi.fn(),
  switchTo: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('../../hooks/useEvmHarvest', () => ({
  useEvmHarvest: () => ({ ...evm.state, send: evm.send, switchTo: evm.switchTo, refetch: evm.refetch }),
}));
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: { Custom: ({ children }: { children: (p: { openConnectModal: () => void; mounted: boolean }) => unknown }) => children({ openConnectModal: () => {}, mounted: true }) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn() } }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
// The Solana half is lazy and mounts only with a Solana wallet in play; none is here.
vi.mock('./HarvestSolana', () => ({ default: () => null }));

import { HarvestCard } from './HarvestCard';

const claim = (id: string, chain: 'ethereum' | 'base', amount: bigint): EvmClaim => ({
  key: `evm:${id}`, chain, chainId: chain === 'base' ? 8453 : 1, pool: '0x0000000000000000000000000000000000000001',
  roomId: id, symbol: id.toUpperCase(), where: 'lighthouse pool', detail: null, amountRaw: amount, decimals: 18, caution: null,
});

const show = () => render(<MemoryRouter><HarvestCard /></MemoryRouter>);

beforeEach(() => {
  evm.state = { address: null, chain: null, plan: null };
  evm.send.mockReset();
  evm.switchTo.mockReset();
  evm.refetch.mockReset();
});

describe('Harvest card', () => {
  it('with no wallet: says how money moves, and offers both connects', () => {
    show();
    expect(screen.getByRole('heading', { name: 'Harvest' })).toBeTruthy();
    expect(screen.getByText(/The venue takes nothing; you pay the network fees\./)).toBeTruthy();
    expect(screen.getByText('Connect a wallet to see what you can claim.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Solana wallet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Ethereum wallet' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Harvest all/ })).toBeNull();
  });

  it('while reading: the button waits and promises nothing', () => {
    evm.state = { address: '0xabc', chain: 'base', plan: null };
    show();
    const btn = screen.getByRole('button', { name: 'Reading your pools…' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('lists each claim in its own coin, and a pool not read as not read, never as nothing', () => {
    evm.state = {
      address: '0xabc',
      chain: 'base',
      plan: {
        claims: [claim('pepe', 'ethereum', 3n * 10n ** 18n), claim('qr', 'base', 1500n * 10n ** 18n)],
        held: [],
        unread: [{ key: 'evm:jbm', chain: 'base', roomId: 'jbm', what: 'your JBM rewards', detail: 'the JBM pool did not answer' }],
      },
    };
    show();
    const list = screen.getByRole('list', { name: 'Ready to claim' });
    // Base first: the wallet is on Base, so it switches network once.
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent?.split('lighthouse')[0]?.trim())).toEqual(['1,500 QR', '3 PEPE']);
    expect(screen.getByText(/Could not read your JBM rewards/).textContent).toMatch(/Not a zero\./);
    expect(screen.getByRole('button', { name: 'Harvest all · 2 claims' })).toBeTruthy();
    expect(screen.getByText('Your wallet asks once per claim.')).toBeTruthy();
  });

  it('a run marks each claim as it lands, links the transaction, and offers to check again', async () => {
    evm.state = { address: '0xabc', chain: 'base', plan: { claims: [claim('qr', 'base', 10n ** 18n), claim('pepe', 'ethereum', 10n ** 18n)], held: [], unread: [] } };
    evm.switchTo.mockResolvedValue({ kind: 'ok' });
    evm.send.mockImplementation(async (c: EvmClaim): Promise<ClaimResult> =>
      c.chain === 'base' ? { kind: 'claimed', tx: '0xfeed' } : { kind: 'reverted', reason: 'Refused on chain: nothing was claimed, and only the network fee was spent.', tx: '0xbad' });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Harvest all · 2 claims' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy());
    expect(evm.send.mock.calls.map(([c]) => (c as EvmClaim).roomId)).toEqual(['qr', 'pepe']);
    expect(evm.switchTo).toHaveBeenCalledTimes(1);
    expect(evm.switchTo).toHaveBeenCalledWith('ethereum');
    const claimed = screen.getByRole('link', { name: /Claimed: view the transaction/ }) as HTMLAnchorElement;
    expect(claimed.href).toContain('basescan.org/tx/0xfeed');
    expect(screen.getByText(/only the network fee was spent/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Done: 1 claimed · 1 reverted.');
    expect(evm.refetch).toHaveBeenCalled();
  });

  it('a pool it leaves alone says why, and points to that pool’s page', () => {
    evm.state = {
      address: '0xabc',
      chain: 'ethereum',
      plan: { claims: [], held: [{ key: 'evm:pepe', chain: 'ethereum', roomId: 'pepe', symbol: 'PEPE', where: 'lighthouse pool', amountRaw: 10n ** 18n, decimals: 18, reason: 'Its reward vault is empty right now, so a claim would pay nothing. Nothing is lost: it stays owed.' }], unread: [] },
    };
    show();
    expect(screen.getByText(/Its reward vault is empty right now/)).toBeTruthy();
    expect((screen.getByRole('link', { name: "The PEPE pool's page" }) as HTMLAnchorElement).getAttribute('href')).toBe('/earn/pepe');
    expect((screen.getByRole('button', { name: 'Nothing to claim' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
