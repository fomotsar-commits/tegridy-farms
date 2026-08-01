import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { CurveLaunchView, type CurveLaunchViewProps } from './CurveLaunchPage';
import {
  classifyLaunch,
  type BondingCurve,
  type CurveAccount,
  type Deployment,
  type GlobalConfig,
  type LaunchState,
  type MintFacts,
  type Read,
} from '../lib/launcher/solana/curve';

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
const KEY = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const DEPLOYED: Deployment = { kind: 'deployed', executable: true };

function curve(over: Partial<BondingCurve> = {}): BondingCurve {
  return {
    mint: KEY(1),
    creator: KEY(2),
    virtualSolReserves: 30n * SOL,
    virtualTokenReserves: 1_073_000_000_000_000n,
    realSolReserves: 0n,
    realTokenReserves: 1_000_000_000_000_000n,
    tradeFeeBps: 100n,
    graduationTargetLamports: 85n * SOL,
    migrationReserveLamports: 1n * SOL,
    complete: false,
    pool: new PublicKey(new Uint8Array(32)),
    bump: 255,
    ...over,
  };
}

function globalCfg(over: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    authority: KEY(3),
    feeRecipient: KEY(4),
    tradeFeeBps: 100n,
    initialVirtualSol: 30n * SOL,
    initialVirtualToken: 1_073_000_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    graduationTargetLamports: 85n * SOL,
    migrationReserveLamports: 1n * SOL,
    cpSwapProgram: KEY(5),
    ammConfig: KEY(6),
    paused: false,
    bump: 254,
    ...over,
  };
}

const curveAccount = (c: BondingCurve, lamports = 0n): CurveAccount => ({
  address: KEY(9),
  curve: c,
  lamports,
});

/**
 * Build a `LaunchState` the way the page receives one — through the REAL
 * classifier, not by hand. A hand-built phase would let this suite assert a
 * rendering for a state the classifier can never produce.
 */
function snapshot(
  g: Read<GlobalConfig>,
  c: Read<CurveAccount>,
  deployment: Deployment = DEPLOYED,
): LaunchState {
  return classifyLaunch(deployment, g, c);
}

const mintFacts = (over: Partial<MintFacts> = {}): Read<MintFacts> => ({
  kind: 'ok',
  value: { supply: 0n, decimals: 9, mintAuthority: 'creator', freezeAuthority: null, isLegacySplToken: true, ...over },
});

function renderView(over: Partial<CurveLaunchViewProps> = {}) {
  const props: CurveLaunchViewProps = {
    probe: { kind: 'not-deployed' },
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
    renderView({ probe: { kind: 'not-deployed' } });
    expect(screen.getByText('NOT DEPLOYED')).toBeInTheDocument();
    expect(screen.getByText(/no program at this address/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Token mint address')).toBeDisabled();
    expect(screen.getByRole('button', { name: /look up/i })).toBeDisabled();
  });

  it('does not claim a read FAILED when no lookup has been attempted', () => {
    // A fourth state alongside present/absent/unreadable: not asked. On first
    // load nothing has been looked up, and saying "the read failed" there is a
    // claim about a call that was never made.
    renderView({ probe: { kind: 'not-deployed' }, snapshot: null, mint: null });
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
    renderView({ probe: { kind: 'unreadable', detail: 'HTTP 503 from proxy' } });
    expect(screen.getByText('READ FAILED')).toBeInTheDocument();
    // The reason is surfaced by both the banner and the curve card, because the
    // probe failure propagates into the phase. Redundant, not contradictory.
    expect(screen.getAllByText(/HTTP 503 from proxy/).length).toBeGreaterThan(0);
    expect(screen.getByText(/says nothing about whether the program is live/i)).toBeInTheDocument();
    expect(screen.queryByText('NOT DEPLOYED')).not.toBeInTheDocument();
  });

  // ⚠ THE DEFECT THIS PAGE SHIPPED. `browserRpc` returned `body.result`, which is
  // `undefined` for a 200 carrying neither `result` nor `error`; `?? null`
  // downstream turned that into `{status:'not-deployed'}` and this page stated
  // "There is no program at this address. No launches exist…" — a finding
  // fabricated from a non-answer. The transport now throws (curve/rpc.test.ts) and
  // the read surfaces as `unreadable`; this pins what the USER then sees.
  it('a malformed RPC answer renders as READ FAILED, never as a confident negative', () => {
    renderView({
      probe: { kind: 'unreadable', detail: 'getAccountInfo: the response carried no `value`' },
    });
    expect(screen.getByText('READ FAILED')).toBeInTheDocument();
    expect(screen.queryByText('NOT DEPLOYED')).not.toBeInTheDocument();
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/There is no program at this address/i);
    expect(body).not.toMatch(/No launches exist/i);
    expect(body).toMatch(/says nothing about whether the program is live/i);
  });

  // The other end of the same distinction: an account IS there and it is not a
  // program. Neither "deployed" nor "nothing here".
  it('renders a squatting non-program account as its own state, and names the owner', () => {
    renderView({ probe: { kind: 'not-a-program', owner: 'SoLsQuAtTeR11111111111111111111111111111111' } });
    expect(screen.getByText('NOT A PROGRAM')).toBeInTheDocument();
    expect(screen.getByText(/owned by SoLsQuAtTeR/)).toBeInTheDocument();
    expect(screen.queryByText('DEPLOYED')).not.toBeInTheDocument();
    expect(screen.queryByText('NOT DEPLOYED')).not.toBeInTheDocument();
    // And it does not invite a lookup against a program that is not there.
    expect(screen.getByRole('button', { name: /look up/i })).toBeDisabled();
  });

  it('enables lookup only once a program was actually found', () => {
    renderView({ probe: DEPLOYED, mintInput: 'So11111111111111111111111111111111111111112' });
    expect(screen.getByLabelText('Token mint address')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /look up/i })).not.toBeDisabled();
  });

  it('withholds lookup for an address that is not plausibly base58', () => {
    renderView({ probe: DEPLOYED, mintInput: 'not-an-address!!' });
    expect(screen.getByRole('button', { name: /look up/i })).toBeDisabled();
    expect(screen.getByText(/does not look like a base58/i)).toBeInTheDocument();
  });

  it('never fabricates a market: no USD figure, no volume window, no holder count', () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot({ kind: 'ok', value: globalCfg() }, { kind: 'ok', value: curveAccount(curve()) }),
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
  const g: Read<GlobalConfig> = { kind: 'ok', value: globalCfg() };
  const deployed: Deployment = DEPLOYED;

  it('says "protocol not initialised" when global is missing', () => {
    renderView({ probe: deployed, snapshot: snapshot({ kind: 'absent' }, { kind: 'absent' }) });
    expect(screen.getByText(/protocol not initialised/i)).toBeInTheDocument();
    expect(screen.queryByText(/no curve for this mint/i)).not.toBeInTheDocument();
  });

  it('says "no curve for this mint" when only the curve is missing', () => {
    renderView({ probe: deployed, snapshot: snapshot(g, { kind: 'absent' }) });
    expect(screen.getByText(/no curve for this mint/i)).toBeInTheDocument();
    expect(screen.queryByText(/protocol not initialised/i)).not.toBeInTheDocument();
  });

  it('renders an absent curve as blank, NOT as 0 SOL raised', () => {
    renderView({ probe: deployed, snapshot: snapshot(g, { kind: 'absent' }) });
    expect(screen.getByText(/deliberately blank rather than zeroed/i)).toBeInTheDocument();
    expect(screen.queryByText(/SOL raised/i)).not.toBeInTheDocument();
  });

  it('renders an unreadable curve as a read failure, not as an empty launch', () => {
    renderView({ probe: deployed, snapshot: snapshot(g, { kind: 'unreadable', detail: 'decode failed' }) });
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
      snapshot: snapshot(g, { kind: 'ok', value: curveAccount(curve({ realSolReserves: 86n * SOL })) }),
    });
    expect(screen.getByText(/fully funded — awaiting migration/i)).toBeInTheDocument();
    // Said by BOTH the phase card and the blocked-buy reason — the two surfaces
    // a user reads must not disagree about which state this is.
    expect(screen.getAllByText(/has NOT graduated yet/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/liquidity has moved to the AMM pool/i)).not.toBeInTheDocument();
  });

  it('renders a completed curve as GRADUATED', () => {
    renderView({ probe: deployed, snapshot: snapshot(g, { kind: 'ok', value: curveAccount(curve({ complete: true })) }) });
    expect(screen.getByText('Graduated')).toBeInTheDocument();
    expect(screen.getByText(/liquidity has moved to the AMM pool/i)).toBeInTheDocument();
    expect(screen.queryByText(/awaiting migration/i)).not.toBeInTheDocument();
  });

  it('shows progress against target + reserve, not the target alone', () => {
    // Sitting exactly on the 85 SOL target with a 1 SOL reserve is 98.83%, not
    // 100% — buys still succeed up to the ceiling.
    //
    // 98.83 and not 98.84: `curveProgress` returns integer bps and TRUNCATES
    // (85/86 = 98.8372…% → 9883 bps), the same conservative direction as every
    // other rounding decision on this surface. Overstating progress is the one
    // that misleads.
    renderView({
      probe: deployed,
      snapshot: snapshot(g, { kind: 'ok', value: curveAccount(curve({ realSolReserves: 85n * SOL })) }),
    });
    expect(screen.getByText('98.83%')).toBeInTheDocument();
    expect(screen.queryByText('100.00%')).not.toBeInTheDocument();
    expect(screen.getByText(/graduation target plus\s+the migration reserve/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Pause semantics
// ---------------------------------------------------------------------------

describe('pause', () => {
  it('halts buys but keeps SELL usable — sells are unpausable on chain', () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot(
        { kind: 'ok', value: globalCfg({ paused: true }) },
        { kind: 'ok', value: curveAccount(curve()) },
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
  const deployedCurve = (over: Partial<BondingCurve> = {}) => ({
    probe: DEPLOYED,
    snapshot: snapshot({ kind: 'ok', value: globalCfg() }, { kind: 'ok', value: curveAccount(curve(over)) }),
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
    renderView({ ...deployedCurve(), mint: { kind: 'unreadable', detail: 'mint read failed' } });
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
      probe: DEPLOYED,
      snapshot: snapshot({ kind: 'ok', value: globalCfg() }, { kind: 'ok', value: curveAccount(curve()) }),
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
      probe: DEPLOYED,
      snapshot: snapshot({ kind: 'ok', value: globalCfg() }, { kind: 'absent' }),
      mint: mintFacts({ freezeAuthority: 'someone' }),
    });
    const card = screen.getByText('Open a launch').closest('section') as HTMLElement;
    expect(within(card).getByText(/No freeze authority/i)).toBeInTheDocument();
    expect(within(card).getByText(/lock every lamport raised/i)).toBeInTheDocument();
    expect(within(card).getByText(/Legacy SPL Token, not Token-2022/i)).toBeInTheDocument();
  });

  it('does not offer name / symbol / image fields — the program stores none of them', () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot({ kind: 'ok', value: globalCfg() }, { kind: 'absent' }),
      mint: mintFacts(),
    });
    const card = screen.getByText('Open a launch').closest('section') as HTMLElement;
    expect(within(card).queryByLabelText(/name|symbol|uri|image/i)).not.toBeInTheDocument();
    expect(within(card).getByText(/never creates token metadata/i)).toBeInTheDocument();
  });

  it('shows the terms read from global, and flags an unconfigured venue as a real state', () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot(
        { kind: 'ok', value: globalCfg({ ammConfig: new PublicKey(new Uint8Array(32)) }) },
        { kind: 'absent' },
      ),
      mint: mintFacts(),
    });
    const card = screen.getByText('Open a launch').closest('section') as HTMLElement;
    expect(within(card).getByText('not configured yet')).toBeInTheDocument();
    expect(within(card).getByText('85 SOL')).toBeInTheDocument();
  });

  it('states the terms are unknown rather than showing zeros when global is unreadable', () => {
    renderView({ probe: DEPLOYED, snapshot: snapshot({ kind: 'unreadable', detail: 'x' }, { kind: 'absent' }) });
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
    renderView({ probe: DEPLOYED });
    expect(screen.getByText(/cannot be listed/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The chart is actually MOUNTED
// ---------------------------------------------------------------------------
// CurveChart shipped fully built and fully tested but rendered by nothing, so a
// visitor with a live curve saw a text progress bar and no curve. Its own suite
// could not catch that — it renders the component directly. These assert the
// PAGE puts it on screen, which is the property that was actually broken.

describe('curve chart is mounted', () => {
  const g: Read<GlobalConfig> = { kind: 'ok', value: globalCfg() };

  it('renders the curve figure when a real curve account is in hand', () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot(g, { kind: 'ok', value: curveAccount(curve({ realSolReserves: 12n * SOL })) }),
      mint: mintFacts(),
    });
    const fig = screen.getByRole('img', { name: /bonding curve/i });
    expect(fig).toBeInTheDocument();
    // The label carries the same raise the numbers do — one derivation, not two.
    expect(fig).toHaveAttribute('aria-label', expect.stringMatching(/needed to graduate/i));
  });

  it('does NOT draw a curve when there is no curve account', () => {
    renderView({ probe: DEPLOYED, snapshot: snapshot(g, { kind: 'absent' }), mint: mintFacts() });
    expect(screen.queryByRole('img', { name: /bonding curve/i })).not.toBeInTheDocument();
  });

  it('does NOT draw a curve when the read failed', () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot(g, { kind: 'unreadable', detail: 'decode failed' }),
      mint: mintFacts(),
    });
    expect(screen.queryByRole('img', { name: /bonding curve/i })).not.toBeInTheDocument();
  });

  it('plots from the chain, never as an illustrative shape', () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot(g, { kind: 'ok', value: curveAccount(curve({ realSolReserves: 12n * SOL })) }),
      mint: mintFacts(),
    });
    // The "illustrative" badge naming a hand-drawn shape must never appear on a
    // page that just decoded a real account.
    expect(document.body.textContent ?? '').not.toMatch(/illustrative/i);
  });
});
