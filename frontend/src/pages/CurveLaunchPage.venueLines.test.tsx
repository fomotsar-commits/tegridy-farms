// /curve-launch says, under its door and in every state of it, that a plant is 100,000
// $BAYLA, half burned, and that this is a venue launch (island answer 16, rulings 1 and 2).
// Both paths: the read-only view (writes off) and the write section (writes on), where
// the form follows the lines. And no Solana launch surface calls itself an island coin.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CurveLaunchView, CurveWriteSection } from './CurveLaunchPage';
import { CREATOR, fakeApi, openGate } from '../components/solana/curve/fakeWriteApi.fixture';
import type { WriteRpc } from '../components/solana/curve/ports';
import type { CurveSignerState } from '../components/solana/curve/useCurveSigner';
import type { SolanaRpc } from '../lib/launcher/solana/curve';
import { PLANT_LINE, VENUE_LINE } from '../components/launcher/venueLaunchCopy';
import { clearGateAudit } from '../lib/heat/gateAudit';
import { parseHeatReading } from '../lib/heat/heatOracle';

const h = vi.hoisted(() => ({ fetchHeat: vi.fn() }));

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

function writeSection(connected: boolean) {
  return (
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
    </MemoryRouter>
  );
}

function readOnlyView(connected: boolean) {
  return (
    <MemoryRouter>
      <CurveLaunchView
        probe={{ kind: 'deployed', executable: true }}
        snapshot={null}
        mint={null}
        mintInput=""
        onMintInput={vi.fn()}
        onLookup={vi.fn()}
        loading={false}
        wallet={{ address: connected ? CREATOR.toBase58() : null, connecting: false, onConnect: vi.fn() }}
      />
    </MemoryRouter>
  );
}

/** The two lines, exactly, in order, as the very next thing after the door. */
function expectLinesUnderTheDoor() {
  const door = screen.getByRole('region', { name: 'Who may plant' });
  const lines = screen.getByTestId('venue-launch-lines');
  expect(door.nextElementSibling).toBe(lines);
  expect(Array.from(lines.querySelectorAll('p')).map((p) => p.textContent)).toEqual([PLANT_LINE, VENUE_LINE]);
  return lines;
}

/** Ruling 1(c): these are venue launches. Scoped to the page under test, not the whole site. */
function expectNoIslandCoinWords() {
  const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
  expect(text).not.toMatch(/island coin|born in \$?BAYLA/i);
  expect(text).toContain(VENUE_LINE);
}

type Phase = 'no wallet' | 'reading' | 'COLD' | 'STALE' | 'WARM';
const PHASES: Phase[] = ['no wallet', 'reading', 'COLD', 'STALE', 'WARM'];

async function enter(phase: Phase, tree: (connected: boolean) => React.ReactElement) {
  if (phase === 'no wallet') {
    render(tree(false));
    return;
  }
  if (phase === 'reading') h.fetchHeat.mockReturnValue(new Promise(() => {}));
  if (phase === 'COLD') h.fetchHeat.mockResolvedValue(reading(12, 'Observer'));
  if (phase === 'STALE') h.fetchHeat.mockRejectedValue(new Error('unreachable'));
  if (phase === 'WARM') h.fetchHeat.mockResolvedValue(reading(95, 'Resident'));
  render(tree(true));
  await screen.findByText(phase === 'reading' ? /against the island.s instrument/ : phase);
}

beforeEach(() => {
  clearGateAudit();
  h.fetchHeat.mockReset();
});

describe('/curve-launch, writes on: door, then the plant line, then the venue line, then the form', () => {
  for (const phase of PHASES) {
    it(phase, async () => {
      await enter(phase, writeSection);
      const lines = expectLinesUnderTheDoor();
      if (phase === 'WARM') {
        expect(lines.nextElementSibling, 'the form comes straight after the lines').toBe(screen.getByTestId('launch-create-form'));
      } else {
        expect(screen.queryByTestId('launch-create-form')).not.toBeInTheDocument();
      }
      expectNoIslandCoinWords();
    });
  }
});

describe('/curve-launch, writes off (the read-only view): the same lines under the same door', () => {
  for (const phase of PHASES) {
    it(phase, async () => {
      await enter(phase, readOnlyView);
      expectLinesUnderTheDoor();
      expectNoIslandCoinWords();
    });
  }
});
