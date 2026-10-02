import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SolanaLaunchView, type LaunchData, type SolanaLaunchViewProps } from './CurveLaunchDetailPage';
import { awaitingOwnLaunch } from '../components/solana/curve/pendingLaunch';
import { readPendingTrades } from '../components/solana/curve/pendingTrade';
import { usePendingTrades } from '../components/solana/curve/usePendingTrades';
import { CurveLaunchView } from './CurveLaunchPage';
import {
  CREATOR,
  KEY,
  MINT,
  SIG,
  ammConfig,
  bondingCurve,
  buySummary,
  fakeApi,
  globalCfg,
  launchState,
  openGate,
  prepared,
} from '../components/solana/curve/fakeWriteApi.fixture';
import type { CurveSignerState } from '../components/solana/curve/useCurveSigner';
import { PLATFORM_TREASURY_VAULT } from '../lib/launcher/solana/curve';
import type { LaunchPool, TxOutcome, WriteApi, WriteGate, WriteRpc } from '../components/solana/curve/ports';
import type { PoolStateView } from '../lib/solana/cpswap/program';

vi.mock('../components/solana/SolanaConnectButton', () => ({
  SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button>,
}));
// The read-only view's door embeds a HeatCard, which calls wagmi's useAccount.
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x' }),
}));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

const ready: CurveSignerState = {
  kind: 'ready',
  address: CREATOR.toBase58(),
  signer: { publicKey: CREATOR, signTransaction: async (t) => t },
  signMessage: null,
};

function data(over: Partial<LaunchData> = {}): LaunchData {
  return {
    launch: launchState(bondingCurve()),
    mintFacts: {
      kind: 'ok',
      value: { supply: 1_000_000_000_000_000n, decimals: 6, mintAuthority: null, freezeAuthority: null, isLegacySplToken: true },
    },
    rentFloor: 2_000_000n,
    metadata: { kind: 'absent' },
    json: null,
    makerBuy: { kind: 'ok', value: { tokens: 50_000_000_000_000n, othersTokens: 0n, others: 0, birthSupply: 1_000_000_000_000_000n } },
    plant: { kind: 'ok', value: { burned: 50_000_000_000n, toWorkshop: 50_000_000_000n } },
    holding: { kind: 'unreadable', detail: 'HTTP 429' },
    pool: null,
    // Who the launch's own create transaction paid the reserve to.
    reserveRecipient: KEY(4),
    ...over,
  };
}

function renderView(over: Partial<SolanaLaunchViewProps> = {}, api: WriteApi = fakeApi(), gate: WriteGate = openGate()) {
  const props: SolanaLaunchViewProps = {
    gateState: { status: 'ready', api, cfg: openGate().cfg, gate },
    mint: MINT,
    data: data(),
    pending: null,
    signerState: ready,
    writeRpc: {} as WriteRpc,
    onSettled: vi.fn(),
    onRecheckPending: vi.fn(),
    recheckingPending: false,
    ...over,
  };
  render(
    <MemoryRouter>
      <SolanaLaunchView {...props} />
    </MemoryRouter>,
  );
  return props;
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('the launch page', () => {
  it('writes off: says so, and offers nothing', () => {
    renderView({ gateState: { status: 'disabled' } });
    expect(screen.getByText(/not switched on here yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('curve-trade-panel')).not.toBeInTheDocument();
  });

  it('always carries the not-endorsed line and the full mint', () => {
    renderView();
    // The island's words for the gate, plus the one on-chain truth: the program
    // itself accepts any wallet (H1, ruling of 2026-09-28).
    expect(
      screen.getByText(
        "Not endorsed by memetics.finance. A maker at Resident or better can grow a new token through the memetics.finance gate: the gate reads the maker's wallet at create. The program itself accepts any wallet, so check the full token address above before you buy.",
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Anyone can launch here/);
    // UX6: the Tegridy name was retired from the app on 2026-08-31 (RisksPage).
    expect(document.body.textContent).not.toMatch(/Tegridy/);
    expect(screen.getAllByText(MINT.toBase58()).length).toBeGreaterThan(0);
  });

  it("shows the maker's create-buy as a share of the supply with the wallet, and an unread holding as 'could not read', never 0", () => {
    renderView();
    expect(screen.getByTestId('maker-create-buy')).toHaveTextContent(
      "The maker's create-buy: 5.00% of the supply (50,000,000 tokens), bought in the launch transaction, before anyone else could buy.",
    );
    expect(screen.getByText("Maker's wallet").parentElement).toHaveTextContent(CREATOR.toBase58());
    const stake = screen.getByTestId('creator-stake');
    expect(stake.textContent).toMatch(/Creator's wallet holds now \(its usual account\)could not read/);
    expect(stake.textContent).not.toMatch(/token account|any wallet/);
  });

  // F15: both reasons printed after both rows, so the opening buy's reason read as
  // explaining the holding.
  it('each "could not read" reason sits directly under its own line', () => {
    renderView({
      data: data({
        makerBuy: { kind: 'unreadable', detail: 'the launch transaction could not be found' },
        holding: { kind: 'unreadable', detail: 'HTTP 503' },
      }),
    });
    expect(screen.getByTestId('maker-create-buy').textContent).toMatch(
      /This is our read failing, not a finding about the launch\.the launch transaction could not be found/,
    );
    expect(screen.getByTestId('creator-stake').textContent).toMatch(/Creator's wallet holds now \(its usual account\)could not readHTTP 503/);
  });

  // Ruling 3: the maker's plates come first, before anyone can buy.
  it("the maker's create-buy sits right after the mint row, before the note, the description and any trade form", () => {
    renderView();
    const plates = screen.getByTestId('maker-create-buy');
    const identity = screen.getByTestId('launch-identity');
    expect(within(identity).getByText('Token address (mint)').parentElement!.nextElementSibling).toBe(plates);
    expect(plates.compareDocumentPosition(screen.getByTestId('curve-trade-panel')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(plates).toHaveTextContent("No lock: this launcher has no way to lock a maker's tokens.");
    expect(plates).toHaveTextContent(
      "Plant: 50,000 $BAYLA burned and 50,000 $BAYLA to the island's Workshop, in the launch transaction.",
    );
  });

  it("the share is of the supply at birth, not of today's supply", () => {
    // Since the launch, burns took today's supply down to 40%. The share is still 5.00%.
    renderView({
      data: data({
        mintFacts: {
          kind: 'ok',
          value: { supply: 400_000_000_000_000n, decimals: 6, mintAuthority: null, freezeAuthority: null, isLegacySplToken: true },
        },
      }),
    });
    expect(screen.getByTestId('maker-create-buy')).toHaveTextContent(/create-buy: 5\.00% of the supply/);
    expect(screen.getByTestId('maker-create-buy').textContent).not.toMatch(/12\.50%/);
  });

  it('a launch transaction that could not be read: says our read failed, never 0 or 0%', () => {
    renderView({ data: data({ makerBuy: { kind: 'unreadable', detail: 'HTTP 429' }, plant: { kind: 'unreadable', detail: 'HTTP 429' } }) });
    const plates = screen.getByTestId('maker-create-buy');
    expect(plates).toHaveTextContent(
      "Could not read the maker's create-buy right now. This is our read failing, not a finding about the launch.",
    );
    expect(plates).toHaveTextContent('Could not read whether this launch carried a plant.');
    expect(plates.textContent).not.toMatch(/\b0(\.00)?%|\b0 tokens|bought nothing|No plant/);
    // The wallet is still the launch account's own creator.
    expect(screen.getByText("Maker's wallet").parentElement).toHaveTextContent(CREATOR.toBase58());
  });

  // F10: an unreadable name said "No name", a fact the page did not have.
  it('the title says the name could not be read, or that there is none, never guessing', () => {
    renderView({ data: data({ metadata: { kind: 'unreadable', detail: 'HTTP 429' } }) });
    expect(screen.getByTestId('launch-identity')).toHaveTextContent('Name could not be read');
    expect(screen.getByTestId('launch-identity')).not.toHaveTextContent(/^No name/);
  });

  // UXR10: the links were ~18px tall bare text, one of them named just "X".
  it("the launch's links are full-size targets, named plainly, and say they open a new tab", () => {
    renderView({
      data: data({
        metadata: { kind: 'ok', value: { mint: MINT, name: 'Farm', symbol: 'FRM', uri: 'https://ipfs.io/ipfs/x', updateAuthority: null, isMutable: false } } as never,
        json: {
          kind: 'ok',
          json: { name: 'Farm', symbol: 'FRM', description: '', image: null, mint: null, website: 'https://farm.example', twitter: 'https://x.com/farm', telegram: 'https://t.me/farm' },
          mintMatches: true,
          issues: [],
        } as never,
      }),
    });
    for (const name of ['Website', 'X (Twitter)', 'Telegram']) {
      const link = screen.getByRole('link', { name: `${name} (opens in a new tab)` });
      expect(link).toHaveClass('min-h-[44px]');
      expect(link).toHaveTextContent(name);
    }
    expect(screen.queryByRole('link', { name: /^X$/ })).not.toBeInTheDocument();
  });

  it('a launch with no details on chain says it was made outside this site', () => {
    renderView({ data: data({ metadata: { kind: 'absent' } }) });
    expect(screen.getByTestId('launch-identity')).toHaveTextContent('No name (made outside this site)');
  });

  // F13/UX7 and F1: the state card in plain words, with a price people can read.
  it('the curve card speaks plainly: a written-out price, no jargon, and who gets the reserve', () => {
    renderView();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/denominator|display ratio|virtual \+ real|global config|lamport/i);
    for (const label of screen.getAllByText('Spot price')) {
      const spot = label.parentElement!;
      expect(spot.textContent).toMatch(/\d/);
      expect(spot.textContent).not.toMatch(/\de[-+]\d/);
    }
    expect(text).toMatch(/Buying stops there: the graduation target plus a small amount that pays for opening the pool\./);
    // Paid at creation, to the fee recipient in the launch's own create transaction, named by address because it is not the known vault.
    expect(text).toContain(`Platform reserve: paid when this token was created, to the platform treasury (${KEY(4).toBase58()}).`);
    expect(text).not.toMatch(/release|held by the program|if this launch graduates/i);
  });

  it('a launch that was just sent and is not on chain yet says "not found yet", never "no launch"', () => {
    const p = renderView({
      data: data({ launch: launchState(null) }),
      pending: { signature: SIG, sentAt: Date.now(), lastValidBlockHeight: 99 },
    });
    expect(screen.getByText(/Not found yet\. Your launch may still be landing/)).toBeInTheDocument();
    expect(screen.queryByText('No launch at this address')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(p.onRecheckPending).toHaveBeenCalled();
  });

  // F5: a failed read right after sending used to drop the "still landing" card, so
  // the creator saw only "a read failed" and could launch a second time.
  const unreadable = (): LaunchData =>
    data({
      launch: { phase: { kind: 'unreadable', detail: 'HTTP 429' }, paused: null, ammConfigured: null, global: null, curve: null },
      mintFacts: { kind: 'unreadable', detail: 'HTTP 429' },
      metadata: { kind: 'unreadable', detail: 'HTTP 429' },
      makerBuy: null,
      plant: null,
      holding: null,
    });

  it("the launch's account could not be read: the plates are still there, and say they could not be read", () => {
    renderView({ data: unreadable() });
    const plates = screen.getByTestId('maker-create-buy');
    expect(plates).toHaveTextContent(
      "Could not read the maker's create-buy right now. This is our read failing, not a finding about the launch.",
    );
    expect(plates).toHaveTextContent('HTTP 429');
    expect(plates).toHaveTextContent('Could not read whether this launch carried a plant.');
    expect(plates.textContent).not.toMatch(/\b0(\.00)?%|\b0 tokens|bought nothing|No plant/);
    expect(screen.queryByText("Maker's wallet")).not.toBeInTheDocument();
  });

  it('no launch at this address: no plates, since there is no maker to read', () => {
    renderView({ data: data({ launch: launchState(null), makerBuy: null, plant: null }) });
    expect(screen.queryByTestId('maker-create-buy')).not.toBeInTheDocument();
  });

  it('while the first read is in flight: no plates yet, and no figure', () => {
    renderView({ data: null });
    expect(screen.queryByTestId('maker-create-buy')).not.toBeInTheDocument();
  });

  it('a launch just sent whose read then FAILED still says "may still be landing, do not launch again"', () => {
    const p = renderView({ data: unreadable(), pending: { signature: SIG, sentAt: Date.now(), lastValidBlockHeight: 99 } });
    const card = screen.getByTestId('pending-launch');
    expect(card).toHaveTextContent(/may still be landing\. Do not launch it again/);
    expect(card).toHaveTextContent(SIG);
    expect(card.querySelector('a')).toHaveTextContent('View on the explorer');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(p.onRecheckPending).toHaveBeenCalled();
  });

  it('the page keeps looking on its own after a failed read while its own launch is pending', () => {
    const pending = { signature: SIG, sentAt: Date.now(), lastValidBlockHeight: 99 };
    expect(awaitingOwnLaunch(pending, 'unreadable')).toBe(true);
    expect(awaitingOwnLaunch(pending, 'pre-launch')).toBe(true);
    expect(awaitingOwnLaunch(pending, 'trading')).toBe(false);
    expect(awaitingOwnLaunch(null, 'unreadable')).toBe(false);
  });

  it('a failed read with nothing pending offers "Read again"', () => {
    const onReload = vi.fn();
    renderView({ data: unreadable(), onReload });
    expect(screen.queryByText('No launch at this address')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
    expect(onReload).toHaveBeenCalled();
  });

  it('no curve and nothing pending: says there is no launch at this address', () => {
    renderView({ data: data({ launch: launchState(null) }) });
    expect(screen.getByText('No launch at this address')).toBeInTheDocument();
  });

  it("the trade panel's sell side gets the connected wallet's own balance from the page", () => {
    renderView({ walletHolding: { kind: 'ok', value: 7_000_000n } });
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByTestId('your-holding')).toHaveTextContent('You hold 7');
  });

  it('bonding: the trade panel is there and graduation is not', () => {
    renderView();
    expect(screen.getByTestId('curve-trade-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('graduation-panel')).not.toBeInTheDocument();
  });

  it('paused: selling stays available on the page', () => {
    const g = globalCfg({ paused: true });
    const api = fakeApi({ writeActions: vi.fn(() => ({ create: false, buy: false, sell: true, migrate: false, poolSwap: false })) });
    renderView({ data: data({ launch: launchState(bondingCurve(), g) }) }, api, openGate({ paused: true, global: g }));
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByLabelText('Sell (tokens)')).not.toBeDisabled();
  });

  it('graduated: pool panel, no curve trading, and nothing about the reserve waits on graduation', () => {
    const c = bondingCurve({ complete: true });
    const api = fakeApi({ writeActions: vi.fn(() => ({ create: true, buy: false, sell: false, migrate: false, poolSwap: true })) });
    renderView({ data: data({ launch: launchState(c), pool: { kind: 'unreadable', detail: 'HTTP 500' } }) }, api);
    expect(screen.queryByTestId('curve-trade-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('pool-swap-panel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /release/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('graduation-panel')).toHaveTextContent(`Paid when this token was created, to the platform treasury (${KEY(4).toBase58()}). Graduation did not touch it.`);
    // Graduation empties the curve's real reserves: its progress, "SOL raised" and
    // spot would read as a confident 0% / 0 SOL / stale price next to the live pool.
    expect(screen.getByTestId('curve-closed')).toHaveTextContent(/The curve closed at graduation/);
    expect(screen.queryByText('Spot price')).not.toBeInTheDocument();
    expect(screen.queryByText('SOL raised (curve reserves)')).not.toBeInTheDocument();
    expect(screen.queryByText('Raised toward graduation')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  // L1: a trade this browser sent and could not confirm survives a reload. Until the
  // chain answers, no trade form is shown for the mint.
  it('a trade still landing from before a reload: shows it, and no buy, sell, graduation or pool form', () => {
    const recheck = vi.fn();
    const dismiss = vi.fn();
    const note = { kind: 'buy' as const, signature: SIG, lastValidBlockHeight: 99, sentAt: Date.now() };
    renderView({ pendingTrade: { notes: [note], checking: false, message: 'The network has no record of it yet.', recheck, dismiss } });
    expect(screen.getByTestId('pending-trade')).toHaveTextContent(/Sent, not confirmed yet\. Trading here stays off/);
    expect(screen.getByTestId('pending-trade')).toHaveTextContent(SIG);
    expect(screen.queryByTestId('curve-trade-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graduation-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pool-swap-panel')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/fail/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(recheck).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'I checked my wallet: start over' }));
    expect(dismiss).toHaveBeenCalled();
  });

  it('while the first check is running, still no trade form', () => {
    const note = { kind: 'sell' as const, signature: SIG, lastValidBlockHeight: null, sentAt: Date.now() };
    renderView({ pendingTrade: { notes: [note], checking: true, message: null, recheck: vi.fn(), dismiss: vi.fn() } });
    expect(screen.getByText('Checking it on the network…')).toBeInTheDocument();
    expect(screen.queryByTestId('curve-trade-panel')).not.toBeInTheDocument();
  });

  // FS-1: during the wait for the network (up to two minutes) nothing was saved, so a
  // reload brought back an open trade form while the first trade could still land.
  // The page is wired as it ships: the real pending-trade hook, the real panels.
  it('a trade still waiting for the network survives a reload: the note exists BEFORE the wait ends, and the form stays hidden', async () => {
    const api = fakeApi({
      prepareCurveBuy: vi.fn(async () => ({ ok: true as const, prepared: prepared(buySummary()) })),
      // The network never answers while this test runs.
      submitPrepared: vi.fn((_r, _s, _p, deps) => {
        deps?.onSent?.(SIG, 1234);
        return new Promise<TxOutcome>(() => undefined);
      }),
      recheckOutcome: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'The network has no record of it yet.' })),
    });
    const check = (sig: string, lvbh: number | null) =>
      api.recheckOutcome({} as WriteRpc, sig, lvbh === null ? undefined : { lastValidBlockHeight: lvbh });
    function Page() {
      const pendingTrade = usePendingTrades(MINT.toBase58(), check, () => undefined);
      return (
        <MemoryRouter>
          <SolanaLaunchView
            gateState={{ status: 'ready', api, cfg: openGate().cfg, gate: openGate() }}
            mint={MINT}
            data={data()}
            pending={null}
            signerState={ready}
            writeRpc={{} as WriteRpc}
            onSettled={pendingTrade.record}
            onRecheckPending={vi.fn()}
            recheckingPending={false}
            pendingTrade={pendingTrade}
          />
        </MemoryRouter>
      );
    }
    const first = render(<Page />);
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '0.1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review buy' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    });
    await waitFor(() => expect(screen.getByTestId('tx-sent')).toHaveTextContent(SIG));
    // Written while the transaction is still in the air.
    expect(readPendingTrades(MINT.toBase58())).toMatchObject([{ kind: 'buy', signature: SIG, lastValidBlockHeight: 1234 }]);

    first.unmount(); // the reload
    render(<Page />);
    expect(screen.getByTestId('pending-trade')).toHaveTextContent(SIG);
    expect(screen.queryByTestId('curve-trade-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graduation-panel')).not.toBeInTheDocument();
    await waitFor(() => expect(api.recheckOutcome).toHaveBeenCalledWith(expect.anything(), SIG, { lastValidBlockHeight: 1234 }));
    expect(screen.queryByTestId('curve-trade-panel')).not.toBeInTheDocument();
  });

  it('a trade the network turned away at the first send clears the note written when it was sent', async () => {
    const api = fakeApi({
      prepareCurveBuy: vi.fn(async () => ({ ok: true as const, prepared: prepared(buySummary()) })),
      submitPrepared: vi.fn(async (_r, _s, _p, deps) => {
        deps?.onSent?.(SIG, 1234);
        return { status: 'not-sent' as const, stage: 'send' as const, message: 'Blockhash not found.' };
      }),
    });
    function Page() {
      const pendingTrade = usePendingTrades(MINT.toBase58(), null, () => undefined);
      return (
        <MemoryRouter>
          <SolanaLaunchView
            gateState={{ status: 'ready', api, cfg: openGate().cfg, gate: openGate() }}
            mint={MINT}
            data={data()}
            pending={null}
            signerState={ready}
            writeRpc={{} as WriteRpc}
            onSettled={pendingTrade.record}
            onRecheckPending={vi.fn()}
            recheckingPending={false}
            pendingTrade={pendingTrade}
          />
        </MemoryRouter>
      );
    }
    render(<Page />);
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '0.1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review buy' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    });
    await waitFor(() => expect(screen.getByTestId('tx-outcome')).toHaveAttribute('data-status', 'not-sent'));
    expect(readPendingTrades(MINT.toBase58())).toEqual([]);
  });

  // UXR2: the pending card's buttons were switched off while checking, dropping focus.
  it('the pending-trade card keeps focus on Check again while it checks, and says what each check found', () => {
    const note = { kind: 'buy' as const, signature: SIG, lastValidBlockHeight: 99, sentAt: Date.now() };
    const recheck = vi.fn();
    const dismiss = vi.fn();
    renderView({ pendingTrade: { notes: [note], checking: true, message: null, recheck, dismiss } });
    const card = screen.getByTestId('pending-trade');
    for (const name of ['Check again', 'I checked my wallet: start over']) {
      const b = screen.getByRole('button', { name });
      // Focusable (not `disabled`), marked busy, and inert while the check runs.
      expect(b).not.toBeDisabled();
      expect(b).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(b);
    }
    expect(recheck).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(card.querySelector('[role="status"]')).toHaveTextContent('Checking it on the network…');
  });

  // UXR1 sibling: "Check again" on a pending launch showed nothing about what it found.
  it('the pending-launch card says what the last check found, in a status line', () => {
    renderView({
      data: data({ launch: launchState(null) }),
      pending: { signature: SIG, sentAt: Date.now(), lastValidBlockHeight: 99 },
      pendingCheckMessage: 'The network has no record of it yet. It may still be landing.',
    });
    const card = screen.getByTestId('pending-launch');
    const status = card.querySelector('[role="status"]');
    expect(status).toHaveTextContent('The network has no record of it yet. It may still be landing.');
    expect(screen.getByRole('button', { name: 'Check again' })).not.toBeDisabled();
  });

  // R6-2: the creator fee is a live cp-swap setting (graduation opens the pool with it
  // allowed), and a graduated launch trades under its OWN pool's settings.
  it('"before you trade" states a pool creator fee and a fund cut when they are set, from the pool itself once graduated', () => {
    const c = bondingCurve({ complete: true, pool: KEY(40) });
    const view = {
      address: KEY(40).toBase58(),
      ammConfig: KEY(41).toBase58(),
      token0Mint: KEY(1).toBase58(),
      token1Mint: KEY(2).toBase58(),
      status: 0,
      openTime: 0n,
      enableCreatorFee: true,
      creatorFeeOn: 0,
    } as unknown as PoolStateView;
    const pool: LaunchPool = {
      address: KEY(40),
      ammConfigAddress: KEY(41),
      // The pool's own settings differ from the launch program's current ones.
      ammConfig: { ...ammConfig, tradeFeeRate: 3_000n, fundFeeRate: 40_000n, creatorFeeRate: 500n },
      snapshot: { pool: view, vault0Amount: 1n, vault1Amount: 1n, reserve0: 1n, reserve1: 1n },
    };
    const api = fakeApi({ writeActions: vi.fn(() => ({ create: true, buy: false, sell: false, migrate: false, poolSwap: true })) });
    renderView({ data: data({ launch: launchState(c), pool: { kind: 'ok', value: pool } }) }, api);
    const card = screen.getByTestId('before-you-trade');
    expect(card).toHaveTextContent(
      'the pool charges 0.30% per trade; 12.00% of that goes to the platform, 4.00% to the pool program\'s fund, and the rest stays in the pool',
    );
    expect(card).toHaveTextContent('The creator also gets 0.05% of each pool trade, charged on top of the pool fee.');
    expect(card).not.toHaveTextContent(/creator gets nothing/);
  });

  it('"before you trade": a graduated launch whose pool could not be read does not state the pool fee as a fact', () => {
    const c = bondingCurve({ complete: true, pool: KEY(40) });
    const api = fakeApi({ writeActions: vi.fn(() => ({ create: true, buy: false, sell: false, migrate: false, poolSwap: true })) });
    renderView({ data: data({ launch: launchState(c), pool: { kind: 'unreadable', detail: 'HTTP 500' } }) }, api);
    const card = screen.getByTestId('before-you-trade');
    expect(card).toHaveTextContent(/pool charges its own fee, which could not be read just now/);
    expect(card).toHaveTextContent(/Whether the creator gets a share of pool trades could not be read/);
    expect(card).not.toHaveTextContent(/creator gets nothing/);
  });

  // UX2: the page people trade on carries the venue, fee and loss facts, from the chain.
  it('shows "before you trade": venue, curve and pool fees, LP burn, the reserve, total loss', () => {
    renderView();
    const card = screen.getByTestId('before-you-trade');
    expect(card).toHaveTextContent(/only on this site/);
    expect(card).toHaveTextContent(/not on Jupiter/);
    expect(card).toHaveTextContent('1.00% fee: 50.00% of it goes to the creator and 50.00% to the platform');
    expect(card).toHaveTextContent('the pool charges 0.25% per trade; 12.00% of that goes to the platform');
    expect(card).toHaveTextContent(/creator gets nothing from pool trades/);
    expect(card).toHaveTextContent(
      `When this token was created, the platform received 3.69% of the supply, sent to the platform treasury (${KEY(4).toBase58()}). This page cannot confirm that the treasury is a multisig. The program does not stop the treasury selling those tokens, including while the curve is live.`,
    );
    expect(card).toHaveTextContent(/You can lose everything/);
  });

  // update_global can change fee_recipient after a launch. Every sentence about a past
  // payment names the account in the launch's own create transaction, and calls it a
  // multisig only when THAT account is the vault, whatever today's config says.
  it("names who was paid from the launch's own transaction, never from today's config", () => {
    const today = globalCfg({ feeRecipient: PLATFORM_TREASURY_VAULT });
    const c = bondingCurve({ complete: true });
    const api = fakeApi({ writeActions: vi.fn(() => ({ create: true, buy: false, sell: false, migrate: false, poolSwap: true })) });
    const paidThen = KEY(7);
    const view = (reserveRecipient: LaunchData['reserveRecipient']) =>
      renderView(
        { data: data({ launch: launchState(c, today), pool: { kind: 'unreadable', detail: 'HTTP 500' }, reserveRecipient }) },
        api,
        openGate({ global: today }),
      );

    view(paidThen);
    let text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    const named = `the platform treasury (${paidThen.toBase58()})`;
    expect(text).toContain(`Platform reserve: paid when this token was created, to ${named}.`);
    expect(screen.getByTestId('graduation-panel')).toHaveTextContent(`Paid when this token was created, to ${named}.`);
    expect(screen.getByTestId('before-you-trade')).toHaveTextContent(`sent to ${named}. This page cannot confirm`);
    expect(text).not.toMatch(/\(a multisig\)/);
    expect(text).not.toContain(PLATFORM_TREASURY_VAULT.toBase58());
    cleanup();

    // Not read: no address, no multisig claim, and nothing borrowed from today's config.
    view(null);
    text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('Platform reserve: paid when this token was created, to the platform treasury at the time.');
    expect(screen.getByTestId('graduation-panel')).toHaveTextContent('Paid when this token was created, to the platform treasury at the time.');
    expect(screen.getByTestId('before-you-trade')).toHaveTextContent('sent to the platform treasury at the time.');
    expect(text).not.toMatch(/\(a multisig\)/);
    expect(text).not.toContain(PLATFORM_TREASURY_VAULT.toBase58());
  });

  it('a blocked gate shows the reason and no action panels', () => {
    renderView({}, fakeApi(), { kind: 'blocked', reason: 'launch-program-missing', detail: '' });
    expect(screen.getByText(/launch program is not on this network/)).toBeInTheDocument();
    expect(screen.queryByTestId('curve-trade-panel')).not.toBeInTheDocument();
    // The state is still read and shown.
    expect(screen.getByText('Curve state')).toBeInTheDocument();
  });
});

describe('/curve-launch with the write section', () => {
  const base = {
    probe: { kind: 'deployed', executable: true } as const,
    snapshot: null,
    mint: null,
    mintInput: '',
    onMintInput: vi.fn(),
    onLookup: vi.fn(),
    loading: false,
  };

  it('open gate: the write section replaces the read-only cards and the EVM heat gate', () => {
    render(
      <MemoryRouter>
        <CurveLaunchView {...base} gateBanner={<p>gate banner</p>} write={<p>write section</p>} />
      </MemoryRouter>,
    );
    expect(screen.getByText('write section')).toBeInTheDocument();
    expect(screen.getByText('gate banner')).toBeInTheDocument();
    expect(screen.queryByText(/has no list of launches/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no signing path on this page/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Open a launch')).not.toBeInTheDocument();
  });

  // F11: writes on but the gate not open: the banner above says why, so the panel
  // below must not claim the program still has to be deployed.
  it('a gate that is not open: the read-only panel points at the note above, not at a deployment', () => {
    render(
      <MemoryRouter>
        <CurveLaunchView {...base} gateBanner={<p>We could not read the network to check</p>} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/not available right now; see the note above/)).toBeInTheDocument();
    expect(screen.queryByText(/until the new program is deployed/)).not.toBeInTheDocument();
  });

  // F13: the explainer said "permissionless" and "a lamport short".
  it('the explainer says who can finish a graduation in plain words', () => {
    render(
      <MemoryRouter>
        <CurveLaunchView {...base} />
      </MemoryRouter>,
    );
    const card = screen.getByText('What graduation does and does not promise').closest('section')!;
    expect(card.textContent).not.toMatch(/permissionless|lamport/i);
    expect(card).toHaveTextContent(/Anyone can finish a graduation, and it pays them nothing/);
    expect(screen.getByText('What this is').closest('section')!.textContent).not.toMatch(/one instruction|virtual plus real/i);
  });

  it('no write section: today\'s read-only page, unchanged', () => {
    render(
      <MemoryRouter>
        <CurveLaunchView {...base} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/no signing path on this page/i)).toBeInTheDocument();
    expect(screen.getByText(/has no list of launches/)).toBeInTheDocument();
  });
});
