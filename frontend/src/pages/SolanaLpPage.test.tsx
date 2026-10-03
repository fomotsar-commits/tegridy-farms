import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// /solana-lp: the same live venue read as /pools decides whether the LP section mounts.
// The section is stubbed here; SolanaLpPage.mintLink.test.tsx mounts the real one.
const readVenue = vi.fn();
vi.mock('../lib/solana/cpswap/read', () => ({ readVenue: (...a: unknown[]) => readVenue(...a) }));
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}) }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
vi.mock('../components/solana/lp/SolanaLpSection', () => ({ default: () => <div data-testid="lp-section" /> }));
const lp = vi.hoisted(() => ({ mode: 'on' as 'off' | 'on' | 'withdraw-only' }));
vi.mock('../lib/launcher/solana/lpWriteFlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/launcher/solana/lpWriteFlag')>()),
  lpWriteMode: () => lp.mode,
}));

const PROGRAM = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
const LIVE = {
  kind: 'live',
  programId: PROGRAM,
  config: {
    address: 'CfG1111111111111111111111111111111111111111',
    index: 0, disableCreatePool: false,
    tradeFeeRate: 2500n, protocolFeeRate: 120_000n, fundFeeRate: 0n,
    createPoolFee: 0n, creatorFeeRate: 0n,
    protocolOwner: 'Own1', fundOwner: 'Own2',
  },
} as const;

async function mount(path = '/solana-lp') {
  vi.resetModules();
  const { default: SolanaLpPage } = await import('./SolanaLpPage');
  return render(<MemoryRouter initialEntries={[path]}><SolanaLpPage /></MemoryRouter>);
}

const settled = () => waitFor(() => expect(screen.queryByText(/Reading the venue/i)).not.toBeInTheDocument());

beforeEach(() => { vi.clearAllMocks(); lp.mode = 'on'; });

describe('when the venue reads live', () => {
  beforeEach(() => { readVenue.mockResolvedValue(LIVE); });

  it('mounts the LP section under the live status card', async () => {
    await mount();
    expect(await screen.findByTestId('lp-section')).toBeInTheDocument();
    expect(screen.getByText(/Pools are open/i)).toBeInTheDocument();
  });

  it('heads the page Solana liquidity and says what can be done here, by LP mode', async () => {
    await mount();
    await screen.findByTestId('lp-section');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Solana liquidity.');
    expect(document.title).toMatch(/^Solana liquidity/);
    expect(screen.getByText(/^Find a pool, add or remove liquidity, or open a new pool on the venue.s own Solana AMM\.$/)).toBeInTheDocument();
  });

  it("'withdraw-only' and 'off' never say adding is open", async () => {
    lp.mode = 'withdraw-only';
    const first = await mount();
    await screen.findByTestId('lp-section');
    expect(screen.getByText(/take your liquidity out.*Adding liquidity and opening pools from here are paused\./)).toBeInTheDocument();
    expect(screen.queryByText(/add or remove liquidity, or open/)).toBeNull();
    first.unmount();
    lp.mode = 'off';
    await mount();
    await screen.findByTestId('lp-section');
    expect(screen.getByText(/Adding and removing liquidity from here is not switched on yet\./)).toBeInTheDocument();
    expect(screen.queryByText(/add or remove liquidity, or open/)).toBeNull();
  });
});

describe('when the venue does not read live', () => {
  it.each([
    [{ kind: 'no-program-id' }, /has no program id to read/i],
    [{ kind: 'no-config', programId: PROGRAM }, /one instruction from open/i],
    [{ kind: 'program', deployment: { kind: 'closed' } }, /That program id is closed/i],
    [{ kind: 'unreadable', detail: 'proxy timed out' }, /The chain could not be read/i],
  ])('%o: the status card says so, and no LP section', async (status, title) => {
    readVenue.mockResolvedValue(status);
    await mount();
    await waitFor(() => expect(screen.getByText(title)).toBeInTheDocument());
    expect(screen.queryByTestId('lp-section')).toBeNull();
    // No present-tense claim above a card that says the venue is not open.
    expect(screen.queryByText(/^Find a pool/)).toBeNull();
    expect(screen.getByText(/once a chain read says the venue is open/i)).toBeInTheDocument();
  });

  it('while the first read is in flight: reading, and no LP section', async () => {
    readVenue.mockReturnValue(new Promise(() => {}));
    await mount();
    await waitFor(() => expect(screen.getByText(/Reading the venue/i)).toBeInTheDocument());
    expect(screen.queryByTestId('lp-section')).toBeNull();
  });

  it('Refresh reads again, and the section mounts once the venue reads live', async () => {
    readVenue.mockResolvedValueOnce({ kind: 'unreadable', detail: 'proxy timed out' }).mockResolvedValueOnce(LIVE);
    await mount();
    await settled();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect(await screen.findByTestId('lp-section')).toBeInTheDocument();
    expect(readVenue).toHaveBeenCalledTimes(2);
  });
});

describe('always', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'unreadable', detail: 'proxy timed out' }); });

  it('links to the Venue AMM tab for fees, status and how the pools work', async () => {
    await mount();
    await settled();
    expect(screen.getByRole('link', { name: /fees, status and how the pools work/i })).toHaveAttribute('href', '/pools');
  });
});
