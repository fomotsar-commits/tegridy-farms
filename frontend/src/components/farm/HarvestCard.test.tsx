// The Harvest card on /earn: what it says before, during and after a run. The planning and
// the run order have their own tests (lib/harvest/*.test.ts); this is the screen.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { EvmClaim } from '../../lib/harvest/evm';
import type { SolanaClaim } from '../../lib/harvest/solana';
import type { ClaimResult, HarvestPlan } from '../../lib/harvest/types';
import { resetSolanaSurfaceForTests, setSolanaSurface } from '../../lib/solanaSurface';

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
const sol = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('../../hooks/useEvmHarvest', () => ({
  useEvmHarvest: () => ({ ...evm.state, send: evm.send, switchTo: evm.switchTo, refetch: evm.refetch }),
}));
// The Solana half's reads and claims; loaded by the card only once a Solana address is there.
vi.mock('../../lib/harvest/solana', () => ({ readSolanaHarvest: sol.read }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn() } }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

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
  sol.read.mockReset();
  resetSolanaSurfaceForTests();
});

describe('Harvest card', () => {
  it('with no wallet connected it draws nothing: the top bar is the way in', () => {
    const { container } = show();
    expect(container.textContent).toBe('');
    expect(sol.read).not.toHaveBeenCalled();
  });

  it('while reading: the button waits and promises nothing, and the money line is in view', () => {
    evm.state = { address: '0xabc', chain: 'base', plan: null };
    show();
    expect(screen.getByRole('heading', { name: 'Harvest' })).toBeTruthy();
    expect(screen.getByText(/The venue takes nothing; you pay the network fees\./)).toBeTruthy();
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
    // The venue speaks for every pool, not as one resident (e2e/voice-census.spec.ts).
    expect(document.body.textContent).not.toMatch(/TOWELI/);
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

  it('a Solana wallet is the page’s one connection: read at its address, claimed with its signer', async () => {
    const signer = { name: 'the top bar’s wallet' };
    const send = vi.fn(async (): Promise<ClaimResult> => ({ kind: 'claimed', tx: 'SIG' }));
    const sc: SolanaClaim = {
      key: 'sf:1', chain: 'solana', roomId: 'bayla', symbol: 'BAYLA', where: 'lighthouse pool', detail: 'on 1,000 BAYLA staked',
      amountRaw: 12_500_000n, decimals: 6, caution: null, send,
    };
    sol.read.mockResolvedValue({ claims: [sc], held: [], unread: [] });
    // The top bar's own connection on the Earn list (`own`): reset does not withdraw it, so this test does.
    const owner = {};
    act(() => setSolanaSurface(owner, { open: () => {}, address: 'SoLAddr', connecting: false, signer }, true));
    try {
      show();
      // Its code loads on demand, so the read starts a moment after the card draws.
      await waitFor(() => expect(sol.read).toHaveBeenCalledWith('SoLAddr'));
      fireEvent.click(await screen.findByRole('button', { name: 'Harvest all · 1 claim' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy());
      expect(send).toHaveBeenCalledWith(signer);
      expect((screen.getByRole('link', { name: /Claimed: view the transaction/ }) as HTMLAnchorElement).href).toBe('https://solscan.io/tx/SIG');
    } finally {
      act(() => setSolanaSurface(owner, null));
    }
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
