import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { CurveLaunchView, type CurveLaunchViewProps } from './CurveLaunchPage';
import {
  PLATFORM_TREASURY_VAULT,
  classifyLaunch,
  type BondingCurve,
  type CreateLaunchCost,
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

// The page mounts <LaunchGate>, which reads the connected EVM wallet. These tests
// render the view OUTSIDE a WagmiProvider on purpose (that is the point of the
// presentational seam), so wagmi is stubbed the same way LaunchTokenPage.test.tsx
// stubs it. No wallet => the gate renders its "connect a wallet" state, which asserts
// nothing about anybody and leaves every phase assertion below untouched. The gate's
// own behaviour is covered in lib/heat/launchGate.test.ts.
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x' }),
}));

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
    // Required by `BondingCurve` and absent from this fixture: it is the field
    // whose omission from the interface shifted every Borsh offset below it (see
    // program.ts). A fixture that skips it is not the account the decoder
    // produces. 4_800n matches the value the curve decode fixtures use.
    creatorFeeShareBps: 4_800n,
    graduationTargetLamports: 85n * SOL,
    migrationReserveLamports: 1n * SOL,
    complete: false,
    pool: new PublicKey(new Uint8Array(32)),
    bump: 255,
    // 3.69% of the 1e15 supply, paid to the treasury at creation and never in
    // `realTokenReserves`. The program sets the flag in that same instruction, so
    // every curve it creates reads true.
    platformReserveTokens: 36_900_000_000_000n,
    platformReserveReleased: true,
    ...over,
  };
}

function globalCfg(over: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    authority: KEY(3),
    // The mainnet configuration: the Squads vault. Tests of any other recipient
    // override it, and must then see no "multisig" claim.
    feeRecipient: PLATFORM_TREASURY_VAULT,
    tradeFeeBps: 100n,
    // Same required field, same reason — see the note in `curve()` above.
    creatorFeeShareBps: 4_800n,
    initialVirtualSol: 30n * SOL,
    initialVirtualToken: 1_073_000_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    graduationTargetLamports: 85n * SOL,
    migrationReserveLamports: 1n * SOL,
    cpSwapProgram: KEY(5),
    ammConfig: KEY(6),
    paused: false,
    bump: 254,
    platformReserveBps: 369n,
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
    expect(screen.getByText(/Buying stops there:\s+the graduation target plus a small amount that pays for opening the pool/i)).toBeInTheDocument();
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
    expect(screen.getByLabelText('Spend (SOL)')).toBeDisabled();

    // ...but switching to sell must NOT be greyed out.
    fireEvent.click(screen.getByRole('button', { name: /^sell$/i }));
    expect(screen.getByLabelText('Sell (tokens)')).not.toBeDisabled();
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
    fireEvent.change(screen.getByLabelText('Spend (SOL)'), { target: { value: '1' } });
    expect(screen.getByText('You pay')).toBeInTheDocument();
    // 1 SOL at 1% → 0.01 SOL fee, and the tokens the program's own formula gives.
    expect(screen.getByText('0.01 SOL')).toBeInTheDocument();
    expect(screen.getByText('Minimum received')).toBeInTheDocument();
  });

  it('shows the CAPPED debit on the last buy, not the amount entered', () => {
    // `max_lamports_in` is a ceiling, not a spend — a UI that echoes it back is
    // wrong on the last buy of every launch.
    renderView(deployedCurve({ realSolReserves: 86n * SOL - 1n }));
    fireEvent.change(screen.getByLabelText('Spend (SOL)'), { target: { value: '500' } });
    expect(screen.getByText(/Capped at the graduation line/i)).toBeInTheDocument();
    expect(screen.getByText(/remainder is never taken and never leaves your wallet/i)).toBeInTheDocument();
    // The entered 500 SOL must not be presented as the debit.
    expect(screen.queryByText('500 SOL')).not.toBeInTheDocument();
  });

  // UXR6: the read-only panel production shows kept 33px toggles, and its tolerance
  // buttons sat inside a <label>, so a tap on the label text silently set 0.5%.
  it('the read-only panel: 44px toggles, and a tap on the tolerance heading changes nothing', () => {
    renderView(deployedCurve());
    for (const name of [/^buy$/i, /^sell$/i, /^0\.50%$/, /^1%$/, /^3%$/]) {
      expect(screen.getByRole('button', { name })).toHaveClass('min-h-[44px]');
    }
    const one = screen.getByRole('button', { name: /^1%$/ });
    fireEvent.click(one);
    expect(one).toHaveAttribute('aria-pressed', 'true');
    const heading = screen.getByText('Slippage tolerance');
    expect(heading.closest('label')).toBeNull();
    fireEvent.click(heading);
    expect(one).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^0\.50%$/ })).toHaveAttribute('aria-pressed', 'false');
    // Its amount field is named by its visible label (WCAG 2.5.3).
    expect(screen.getByRole('textbox', { name: 'Spend (SOL)' })).toBeInTheDocument();
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
    expect(screen.getByLabelText('Sell (token base units)')).toBeInTheDocument();
    expect(screen.getByText(/decimals could not be read, so this is in raw base units/i)).toBeInTheDocument();
  });

  it('refuses a sell the fee would eat whole, rather than quoting "you receive 0 SOL"', () => {
    // 60,000 base units gross 1 lamport on this curve, and the 1% fee rounds up to it.
    renderView(deployedCurve({ realSolReserves: 10n * SOL }));
    fireEvent.click(screen.getByRole('button', { name: /^sell$/i }));
    fireEvent.change(screen.getByLabelText(/Amount of tokens to sell/i), { target: { value: '0.00006' } });
    expect(screen.getByText(/resolves to zero/i)).toBeInTheDocument();
    expect(screen.queryByText('You receive')).not.toBeInTheDocument();
  });

  it('surfaces a rejected quote as the program\'s own reason', () => {
    renderView(deployedCurve({ realSolReserves: 1n, realTokenReserves: 1_000n }));
    fireEvent.change(screen.getByLabelText('Spend (SOL)'), { target: { value: '50' } });
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
  // UXR6: the read-only view has no list, but launches CAN be listed (the write
  // section's list does it), so the card must not claim listing is impossible.
  it('the lookup card opens a launch by address, and does not claim launches cannot be listed', () => {
    renderView({ probe: DEPLOYED });
    expect(screen.getByText(/Open a launch by its token address \(mint\)\. This view has no list of launches\./)).toBeInTheDocument();
    expect(screen.queryByText(/cannot be listed/i)).not.toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// The platform reserve, the fee split, and what graduation really deposits
// ---------------------------------------------------------------------------

describe('platform reserve and fee split', () => {
  // Owner decision 2026-09-26: the reserve is paid when the token is created, and
  // the copy must say so, and say the treasury is a multisig, in plain words.
  const RESERVE_LINE =
    /Platform reserve: the platform receives 3\.69% of supply when the token is created\. It goes to the platform treasury, which is a multisig\./;

  it('states the platform reserve in the terms a launch would be created with', () => {
    renderView({ probe: DEPLOYED, snapshot: snapshot({ kind: 'ok', value: globalCfg() }, { kind: 'absent' }) });
    expect(screen.getByText(RESERVE_LINE)).toBeInTheDocument();
    expect(screen.getByText('3.69% of supply')).toBeInTheDocument();
  });

  it('reads the reserve from the config, not from a constant', () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot({ kind: 'ok', value: globalCfg({ platformReserveBps: 500n }) }, { kind: 'absent' }),
    });
    expect(screen.getByText(/Platform reserve: the platform receives 5\.00% of supply when the token is created/)).toBeInTheDocument();
    expect(screen.queryByText(/3\.69%/)).not.toBeInTheDocument();
  });

  it('says "none" for a zero reserve rather than describing one that does not exist', () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot({ kind: 'ok', value: globalCfg({ platformReserveBps: 0n }) }, { kind: 'absent' }),
    });
    expect(screen.queryByText(/Platform reserve: the platform receives/)).not.toBeInTheDocument();
  });

  it('shows the creator / protocol split of the fee in the terms', () => {
    renderView({ probe: DEPLOYED, snapshot: snapshot({ kind: 'ok', value: globalCfg() }, { kind: 'absent' }) });
    expect(screen.getByText('creator 48.00% · protocol 52.00% of the fee')).toBeInTheDocument();
  });

  it("shows a live launch's own split and reserve, from its snapshot", () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot(
        { kind: 'ok', value: globalCfg({ creatorFeeShareBps: 5_000n }) },
        { kind: 'ok', value: curveAccount(curve({ creatorFeeShareBps: 4_800n })) },
      ),
      mint: mintFacts(),
    });
    // The curve's snapshot, not the global's newer value.
    expect(screen.getByText('creator 48.00% · protocol 52.00% of the fee')).toBeInTheDocument();
    expect(screen.getByText('36,900')).toBeInTheDocument();
    expect(
      screen.getByText(/Platform reserve: sent to the platform treasury \(a multisig\) when this token was created/),
    ).toBeInTheDocument();
  });

  it('states the reserve as paid at creation, before and after graduation alike', () => {
    const g: Read<GlobalConfig> = { kind: 'ok', value: globalCfg() };
    const { unmount } = renderView({
      probe: DEPLOYED,
      snapshot: snapshot(g, { kind: 'ok', value: curveAccount(curve({ complete: true })) }),
      mint: mintFacts(),
    });
    expect(
      screen.getByText(/Platform reserve: sent to the platform treasury \(a multisig\) when this token was created/),
    ).toBeInTheDocument();
    // Nothing waits on graduation any more, so no "release" wording may survive.
    expect(document.body.textContent ?? '').not.toMatch(/release it|released to the treasury|until the launch graduates/);
    unmount();
    // An account that does not record the payment is described as exactly that,
    // never as paid.
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot(g, { kind: 'ok', value: curveAccount(curve({ platformReserveReleased: false })) }),
      mint: mintFacts(),
    });
    expect(screen.getByText(/Platform reserve: this curve account does not record it as paid/)).toBeInTheDocument();
  });

  it('does not say the curve sells everything but the reserve: unsold tokens go into the pool', () => {
    // A launch graduates on its SOL target, not when it runs out of tokens. At the
    // operator book it has sold about 56% of supply and pools about 40%.
    renderView({ probe: DEPLOYED, snapshot: snapshot({ kind: 'ok', value: globalCfg() }, { kind: 'absent' }) });
    const card = screen.getByText('Open a launch').closest('section') as HTMLElement;
    const text = (card.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).not.toMatch(/curve sells all of it/);
    expect(text).toMatch(
      /sends the platform reserve listed below to the platform treasury \(a multisig\), puts the rest into a fresh curve's vault/,
    );
    expect(text).toMatch(
      /The curve can sell everything in its vault; whatever it has not sold when it graduates goes into the pool\./,
    );
  });

  it('says what graduation puts in the pool, and that the reserve is not part of it', () => {
    renderView();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/deposits everything/);
    expect(text).toMatch(/What goes into the pool: the graduation target in SOL, and every token the curve did not sell/);
    expect(text).toMatch(/The platform\s+reserve does not go into the pool/);
    // Nothing looked up yet: the page has not read who the recipient is, so it
    // names the intended vault and makes no claim about the live one.
    expect(text).toMatch(/the platform treasury receives it when the token is created/);
    expect(text).toMatch(
      /The platform treasury is meant to be a Squads multisig vault \(GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd\)\. This page calls it a multisig only after reading the live config and finding that vault there\./,
    );
    // The old escrow copy must be gone everywhere on the page.
    expect(text).not.toMatch(/only (?:happen )?after graduation|only if the launch graduates|Graduation unlocks/);
  });

  it('with the vault configured, the explainer says the treasury is a multisig', () => {
    renderView({ probe: DEPLOYED, snapshot: snapshot({ kind: 'ok', value: globalCfg() }, { kind: 'absent' }) });
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toMatch(/the platform treasury \(a multisig\) receives it when the token is created/);
    expect(text).toMatch(/The platform treasury \(a multisig\) received it when the token was created/);
  });
});

// ---------------------------------------------------------------------------
// "The treasury is a multisig" is a claim about one address
// ---------------------------------------------------------------------------
// The program pays the reserve to whatever `global.fee_recipient` holds and never
// checks what that key is. So the page may say "multisig" only when the live config
// names the known Squads vault; for any other recipient it names the address and
// makes no claim about it.

describe('treasury multisig claim is backed by the live config', () => {
  const OTHER = KEY(4);
  const other: Read<GlobalConfig> = { kind: 'ok', value: globalCfg({ feeRecipient: OTHER }) };

  it('does not call a non-vault fee recipient a multisig, anywhere on the page', () => {
    renderView({ probe: DEPLOYED, snapshot: snapshot(other, { kind: 'ok', value: curveAccount(curve()) }), mint: mintFacts() });
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).not.toMatch(/\(a multisig\)|, a multisig,|which is a multisig/);
    expect(text).toContain(`Platform reserve: sent to the platform treasury (${OTHER.toBase58()}) when this token was created`);
    expect(text).toContain(
      `the platform receives 3.69% of supply when the token is created. It goes to the platform treasury (${OTHER.toBase58()}). This page cannot confirm that account is a multisig: it is not the platform's known Squads vault.`,
    );
  });

  it('calls the known vault a multisig in the terms, the curve card and the explainer', () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot({ kind: 'ok', value: globalCfg() }, { kind: 'ok', value: curveAccount(curve()) }),
      mint: mintFacts(),
    });
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toMatch(/It goes to the platform treasury, which is a multisig\./);
    expect(text).toMatch(/Platform reserve: sent to the platform treasury \(a multisig\) when this token was created/);
    expect(text).toMatch(/the platform treasury \(a multisig\) receives it when the token is created/);
  });
});

// ---------------------------------------------------------------------------
// What the creator pays
// ---------------------------------------------------------------------------
// Since 2026-09-26 the creator also pays rent for the treasury's token account when
// it does not exist yet. The checklist shows the rent read from the cluster, never a
// hardcoded figure, and never a zero for a read that failed.

describe('create checklist: what you pay', () => {
  const g: Read<GlobalConfig> = { kind: 'ok', value: globalCfg() };
  const cost = (over: Partial<CreateLaunchCost> = {}): Read<CreateLaunchCost> => ({
    kind: 'ok',
    value: {
      curve: 1_559_560n,
      vault: 1_488_440n,
      treasuryToken: 1_488_440n,
      treasuryTokenExists: false,
      total: 4_536_440n,
      ...over,
    },
  });
  const card = () => screen.getByText('Open a launch').closest('section') as HTMLElement;

  it("shows the rent the creator pays, including the treasury token account's", () => {
    renderView({ probe: DEPLOYED, snapshot: snapshot(g, { kind: 'absent' }), mint: mintFacts(), createCost: cost() });
    const c = card();
    expect(within(c).getByText('You pay (account rent)')).toBeInTheDocument();
    expect(within(c).getByText('0.00453644 SOL')).toBeInTheDocument();
    const text = (c.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain(
      "the treasury's token account 0.00148844 SOL (it does not exist yet, so you create it; the platform reserve is paid into it)",
    );
    expect(text).toMatch(/read from the cluster's current rent rate/);
  });

  it('says so when the treasury token account already exists, and charges nothing for it', () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot(g, { kind: 'absent' }),
      mint: mintFacts(),
      createCost: cost({ treasuryToken: 0n, treasuryTokenExists: true, total: 3_048_000n }),
    });
    const text = (card().textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain("the treasury's token account already exists, so you pay nothing for it");
    expect(within(card()).getByText('0.003048 SOL')).toBeInTheDocument();
  });

  it('says the cost is unknown when the rent read failed, never a zero', () => {
    renderView({
      probe: DEPLOYED,
      snapshot: snapshot(g, { kind: 'absent' }),
      mint: mintFacts(),
      createCost: { kind: 'unreadable', detail: 'rpc down' },
    });
    expect(within(card()).getByText(/Could not read the rent, so what you would pay is not shown/)).toBeInTheDocument();
    expect(within(card()).queryByText('0 SOL')).not.toBeInTheDocument();
  });
});
