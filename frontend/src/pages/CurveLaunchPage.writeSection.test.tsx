// Write mode on /curve-launch: opening a launch by address and the recent list are open
// to anyone, and only the create form is behind the heat door, which reads the connected
// Solana wallet. (The form's own call at submit is in LaunchCreateForm.heatGate.test.tsx.)

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CurveWriteSection } from './CurveLaunchPage';
import { CREATOR, fakeApi, openGate } from '../components/solana/curve/fakeWriteApi.fixture';
import type { WriteRpc } from '../components/solana/curve/ports';
import type { CurveSignerState } from '../components/solana/curve/useCurveSigner';
import type { SolanaRpc } from '../lib/launcher/solana/curve';
import { clearGateAudit } from '../lib/heat/gateAudit';
import { parseHeatReading } from '../lib/heat/heatOracle';

const h = vi.hoisted(() => ({ fetchHeat: vi.fn() }));

// The door's embedded HeatCard calls wagmi's useAccount; no EVM wallet is connected here.
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x' }),
}));
vi.mock('../components/solana/SolanaConnectButton', () => ({
  SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button>,
}));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('../lib/heat/heatClient', () => ({
  fetchHeat: (...args: unknown[]) => h.fetchHeat(...args),
  isSupportedHeatAddress: () => true,
  clearHeatCache: () => {},
  HeatUnavailableError: class HeatUnavailableError extends Error {},
}));

const rpc: SolanaRpc = vi.fn(async () => ({ value: null }));
const curveRpc = { getAccountInfo: vi.fn(async () => null), getMinimumBalanceForRentExemption: vi.fn(async () => 0) };

const ready: CurveSignerState = {
  kind: 'ready',
  address: CREATOR.toBase58(),
  signer: { publicKey: CREATOR, signTransaction: async (t) => t },
  signMessage: null,
};

function reading(degrees: number, tier: string) {
  const now = Math.floor(Date.now() / 1000);
  return parseHeatReading({
    address: CREATOR.toBase58(),
    degrees,
    tier,
    is_cold: false,
    held_since_unix: now - 400 * 86_400,
    as_of_unix: now - 3_600,
    token_count: 1,
    breakdown: [],
  });
}

function renderSection(connected: boolean) {
  render(
    <MemoryRouter>
      <CurveWriteSection
        api={fakeApi()}
        gate={openGate()}
        writeRpc={{} as WriteRpc}
        rpc={rpc}
        curveRpc={curveRpc}
        signerState={connected ? ready : { kind: 'disconnected', connecting: false }}
        wallet={connected ? CREATOR : null}
      />
    </MemoryRouter>,
  );
}

const door = () => screen.getByRole('region', { name: 'Who may plant' });
const createForm = () => screen.queryByTestId('launch-create-form');

/** Anyone can open a launch by its address and read the list, whatever the door says. */
function expectOpenToAnyone() {
  expect(screen.getByText('Open a launch by its address')).toBeInTheDocument();
  expect(screen.getByTestId('launch-list')).toBeInTheDocument();
}

beforeEach(() => {
  clearGateAudit();
  h.fetchHeat.mockReset();
});

describe('/curve-launch write mode: only the create form is behind the door', () => {
  it('no Solana wallet: the door offers the connect button, and there is no create form', () => {
    renderSection(false);
    expect(door()).toHaveTextContent('Connect the Solana wallet that will sign the launch');
    expect(door()).not.toHaveTextContent('Ethereum wallet that carries it');
    expect(screen.getByRole('button', { name: 'Connect Solana Wallet' })).toBeInTheDocument();
    expect(createForm()).not.toBeInTheDocument();
    expectOpenToAnyone();
    expect(h.fetchHeat).not.toHaveBeenCalled();
  });

  it('a cold maker: no create form, and the rest stays open', async () => {
    h.fetchHeat.mockResolvedValue(reading(12, 'Observer'));
    renderSection(true);
    await screen.findByText('COLD');
    expect(createForm()).not.toBeInTheDocument();
    expectOpenToAnyone();
  });

  it('an island that cannot be read: no create form', async () => {
    h.fetchHeat.mockRejectedValue(new Error('unreachable'));
    renderSection(true);
    await screen.findByText('STALE');
    expect(createForm()).not.toBeInTheDocument();
    expectOpenToAnyone();
  });

  it('a warm maker: the create form opens under the door, for the connected Solana wallet', async () => {
    h.fetchHeat.mockResolvedValue(reading(95, 'Resident'));
    renderSection(true);
    await screen.findByText('WARM');
    expect(createForm()).toBeInTheDocument();
    expect(h.fetchHeat).toHaveBeenCalledWith(CREATOR.toBase58(), expect.objectContaining({ fresh: true }));
    expectOpenToAnyone();
  });
});
