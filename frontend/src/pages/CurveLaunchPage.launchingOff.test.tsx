// /curve-launch while launching is off (LC-4). The owner's rule: nothing may tell the
// public a Solana launch can be made before launching is switched on. The read-only view
// still mounts the heat door, so there the door shows the reading and says launching is
// not switched on. It never says the lane is open and never promises a signature.
// With writes on the door is unchanged: WARM opens the lane onto the create form.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CurveLaunchView, CurveWriteSection, type CurveLaunchViewProps } from './CurveLaunchPage';
import { CREATOR, fakeApi, openGate } from '../components/solana/curve/fakeWriteApi.fixture';
import type { WriteRpc } from '../components/solana/curve/ports';
import type { CurveSignerState } from '../components/solana/curve/useCurveSigner';
import type { SolanaRpc } from '../lib/launcher/solana/curve';
import { clearGateAudit } from '../lib/heat/gateAudit';
import { gateDecision, parseHeatReading } from '../lib/heat/heatOracle';

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

/** The read-only view. `gateBanner` set = writes are on for the site but their gate is not open. */
function readOnlyView(connected: boolean, gateBanner?: React.ReactNode, mint: CurveLaunchViewProps['mint'] = null) {
  return (
    <MemoryRouter>
      <CurveLaunchView
        probe={{ kind: 'deployed', executable: true }}
        snapshot={null}
        mint={mint}
        mintInput=""
        onMintInput={vi.fn()}
        onLookup={vi.fn()}
        loading={false}
        wallet={{ address: connected ? CREATOR.toBase58() : null, connecting: false, onConnect: vi.fn() }}
        gateBanner={gateBanner}
      />
    </MemoryRouter>
  );
}

/** Words that tell a visitor a launch can be made, or will be signed, from here. */
const SAYS_A_LAUNCH_CAN_BE_MADE =
  /lane is open|lane opens|lane stays open|can launch a token|will sign the launch|before anything is signed|the moment you launch/i;
/** The door saying that no launch can be made from this page right now. */
const SAYS_LAUNCHING_IS_OFF = /Launching here is not switched on yet\.|Launching is not open right now\./;

const door = () => screen.getByRole('region', { name: 'Who may plant' });
/** The "Open a launch" card. Only this view shows it. */
const checklist = () => screen.getByText('Open a launch').closest('section') as HTMLElement;
const pageText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

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

describe('/curve-launch, launching off (the read-only view): the door reads, and opens nothing', () => {
  for (const phase of PHASES) {
    it(`${phase}: nothing on the page says a launch can be made or signed`, async () => {
      await enter(phase, (c) => readOnlyView(c));
      expect(pageText()).not.toMatch(SAYS_A_LAUNCH_CAN_BE_MADE);
      // A read in flight has nothing to say yet; every other state ends on the sentence.
      if (phase !== 'reading') expect(door()).toHaveTextContent('Launching here is not switched on yet.');
    });
  }

  it('WARM keeps the reading: the state, and the degrees and tier in the oracle’s own words, minus the verdict', async () => {
    await enter('WARM', (c) => readOnlyView(c));
    expect(within(door()).getByText('WARM')).toBeInTheDocument();
    const said = within(door()).getByText(/95\.00°/).textContent ?? '';
    const withVerdict = gateDecision(CREATOR.toBase58(), reading(95, 'Resident'), Math.floor(Date.now() / 1000)).detail;
    expect(said).toContain('Resident');
    expect(withVerdict.startsWith(said), `"${said}" is not how the oracle says this reading`).toBe(true);
    expect(said).not.toBe(withVerdict);
  });

  it('writes on for the site but their gate not open: the door points at the note above instead', async () => {
    await enter('WARM', (c) => readOnlyView(c, <p>the status card</p>));
    expect(pageText()).not.toMatch(SAYS_A_LAUNCH_CAN_BE_MADE);
    expect(door()).toHaveTextContent('Launching is not open right now. The note above says why.');
    expect(door()).not.toHaveTextContent('not switched on yet');
    expect(checklist()).toHaveTextContent('Launching is not open right now. The note above says why.');
    expect(checklist()).not.toHaveTextContent('not switched on yet');
  });

  // The finding named this card as well: under the title "Open a launch" it ticks a looked-up
  // mint green, and it did not say that launching is off.
  it('the "Open a launch" card says launching is off, even with every mint check ticked', async () => {
    const ready = { kind: 'ok', value: { supply: 0n, decimals: 9, mintAuthority: 'creator', freezeAuthority: null, isLegacySplToken: true } } as const;
    await enter('no wallet', (c) => readOnlyView(c, undefined, ready));
    const marks = Array.from(checklist().querySelectorAll('li > span[aria-hidden="true"]'), (s) => s.textContent);
    expect(marks, 'the fixture mint should pass every check').toEqual(['✓', '✓', '✓', '✓']);
    expect(checklist()).toHaveTextContent('Launching here is not switched on yet.');
  });
});

describe('/curve-launch, launching on (the write section): the door is unchanged', () => {
  it('no wallet: asks for the wallet that will sign the launch', async () => {
    await enter('no wallet', writeSection);
    expect(door()).toHaveTextContent('Connect the Solana wallet that will sign the launch');
    expect(door()).toHaveTextContent('The lane opens for the connected wallet');
    expect(door()).not.toHaveTextContent(SAYS_LAUNCHING_IS_OFF);
  });

  it('WARM: says the lane is open, and the create form follows', async () => {
    await enter('WARM', writeSection);
    expect(door()).toHaveTextContent('This wallet reads 95.00° (Resident). The launch lane is open.');
    expect(door()).not.toHaveTextContent(SAYS_LAUNCHING_IS_OFF);
    expect(screen.getByTestId('launch-create-form')).toBeInTheDocument();
  });

  for (const phase of ['COLD', 'STALE'] as const) {
    it(`${phase}: no form, and no word about launching being off`, async () => {
      await enter(phase, writeSection);
      expect(door()).not.toHaveTextContent(SAYS_LAUNCHING_IS_OFF);
      expect(screen.queryByTestId('launch-create-form')).not.toBeInTheDocument();
    });
  }
});
