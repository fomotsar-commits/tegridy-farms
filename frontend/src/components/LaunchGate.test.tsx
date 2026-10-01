// The launch door on both rails. On Solana it reads the connected Solana wallet the page
// hands it, asks for no sign-message (the create signature proves the wallet), and shows
// the lane only while it is open. On Ethereum it keeps its words and its proof step.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { clearGateAudit } from '../lib/heat/gateAudit';
import { parseHeatReading } from '../lib/heat/heatOracle';

const SOL_A = 'EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK';
const SOL_B = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const EVM = '0x71be63f3384f5fb98995898a86b02fb2426c5788';

const h = vi.hoisted(() => ({
  evmAddress: undefined as string | undefined,
  fetchHeat: vi.fn(),
  signMessageAsync: vi.fn(async () => '0x'),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.evmAddress }),
  useSignMessage: () => ({ signMessageAsync: h.signMessageAsync }),
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

// The network boundary: the gate and the embedded card both read through it.
vi.mock('../lib/heat/heatClient', () => ({
  fetchHeat: (...args: unknown[]) => h.fetchHeat(...args),
  isSupportedHeatAddress: () => true,
  clearHeatCache: () => {},
  HeatUnavailableError: class HeatUnavailableError extends Error {},
}));

const { LaunchGate } = await import('./LaunchGate');

function reading(address: string, degrees: number, tier: string) {
  const now = Math.floor(Date.now() / 1000);
  return parseHeatReading({
    address,
    degrees,
    tier,
    is_cold: false,
    held_since_unix: now - 400 * 86_400,
    as_of_unix: now - 3_600,
    token_count: 1,
    breakdown: [],
  });
}

const LANE = 'the create form';

function solanaDoor(wallet: string | null) {
  return (
    <MemoryRouter>
      <LaunchGate rail="solana" wallet={wallet} connect={<button type="button">Connect Solana Wallet</button>}>
        <p>{LANE}</p>
      </LaunchGate>
    </MemoryRouter>
  );
}

const lane = () => screen.queryByText(LANE);

beforeEach(() => {
  clearGateAudit();
  h.evmAddress = undefined;
  h.fetchHeat.mockReset();
  h.signMessageAsync.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the door on the Solana rail', () => {
  it('with no wallet, asks for the Solana wallet that signs the launch, in the island words, and keeps the lane shut', () => {
    render(solanaDoor(null));
    const words = screen.getByText(/Connect the Solana wallet/).closest('p')?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(words).toContain('Connect the Solana wallet that will sign the launch, or read any address below.');
    expect(words).toContain('One person, every wallet. Link Ethereum and Base, link Solana, and the island reads you whole.');
    expect(words).not.toMatch(/Ethereum wallet that carries it|cannot yet be measured|—/);
    expect(screen.getByRole('button', { name: 'Connect Solana Wallet' })).toBeInTheDocument();
    expect(lane()).not.toBeInTheDocument();
    expect(h.fetchHeat).not.toHaveBeenCalled();
  });

  it('with no Solana wallet, the card never reads the Ethereum wallet as if it could launch here', async () => {
    h.evmAddress = EVM;
    h.fetchHeat.mockResolvedValue(reading(EVM, 195.54, 'Builder'));
    render(solanaDoor(null));
    await act(async () => {});
    expect(h.fetchHeat).not.toHaveBeenCalled();
    expect(screen.queryByText(/Can launch a token here/)).not.toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: /Wallet address to read Heat for/ });
    expect(field).toHaveValue('');
    // A pasted address still reads.
    h.fetchHeat.mockResolvedValue(reading(SOL_A, 95, 'Resident'));
    fireEvent.change(field, { target: { value: SOL_A } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read Heat' }));
    });
    expect(h.fetchHeat).toHaveBeenCalledWith(SOL_A, expect.anything());
  });

  it('WARM opens the lane for the connected Solana wallet, with no sign-message', async () => {
    h.fetchHeat.mockResolvedValue(reading(SOL_A, 95, 'Resident'));
    render(solanaDoor(SOL_A));
    await screen.findByText('WARM');
    expect(lane()).toBeInTheDocument();
    expect(h.fetchHeat).toHaveBeenCalledWith(SOL_A, expect.objectContaining({ fresh: true }));
    expect(screen.queryByRole('button', { name: /prove this wallet is yours/i })).not.toBeInTheDocument();
    expect(h.signMessageAsync).not.toHaveBeenCalled();
  });

  it('COLD keeps the lane shut', async () => {
    h.fetchHeat.mockResolvedValue(reading(SOL_A, 12, 'Observer'));
    render(solanaDoor(SOL_A));
    await screen.findByText('COLD');
    expect(lane()).not.toBeInTheDocument();
  });

  it('STALE (the island could not be read) keeps the lane shut', async () => {
    h.fetchHeat.mockRejectedValue(new Error('unreachable'));
    render(solanaDoor(SOL_A));
    await screen.findByText('STALE');
    expect(lane()).not.toBeInTheDocument();
  });

  it('dialled off, the lane is open whatever the reading, and the door says so', async () => {
    vi.stubEnv('VITE_HEAT_GATE', 'off');
    h.fetchHeat.mockResolvedValue(reading(SOL_A, 12, 'Observer'));
    render(solanaDoor(SOL_A));
    await screen.findByText('COLD');
    expect(lane()).toBeInTheDocument();
    expect(screen.getByText(/Denial is currently dialled off/)).toBeInTheDocument();
  });

  it("a new wallet never inherits the last wallet's verdict, not even for one render", async () => {
    const rendered: string[] = [];
    function Lane({ wallet }: { wallet: string }) {
      rendered.push(wallet);
      return <p>{LANE}</p>;
    }
    const door = (wallet: string) => (
      <MemoryRouter>
        <LaunchGate rail="solana" wallet={wallet}>
          <Lane wallet={wallet} />
        </LaunchGate>
      </MemoryRouter>
    );
    h.fetchHeat.mockResolvedValueOnce(reading(SOL_A, 95, 'Resident'));
    const view = render(door(SOL_A));
    await screen.findByText('WARM');
    expect(lane()).toBeInTheDocument();
    h.fetchHeat.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      view.rerender(door(SOL_B));
    });
    expect(lane()).not.toBeInTheDocument();
    expect(rendered).toContain(SOL_A);
    expect(rendered, 'the lane rendered for a wallet the door has not read').not.toContain(SOL_B);
    expect(h.fetchHeat).toHaveBeenLastCalledWith(SOL_B, expect.anything());
  });
});

describe('the door on the Ethereum rail', () => {
  it('with no wallet, keeps its own connect line and no Solana sentence', () => {
    render(
      <MemoryRouter>
        <LaunchGate rail="ethereum" />
      </MemoryRouter>,
    );
    const words = screen.getByText(/Connect the Ethereum wallet/).closest('p')?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(words).toContain('Connect the Ethereum wallet that carries it, or read any address below.');
    expect(words).not.toContain('One person, every wallet.');
    expect(screen.getByText('A reading is not a key. The lane opens for a wallet that signs.')).toBeInTheDocument();
  });

  it('WARM still asks the wagmi wallet to prove itself before the lane opens', async () => {
    h.evmAddress = EVM;
    h.fetchHeat.mockResolvedValue(reading(EVM, 195.54, 'Builder'));
    render(
      <MemoryRouter>
        <LaunchGate rail="ethereum">
          <p>{LANE}</p>
        </LaunchGate>
      </MemoryRouter>,
    );
    await screen.findByText('WARM');
    expect(lane()).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Prove this wallet is yours' }));
    });
    expect(h.signMessageAsync).toHaveBeenCalledTimes(1);
    expect(lane()).toBeInTheDocument();
  });
});
