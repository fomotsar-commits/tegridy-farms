import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CurveLaunchView, type CurveLaunchViewProps } from './CurveLaunchPage';
import type { AccountRead, BondingCurveState, GlobalConfigState, ProgramProbe } from '../lib/launcher/solana/curve';
import type { LaunchSnapshot, MintFacts } from '../lib/launcher/solana/curveClient';

// The page's I/O sits in the default export; `CurveLaunchView` is the
// presentational seam, so every phase can be driven directly without a wallet
// provider or an RPC. Mirrors the mocking style of LaunchTokenPage.test.tsx.
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

const SOL = 1_000_000_000n;

function curve(over: Partial<BondingCurveState> = {}): BondingCurveState {
  return {
    mint: new Uint8Array(32).fill(1),
    creator: new Uint8Array(32).fill(2),
    virtualSolReserves: 30n * SOL,
    virtualTokenReserves: 1_073_000_000_000_000n,
    realSolReserves: 0n,
    realTokenReserves: 1_000_000_000_000_000n,
    tradeFeeBps: 100n,
    graduationTargetLamports: 85n * SOL,
    migrationReserveLamports: 1n * SOL,
    complete: false,
    pool: new Uint8Array(32),
    bump: 255,
    ...over,
  };
}

function globalCfg(over: Partial<GlobalConfigState> = {}): GlobalConfigState {
  return {
    authority: new Uint8Array(32).fill(3),
    feeRecipient: new Uint8Array(32).fill(4),
    tradeFeeBps: 100n,
    initialVirtualSol: 30n * SOL,
    initialVirtualToken: 1_073_000_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    graduationTargetLamports: 85n * SOL,
    migrationReserveLamports: 1n * SOL,
    cpSwapProgram: new Uint8Array(32).fill(5),
    ammConfig: new Uint8Array(32).fill(6),
    paused: false,
    bump: 254,
    ...over,
  };
}

function snapshot(
  g: AccountRead<GlobalConfigState>,
  c: AccountRead<BondingCurveState>,
  over: Partial<LaunchSnapshot> = {},
): LaunchSnapshot {
  return {
    global: g,
    curve: c,
    curveAccountLamports: null,
    curveRentExemptLamports: null,
    pdas: { global: 'G', curve: 'C', vault: 'V', migrationAuthority: 'M', pool: 'P' },
    ...over,
  };
}

const mintFacts = (over: Partial<MintFacts> = {}): AccountRead<MintFacts> => ({
  status: 'present',
  value: { supply: 0n, decimals: 9, mintAuthority: 'creator', freezeAuthority: null, isLegacySplToken: true, ...over },
});

function renderView(over: Partial<CurveLaunchViewProps> = {}) {
  const props: CurveLaunchViewProps = {
    probe: { status: 'not-deployed' },
    snapshot: null,
    mint: null,
    mintInput: '',
    onMintInput: vi.fn(),
    onLookup: vi.fn(),
    loading: false,
    ...over,
  };
  return {
    ...render(
      <MemoryRouter>
        <CurveLaunchView {...props} />
      </MemoryRouter>,
    ),
    props,
  };
}

// ---------------------------------------------------------------------------
// The deployment gate
// ---------------------------------------------------------------------------

describe('deployment honesty', () => {
  it('says NOT DEPLOYED, from a read, and offers no lookup', () => {
    renderView({ probe: { status: 'not-deployed' } });
    expect(screen.getByText('NOT DEPLOYED')).toBeInTheDocument();
    expect(screen.getByText(/no program at this address/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Token mint address')).toBeDisabled();
    expect(screen.getByRole('button', { name: /look up/i })).toBeDisabled();
  });

  it('does not claim a read FAILED when no lookup has been attempted', () => {
    // A fourth state alongside present/absent/unreadable: not asked. On first
    // load nothing has been looked up, and saying "the read failed" there is a
    // claim about a call that was never made.
    renderView({ probe: { status: 'not-deployed' }, snapshot: null, mint: null });
    expect(screen.getByText(/no launch has been looked up yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no mint looked up, so none of the above has been checked yet/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing has been read yet, so the terms are not known/i)).toBeInTheDocument();
    expect(screen.queryByText(/read failed\./i)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be read/i)).not.toBeInTheDocument();
  });

  it('shows CHECKING rather than a verdict while the probe is in flight', () => {
    // A pending read must never render as either answer.
    renderView({ probe: null });
    expect(screen.getByText('CHECKING')).toBeInTheDocument();
    expect(screen.queryByText('NOT DEPLOYED')).not.toBeInTheDocument();
    expect(screen.queryByText('DEPLOYED')).not.toBeInTheDocument();
  });

  it('renders a failed probe as READ FAILED — never as "not deployed"', () => {
    // The defect class: an RPC error rendering as a clean negative finding.
    renderView({ probe: { status: 'unreadable', reason: 'HTTP 503 from proxy' } });
    expect(screen.getByText('READ FAILED')).toBeInTheDocument();
    // The reason is surfaced by both the banner and the curve card, because the
    // probe failure propagates into the phase. Redundant, not contradictory.
    expect(screen.getAllByText(/HTTP 503 from proxy/).length).toBeGreaterThan(0);
    expect(screen.getByText(/says nothing about whether the program is live/i)).toBeInTheDocument();
    expect(screen.queryByText('NOT DEPLOYED')).not.toBeInTheDocument();
  });

  it('enables lookup only once a program was actually found', () => {
    renderView({ probe: { status: 'deployed' }, mintInput: 'So11111111111111111111111111111111111111112' });
    expect(screen.getByLabelText('Token mint address')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /look up/i })).not.toBeDisabled();
  });

  it('withholds lookup for an address that is not plausibly base58', () => {
    renderView({ probe: { status: 'deployed' }, mintInput: 'not-an-address!!' });
    expect(screen.getByRole('button', { name: /look up/i })).toBeDisabled();
    expect(screen.getByText(/does not look like a base58/i)).toBeInTheDocument();
  });

  it('never fabricates a market: no USD figure, no volume window, no holder count', () => {
    renderView({
      probe: { status: 'deployed' },
      snapshot: snapshot({ status: 'present', value: globalCfg() }, { status: 'present', value: curve() }),
      mint: mintFacts(),
    });
    const body = document.body.textContent ?? '';
    // Deliberately matches rendered VALUES, not the copy that names these as
    // things we do not have — the explainer legitimately says the words.
    expect(body).not.toMatch(/\$\s?\d/); // any dollar figure
    expect(body).not.toMatch(/\d+\s*(holders|traders|buys|txns)\b/i);
    expect(body).not.toMatch(/24\s?h|\bvolume:/i);
    // And no metric is presented as a labelled row.
    for (const label of [/^Market cap$/i, /^Holders$/i, /^Volume$/i, /^FDV$/i, /^Price \(USD\)$/i]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });
});

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

describe('phase rendering', () => {
  const g: AccountRead<GlobalConfigState> = { status: 'present', value: globalCfg() };
  const deployed: ProgramProbe = { status: 'deployed' };

  it('says "protocol not initialised" when global is missing', () => {
    renderView({ probe: deployed, snapshot: snapshot({ status: 'absent' }, { status: 'absent' }) });
    expect(screen.getByText(/protocol not initialised/i)).toBeInTheDocument();
    expect(screen.queryByText(/no curve for this mint/i)).not.toBeInTheDocument();
  });

  it('says "no curve for this mint" when only the curve is missing', () => {
    renderView({ probe: deployed, snapshot: snapshot(g, { status: 'absent' }) });
    expect(screen.getByText(/no curve for this mint/i)).toBeInTheDocument();
    expect(screen.queryByText(/protocol not initialised/i)).not.toBeInTheDocument();
  });

  it('renders an absent curve as blank, NOT as 0 SOL raised', () => {
    renderView({ probe: deployed, snapshot: snapshot(g, { status: 'absent' }) });
    expect(screen.getByText(/deliberately blank rather than zeroed/i)).toBeInTheDocument();
    expect(screen.queryByText(/SOL raised/i)).not.toBeInTheDocument();
  });

  it('renders an unreadable curve as a read failure, not as an empty launch', () => {
    renderView({ probe: deployed, snapshot: snapshot(g, { status: 'unreadable', reason: 'decode failed' }) });
    expect(screen.getByText(/couldn't read/i)).toBeInTheDocument();
    expect(screen.getByText(/decode failed/)).toBeInTheDocument();
    expect(screen.queryByText(/SOL raised/i)).not.toBeInTheDocument();
  });

  // 6019 vs 6005. An earlier program version conflated them, telling callers a
  // curve had moved to an AMM pool when it had not — so these two states must
  // never render the same words. Split across two renders so neither can be
  // satisfied by leftover DOM from the other.
  it('renders a fully funded curve as AWAITING MIGRATION, explicitly not graduated', () => {
    renderView({
      probe: deployed,
      snapshot: snapshot(g, { status: 'present', value: curve({ realSolReserves: 86n * SOL }) }),
    });
    expect(screen.getByText(/fully funded — awaiting migration/i)).toBeInTheDocument();
    // Said by BOTH the phase card and the blocked-buy reason — the two surfaces
    // a user reads must not disagree about which state this is.
    expect(screen.getAllByText(/has NOT graduated yet/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/liquidity has moved to the AMM pool/i)).not.toBeInTheDocument();
  });

  it('renders a completed curve as GRADUATED', () => {
    renderView({ probe: deployed, snapshot: snapshot(g, { status: 'present', value: curve({ complete: true }) }) });
    expect(screen.getByText('Graduated')).toBeInTheDocument();
    expect(screen.getByText(/liquidity has moved to the AMM pool/i)).toBeInTheDocument();
    expect(screen.queryByText(/awaiting migration/i)).not.toBeInTheDocument();
  });

  it('shows progress against target + reserve, not the target alone', () => {
    // Sitting exactly on the 85 SOL target with a 1 SOL reserve is 98.84%, not
    // 100% — buys still succeed up to the ceiling.
    renderView({
      probe: deployed,
      snapshot: snapshot(g, { status: 'present', value: curve({ realSolReserves: 85n * SOL }) }),
    });
    expect(screen.getByText('98.84%')).toBeInTheDocument();
    expect(screen.getByText(/graduation target plus\s+the migration reserve/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Pause semantics
// ---------------------------------------------------------------------------

describe('pause', () => {
  it('halts buys but keeps SELL usable — sells are unpausable on chain', () => {
    renderView({
      probe: { status: 'deployed' },
      snapshot: snapshot(
        { status: 'present', value: globalCfg({ paused: true }) },
        { status: 'present', value: curve() },
      ),
      mint: mintFacts(),
    });
    expect(screen.getByText(/BUYS PAUSED · SELLS OPEN/)).toBeInTheDocument();
    // Buy side is blocked...
    expect(screen.getByText(/Buys are paused\. Selling is still open/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Amount of SOL to spend/i)).toBeDisabled();

    // ...but switching to sell must NOT be greyed out.
    fireEvent.click(screen.getByRole('button', { name: /^sell$/i }));
    expect(screen.getByLabelText(/Amount of tokens to sell/i)).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

describe('trade quote', () => {
  const deployedCurve = (over: Partial<BondingCurveState> = {}) => ({
    probe: { status: 'deployed' } as ProgramProbe,
    snapshot: snapshot({ status: 'present', value: globalCfg() }, { status: 'present', value: curve(over) }),
    mint: mintFacts(),
  });

  it('quotes a buy before anything is signed, with a minimum received', () => {
    renderView(deployedCurve());
    fireEvent.change(screen.getByLabelText(/Amount of SOL to spend/i), { target: { value: '1' } });
    expect(screen.getByText('You pay')).toBeInTheDocument();
    // 1 SOL at 1% → 0.01 SOL fee, and the tokens the program's own formula gives.
    expect(screen.getByText('0.01 SOL')).toBeInTheDocument();
    expect(screen.getByText('Minimum received')).toBeInTheDocument();
  });

  it('shows the CAPPED debit on the last buy, not the amount entered', () => {
    // `max_lamports_in` is a ceiling, not a spend — a UI that echoes it back is
    // wrong on the last buy of every launch.
    renderView(deployedCurve({ realSolReserves: 86n * SOL - 1n }));
    fireEvent.change(screen.getByLabelText(/Amount of SOL to spend/i), { target: { value: '500' } });
    expect(screen.getByText(/Capped at the graduation line/i)).toBeInTheDocument();
    expect(screen.getByText(/remainder is never taken and never leaves your wallet/i)).toBeInTheDocument();
    // The entered 500 SOL must not be presented as the debit.
    expect(screen.queryByText('500 SOL')).not.toBeInTheDocument();
  });

  it('refuses to quote a buy on a fully funded curve, and says which state it is in', () => {
    renderView(deployedCurve({ realSolReserves: 86n * SOL }));
    expect(screen.getByText(/Fully funded and waiting on migration\. It has NOT graduated yet/i)).toBeInTheDocument();
  });

  it('labels the sell input as base units when the mint decimals were not read', () => {
    // Never assume 9 — decimals are not on the curve and not constrained by the
    // program.
    renderView({ ...deployedCurve(), mint: { status: 'unreadable', reason: 'mint read failed' } });
    fireEvent.click(screen.getByRole('button', { name: /^sell$/i }));
    expect(screen.getByLabelText(/Amount of tokens to sell/i)).toBeInTheDocument();
    expect(screen.getByText(/decimals could not be read, so this is in raw base units/i)).toBeInTheDocument();
  });

  it('surfaces a rejected quote as the program\'s own reason', () => {
    renderView(deployedCurve({ realSolReserves: 1n, realTokenReserves: 1_000n }));
    fireEvent.change(screen.getByLabelText(/Amount of SOL to spend/i), { target: { value: '50' } });
    expect(screen.getByText(/cannot fill a trade this size/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// No write path
// ---------------------------------------------------------------------------

describe('write path', () => {
  it('builds no transaction and offers no submit while there is no write client', () => {
    renderView({
      probe: { status: 'deployed' },
      snapshot: snapshot({ status: 'present', value: globalCfg() }, { status: 'present', value: curve() }),
      mint: mintFacts(),
      writeClient: null,
    });
    expect(screen.getByText(/no signing path on this page/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review buy/i })).not.toBeInTheDocument();
    // Nothing anywhere invites a signature.
    for (const b of screen.getAllByRole('button')) {
      expect(b.textContent ?? '').not.toMatch(/confirm|sign|submit|send transaction/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Create checklist
// ---------------------------------------------------------------------------

describe('create checklist', () => {
  it('checks the mint requirements the program actually enforces', () => {
    renderView({
      probe: { status: 'deployed' },
      snapshot: snapshot({ status: 'present', value: globalCfg() }, { status: 'absent' }),
      mint: mintFacts({ freezeAuthority: 'someone' }),
    });
    const card = screen.getByText('Open a launch').closest('section') as HTMLElement;
    expect(within(card).getByText(/No freeze authority/i)).toBeInTheDocument();
    expect(within(card).getByText(/lock every lamport raised/i)).toBeInTheDocument();
    expect(within(card).getByText(/Legacy SPL Token, not Token-2022/i)).toBeInTheDocument();
  });

  it('does not offer name / symbol / image fields — the program stores none of them', () => {
    renderView({
      probe: { status: 'deployed' },
      snapshot: snapshot({ status: 'present', value: globalCfg() }, { status: 'absent' }),
      mint: mintFacts(),
    });
    const card = screen.getByText('Open a launch').closest('section') as HTMLElement;
    expect(within(card).queryByLabelText(/name|symbol|uri|image/i)).not.toBeInTheDocument();
    expect(within(card).getByText(/never creates token metadata/i)).toBeInTheDocument();
  });

  it('shows the terms read from global, and flags an unconfigured venue as a real state', () => {
    renderView({
      probe: { status: 'deployed' },
      snapshot: snapshot(
        { status: 'present', value: globalCfg({ ammConfig: new Uint8Array(32) }) },
        { status: 'absent' },
      ),
      mint: mintFacts(),
    });
    const card = screen.getByText('Open a launch').closest('section') as HTMLElement;
    expect(within(card).getByText('not configured yet')).toBeInTheDocument();
    expect(within(card).getByText('85 SOL')).toBeInTheDocument();
  });

  it('states the terms are unknown rather than showing zeros when global is unreadable', () => {
    renderView({ probe: { status: 'deployed' }, snapshot: snapshot({ status: 'unreadable', reason: 'x' }, { status: 'absent' }) });
    const card = screen.getByText('Open a launch').closest('section') as HTMLElement;
    expect(within(card).getByText(/config could not be read, so the terms are unknown/i)).toBeInTheDocument();
    expect(within(card).queryByText('0 SOL')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Enumeration limit
// ---------------------------------------------------------------------------

describe('enumeration', () => {
  it('says launches cannot be listed rather than showing an incomplete list as complete', () => {
    renderView({ probe: { status: 'deployed' } });
    expect(screen.getByText(/cannot be listed/i)).toBeInTheDocument();
  });
});
