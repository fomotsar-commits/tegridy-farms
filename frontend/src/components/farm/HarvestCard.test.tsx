// The Harvest card on /earn: what it says before, during and after a run. The planning and
// the run order have their own tests (lib/harvest/*.test.ts); this is the screen.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { noteStakesChanged, useOnStakesChanged } from '../../lib/harvest/stakesChanged';
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
    batchable: { ethereum: false, base: false },
  },
  send: vi.fn(),
  together: vi.fn(),
  switchTo: vi.fn(),
  refetch: vi.fn(),
}));
const sol = vi.hoisted(() => ({ read: vi.fn(), together: vi.fn() }));

vi.mock('../../hooks/useEvmHarvest', () => ({
  useEvmHarvest: () => ({ ...evm.state, send: evm.send, together: evm.together, switchTo: evm.switchTo, refetch: evm.refetch }),
}));
// The Solana half's reads and claims; loaded by the card only once a Solana address is there.
vi.mock('../../lib/harvest/solana', () => ({
  readSolanaHarvest: sol.read,
  sendClaimsTogether: sol.together,
  signsAll: (s: { signAllTransactions?: unknown }) => (typeof s?.signAllTransactions === 'function' ? s : null),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn() } }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

import { HarvestCard } from './HarvestCard';

const claim = (id: string, chain: 'ethereum' | 'base', amount: bigint): EvmClaim => ({
  key: `evm:${id}`, chain, chainId: chain === 'base' ? 8453 : 1, pool: '0x0000000000000000000000000000000000000001',
  roomId: id, symbol: id.toUpperCase(), where: 'lighthouse pool', detail: null, amountRaw: amount, decimals: 18, caution: null,
});

const show = () => render(<MemoryRouter><HarvestCard /></MemoryRouter>);

const ONE_BY_ONE = { ethereum: false, base: false };

const solClaim = (key: string, send: SolanaClaim['send']): SolanaClaim => ({
  key, chain: 'solana', roomId: 'bayla', symbol: 'BAYLA', where: 'lighthouse pool', detail: 'on 1,000 BAYLA staked',
  amountRaw: 12_500_000n, decimals: 6, caution: null, send, build: vi.fn(), refused: vi.fn(),
});

beforeEach(() => {
  evm.state = { address: null, chain: null, plan: null, batchable: ONE_BY_ONE };
  evm.send.mockReset();
  evm.together.mockReset().mockReturnValue(null);
  sol.together.mockReset();
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
    evm.state = { address: '0xabc', chain: 'base', plan: null, batchable: ONE_BY_ONE };
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
        unread: [{ key: 'evm:jbm', chain: 'base', roomId: 'jbm', what: 'your JBM rewards', detail: 'The JBM pool did not answer.' }],
      },
      batchable: ONE_BY_ONE,
    };
    show();
    // A reason that ends its own sentence is not given a second full stop inside the brackets.
    expect(screen.getByText(/Could not read your JBM rewards/).textContent).toContain('(The JBM pool did not answer). Not a zero.');
    const list = screen.getByRole('list', { name: 'Ready to claim' });
    // Base first: the wallet is on Base, so it switches network once.
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent?.split('lighthouse')[0]?.trim())).toEqual(['1,500 QR', '3 PEPE']);
    expect(screen.getByText(/Could not read your JBM rewards/).textContent).toMatch(/Not a zero\./);
    expect(screen.getByRole('button', { name: 'Harvest all · 2 claims' })).toBeTruthy();
    // The Base claim, a switch to Ethereum, the Ethereum claim.
    expect(screen.getByText('Your wallet asks 3 times.')).toBeTruthy();
    // The venue speaks for every pool, not as one resident (e2e/voice-census.spec.ts), and a pool
    // page carries no prose em dash (BungalowFarmPanel.prose.test.tsx stubs this card).
    expect(document.body.textContent).not.toMatch(/TOWELI/);
    expect(document.body.textContent).not.toMatch(/—/);
  });

  it('a run marks each claim as it lands, links the transaction, and offers to check again', async () => {
    evm.state = { address: '0xabc', chain: 'base', plan: { claims: [claim('qr', 'base', 10n ** 18n), claim('pepe', 'ethereum', 10n ** 18n)], held: [], unread: [] }, batchable: ONE_BY_ONE };
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
    sol.read.mockResolvedValue({ claims: [solClaim('sf:1', send)], held: [], unread: [] });
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

  it('quiet (a pool page, a dashboard): nothing while reading or with nothing to claim; the card once there is a claim', () => {
    evm.state = { address: '0xabc', chain: 'base', plan: null, batchable: ONE_BY_ONE };
    const reading = render(<MemoryRouter><HarvestCard quiet /></MemoryRouter>);
    expect(reading.container.textContent).toBe('');
    reading.unmount();

    evm.state = { address: '0xabc', chain: 'base', plan: { claims: [], held: [], unread: [{ key: 'evm:jbm', chain: 'base', roomId: 'jbm', what: 'your JBM rewards', detail: 'x' }] }, batchable: ONE_BY_ONE };
    const nothing = render(<MemoryRouter><HarvestCard quiet /></MemoryRouter>);
    expect(nothing.container.textContent).toBe('');
    nothing.unmount();

    evm.state = { address: '0xabc', chain: 'base', plan: { claims: [claim('qr', 'base', 10n ** 18n)], held: [], unread: [] }, batchable: ONE_BY_ONE };
    render(<MemoryRouter><HarvestCard quiet headingLevel={3} /></MemoryRouter>);
    expect(screen.getByRole('heading', { level: 3, name: 'Harvest' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Harvest all · 1 claim' })).toBeTruthy();
  });

  it('a harvest tells the page, and a write elsewhere on the page makes it read again', async () => {
    evm.state = { address: '0xabc', chain: 'base', plan: { claims: [claim('qr', 'base', 10n ** 18n)], held: [], unread: [] }, batchable: ONE_BY_ONE };
    evm.send.mockResolvedValue({ kind: 'claimed', tx: '0xfeed' });
    const page = {};
    const heard = vi.fn();
    const listener = renderHook(() => useOnStakesChanged(page, heard));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Harvest all · 1 claim' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy());
    expect(heard).toHaveBeenCalledTimes(1);

    evm.refetch.mockClear();
    act(() => noteStakesChanged(page));
    expect(evm.refetch).toHaveBeenCalledTimes(1);
    listener.unmount();
  });

  it('a pool it leaves alone says why, and points to that pool’s page', () => {
    evm.state = {
      address: '0xabc',
      chain: 'ethereum',
      plan: { claims: [], held: [{ key: 'evm:pepe', chain: 'ethereum', roomId: 'pepe', symbol: 'PEPE', where: 'lighthouse pool', amountRaw: 10n ** 18n, decimals: 18, reason: 'Its reward vault is empty right now, so a claim would pay nothing. Nothing is lost: it stays owed.' }], unread: [] },
      batchable: ONE_BY_ONE,
    };
    show();
    expect(screen.getByText(/Its reward vault is empty right now/)).toBeTruthy();
    expect((screen.getByRole('link', { name: "The PEPE pool's page" }) as HTMLAnchorElement).getAttribute('href')).toBe('/earn/pepe');
    expect((screen.getByRole('button', { name: 'Nothing to claim' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a Solana wallet that signs several at once: one prompt for every Solana claim, and the claims’ own sends are never used', async () => {
    const signer = { name: 'the top bar’s wallet', publicKey: 'PK', signAllTransactions: vi.fn() };
    const send = vi.fn(async (): Promise<ClaimResult> => ({ kind: 'claimed', tx: 'ALONE' }));
    sol.read.mockResolvedValue({ claims: [solClaim('sf:1', send), solClaim('sf:2', send), solClaim('ladder:1', send)], held: [], unread: [] });
    sol.together.mockImplementation(async (cs: SolanaClaim[], _w: unknown, settle: (k: string, r: ClaimResult) => void) => {
      for (const c of cs) settle(c.key, { kind: 'claimed', tx: `SIG-${c.key}` });
      return 'done';
    });
    const owner = {};
    act(() => setSolanaSurface(owner, { open: () => {}, address: 'SoLAddr', connecting: false, signer }, true));
    try {
      show();
      fireEvent.click(await screen.findByRole('button', { name: 'Harvest all · 3 claims' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy());
      expect(sol.together).toHaveBeenCalledTimes(1);
      expect((sol.together.mock.calls[0]![0] as SolanaClaim[]).map((c) => c.key)).toEqual(['sf:1', 'sf:2', 'ladder:1']);
      expect(sol.together.mock.calls[0]![1]).toBe(signer);
      expect(send).not.toHaveBeenCalled();
      expect(screen.getByRole('status').textContent).toBe('Done: 3 claimed.');
    } finally {
      act(() => setSolanaSurface(owner, null));
    }
  });

  it('says how many times the wallet will ask before the press: once when it signs them together', async () => {
    const send = vi.fn(async (): Promise<ClaimResult> => ({ kind: 'claimed', tx: 'ALONE' }));
    sol.read.mockResolvedValue({ claims: [solClaim('sf:1', send), solClaim('sf:2', send)], held: [], unread: [] });
    const owner = {};
    act(() => setSolanaSurface(owner, { open: () => {}, address: 'SoLAddr', connecting: false, signer: { signAllTransactions: vi.fn() } }, true));
    try {
      show();
      await screen.findByRole('button', { name: 'Harvest all · 2 claims' });
      expect(screen.getByText('Your wallet asks once.')).toBeTruthy();
      // The same claims, with a wallet that signs one at a time.
      act(() => setSolanaSurface(owner, { open: () => {}, address: 'SoLAddr', connecting: false, signer: { signTransaction: vi.fn() } }, true));
      expect(screen.getByText('Your wallet asks 2 times.')).toBeTruthy();
    } finally {
      act(() => setSolanaSurface(owner, null));
    }
  });

  it('an EVM wallet that takes a batch on that chain: one prompt there, through the hook’s batch', async () => {
    evm.state = {
      address: '0xabc', chain: 'base',
      plan: { claims: [claim('qr', 'base', 10n ** 18n), claim('jbm', 'base', 2n * 10n ** 18n)], held: [], unread: [] },
      batchable: { ethereum: false, base: true },
    };
    const batch = vi.fn(async (cs: EvmClaim[], settle: (k: string, r: ClaimResult) => void) => {
      for (const c of cs) settle(c.key, { kind: 'claimed', tx: '0xfeed' });
      return 'done' as const;
    });
    evm.together.mockImplementation((ch: string) => (ch === 'base' ? batch : null));
    show();
    expect(screen.getByText('Your wallet asks once.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Harvest all · 2 claims' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy());
    expect(batch).toHaveBeenCalledTimes(1);
    expect(evm.send).not.toHaveBeenCalled();
    expect(evm.switchTo).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Done: 2 claimed.');
  });
});
