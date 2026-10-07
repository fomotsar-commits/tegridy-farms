import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { Transaction, TransactionInstruction, type PublicKey } from '@solana/web3.js';
import { FeeRows, TxFlowView, TxOutcomeCard, TxReview } from './TxFlowView';
import { reviewLines, type ReviewLine } from './reviewLines';
import { REVIEW_TTL_MS, SIGN_MARGIN_BLOCKS, useTxFlow } from './useTxFlow';
import { CREATOR, KEY, PLANT_SUMMARY, SIG, buySummary, fakeApi, prepared } from './fakeWriteApi.fixture';
import { lpCreateSummary, lpDepositSummary, lpWithdrawSummary, venueSwapSummary } from '../lp/fakeLpWriteApi.fixture';
import type { Prepared, PreparedTx, TxOutcome, TxSigner, TxSummary, WriteApi, WriteRpc } from './ports';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import { PRICE_TOLERANCE } from '../../../lib/solana/lp/poolHealth';

const SOL_1 = 1_000_000_000n;
const MINT_X = KEY(15);

const rpc = {} as WriteRpc;
const signer: TxSigner = { publicKey: CREATOR, signTransaction: async (t) => t };

function outcome(o: TxOutcome) {
  return render(<TxOutcomeCard outcome={o} explorerUrl={'signature' in o && o.signature ? `https://x/${o.signature}` : null} onRecheck={vi.fn()} onReset={vi.fn()} rechecking={false} />);
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// What each outcome SAYS. The one that matters most: sent-but-unconfirmed must
// never read as a failure, or a person presses the button again and pays twice.
// ---------------------------------------------------------------------------

describe('outcome copy', () => {
  it('unknown: says sent and not confirmed, gives the signature and Check again, and never says failed', () => {
    outcome({ status: 'unknown', signature: SIG, message: 'the status read timed out' });
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Sent, not confirmed yet\. Do not retry until you check\./);
    expect(text).toContain(SIG);
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /explorer/i })).toHaveAttribute('href', `https://x/${SIG}`);
    expect(text).not.toMatch(/fail/i);
  });

  it('unknown with no signature: cannot say whether it was sent, and still never says failed', () => {
    outcome({ status: 'unknown', signature: '', message: 'We lost track of this transaction.' });
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/cannot tell whether this was sent/i);
    expect(text).not.toMatch(/fail/i);
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });

  // UXR12: the card's line and the write layer's message said the same thing twice.
  it('expired: did not go through, nothing charged, safe to retry, said ONCE', () => {
    outcome({
      status: 'expired',
      signature: SIG,
      message: 'This did not go through, and it can no longer go through. Nothing was charged. It is safe to try again.',
    });
    const text = screen.getByTestId('tx-outcome').textContent ?? '';
    expect(text).toMatch(/Did not go through, and it can no longer go through\. Nothing was charged\. It is safe to try again\./);
    expect(text.match(/Nothing was charged/g)).toHaveLength(1);
    expect(text.match(/safe to try again/g)).toHaveLength(1);
  });

  // R6-3: a refused transaction pays the priority fee too, and the review shows it as
  // its own row. The outcome names both fees and what they came to, once.
  it('reverted: names the program reason and says the network AND priority fee were spent, once', () => {
    render(
      <TxOutcomeCard
        outcome={{ status: 'reverted', signature: SIG, program: 'launch', code: 6007, message: 'The price moved past your limit.' }}
        explorerUrl={null}
        onRecheck={vi.fn()}
        onReset={vi.fn()}
        rechecking={false}
        fees={{ baseLamports: 5_000n, priorityLamports: 12_000n, priorityFeeRead: true, newAccountRentLamports: 0n }}
      />,
    );
    expect(screen.getByText('The price moved past your limit.')).toBeInTheDocument();
    const text = screen.getByTestId('tx-outcome').textContent ?? '';
    // The amount is in the review's own format (5,000 + 12,000 lamports is under 0.0001 SOL).
    expect(text).toMatch(/Nothing moved except the fees: <0\.0001 SOL \(the network fee and the priority fee\)\./);
    expect(text).not.toMatch(/only the network fee|except the network fee\./);
    expect(text.match(/fee/g)?.length).toBe(3);
  });

  // UXR1: "Check again" on a sent-but-unconfirmed transaction said nothing new: what
  // each check found was never shown, or read out.
  it('unknown: what the first watch saw and what each check finds is on screen, in a status line', () => {
    const props = { explorerUrl: `https://x/${SIG}`, onRecheck: vi.fn(), onReset: vi.fn() };
    const view = render(
      <TxOutcomeCard outcome={{ status: 'unknown', signature: SIG, message: 'The network did not confirm it while this page was watching.' }} rechecking={false} {...props} />,
    );
    const line = screen.getByTestId('tx-check-result');
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveTextContent('The network did not confirm it while this page was watching.');
    view.rerender(
      <TxOutcomeCard outcome={{ status: 'unknown', signature: SIG, message: 'The network did not confirm it while this page was watching.' }} rechecking {...props} />,
    );
    expect(line).toHaveTextContent('Checking the network…');
    view.rerender(
      <TxOutcomeCard
        outcome={{ status: 'unknown', signature: SIG, message: 'The network has no record of it yet. It may still be landing.' }}
        rechecking={false}
        checks={1}
        {...props}
      />,
    );
    expect(line).toHaveTextContent('Check 1: The network has no record of it yet. It may still be landing.');
    // The same answer twice still reads as a new answer.
    view.rerender(
      <TxOutcomeCard
        outcome={{ status: 'unknown', signature: SIG, message: 'The network has no record of it yet. It may still be landing.' }}
        rechecking={false}
        checks={2}
        {...props}
      />,
    );
    expect(line).toHaveTextContent('Check 2: The network has no record of it yet.');
    // The alert (what this is, what not to do) is not the status line: it does not change per check.
    expect(screen.getByRole('alert')).not.toHaveTextContent(/Check 2/);
  });

  it('not sent at simulation: says the wallet was never asked, and nothing was charged', () => {
    outcome({ status: 'not-sent', stage: 'simulate', message: 'The curve cannot fill a trade this size.' });
    expect(screen.getByText(/did not ask your wallet to sign/)).toBeInTheDocument();
    expect(screen.getByText('Nothing was charged.')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The review: shows the values the prepared transaction carries.
// ---------------------------------------------------------------------------

function flowAt(api = fakeApi()) {
  return renderHook(() => useTxFlow(api, rpc));
}

describe('review', () => {
  it('shows the exact at-most spend, the floor, the fee split, the fees and the test run', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByText('You pay (at most)')).toBeInTheDocument();
    expect(screen.getAllByText('0.1 SOL').length).toBeGreaterThan(0);
    expect(screen.getByText('You receive at least')).toBeInTheDocument();
    expect(screen.getByText('3,000')).toBeInTheDocument(); // minTokensOut 3_000_000_000 at 6 decimals
    expect(screen.getByText("…creator's share")).toBeInTheDocument();
    expect(screen.getByText(/Test run passed/)).toBeInTheDocument();
    expect(screen.getByText('Test run: your SOL changes by')).toBeInTheDocument();
    expect(screen.getByText('One-time account rent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in wallet' })).not.toBeDisabled();
  });

  // F2: on a buy that fills the curve, "at most" is what the SIGNED instruction lets
  // the program take, never a smaller figure from the quote.
  it('a buy that fills the curve: "at most" is the signed maximum, and the typed amount is named', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    const s = buySummary();
    if (s.kind !== 'buy') throw new Error('kind');
    const filling = { ...s, fillsCurve: true, requestedLamports: 1_000_000_000n, maxLamportsIn: 50_000_000n, quote: { ...s.quote, lamportsIn: 40_000_000n, capped: true } };
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(filling) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByText('You pay (at most)').parentElement).toHaveTextContent('0.05 SOL');
    expect(screen.getByText(/This buy fills the curve/)).toHaveTextContent(/at most 0\.05 SOL of the 1 SOL you entered/);
  });

  it('says so when the priority fee could not be read, instead of showing 0', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    const p = prepared(buySummary(), {
      fees: { baseLamports: 5_000n, priorityLamports: 0n, priorityFeeRead: false, newAccountRentLamports: 0n },
    });
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: p })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByText('none added')).toBeInTheDocument();
    expect(screen.getByText(/fee level could not be read/)).toBeInTheDocument();
  });

  // F2: the program folds the creator's share into the platform's when the creator's
  // wallet would sit below rent, so the platform's figure is not a ceiling.
  it('shows the fee split as scheduled shares, never the platform share as an "at most"', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.queryByText(/to the platform \(at most\)/)).not.toBeInTheDocument();
    expect(screen.getByText("…platform's share")).toBeInTheDocument();
    expect(screen.getByText(/that share goes to the platform instead/)).toBeInTheDocument();
  });

  // L3: the create rent line leaves out the token details' rent and fee; it must say so.
  it('create: the rent line says the token details are not in it, and the test run is the whole cost', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    const create: TxSummary = {
      kind: 'create', mint: CREATOR, creator: CREATOR, name: 'A', symbol: 'AB', uri: 'https://x', decimals: 6, openingBuy: null,
      platformReserve: null, treasuryAccountRent: 1_488_440n, plant: PLANT_SUMMARY,
    };
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(create) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.queryByText('One-time account rent')).not.toBeInTheDocument();
    expect(screen.getByText(/token details account.s rent and the token details program.s own fee are not in that line/)).toBeInTheDocument();
  });

  // Reserve at create (2026-09-26): the review says the reserve is paid in this very
  // transaction, to whom (a multisig only for the known vault), what the treasury's
  // token account costs the creator, and what the test run saw arrive there.
  it('create: the platform reserve paid now, its receiver, the treasury account rent, and the test run', async () => {
    const { PLATFORM_TREASURY_VAULT } = await import('../../../lib/launcher/solana/curve');
    const api = fakeApi();
    const { result } = flowAt(api);
    // A stand-in address: deriving the real one needs PDA maths, which fails under jsdom.
    const treasuryToken = KEY(12);
    const create: TxSummary = {
      kind: 'create', mint: CREATOR, creator: CREATOR, name: 'A', symbol: 'AB', uri: 'https://x', decimals: 6, openingBuy: null,
      platformReserve: { amount: 36_900_000_000_000n, bps: 369n, recipient: PLATFORM_TREASURY_VAULT, treasuryToken },
      treasuryAccountRent: 1_488_440n,
      plant: PLANT_SUMMARY,
    };
    const p = prepared(create, {
      simulated: {
        signerLamportsDelta: -5_000_000n,
        tokenDeltas: [{ mint: CREATOR, account: treasuryToken, delta: 36_900_000_000_000n, role: 'treasury' }],
      },
    });
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: p })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    const row = (label: string) => screen.getByText(label).parentElement!;
    expect(row('Platform reserve, paid in this transaction')).toHaveTextContent('36,900,000 (3.69% of the supply)');
    expect(row('Sent to (platform treasury)')).toHaveTextContent(PLATFORM_TREASURY_VAULT.toBase58());
    expect(row('Into its token account')).toHaveTextContent(treasuryToken.toBase58());
    expect(row('You pay for that token account')).toHaveTextContent('0.00148844 SOL (rent, read from the network just now)');
    expect(screen.getByText(/sent to the platform treasury \(a multisig\)\./)).toHaveTextContent(
      /does not stop the treasury selling those tokens, including while the curve is live/,
    );
    // Not yours: never "your tokens change by".
    expect(row('Test run: the platform treasury receives')).toHaveTextContent('+36,900,000');
    expect(screen.queryByText('Test run: your tokens change by')).not.toBeInTheDocument();
  });

  // The plant (island ruling 2), from the prepared transaction: what it pays, where each
  // half goes, the account it spends from, and what the test run saw move. In $BAYLA's
  // own 6 decimals, whatever the launch token's decimals are.
  it('create: the plant paid in this transaction, after the reserve, and its test run', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    const treasuryToken = KEY(12);
    const create: TxSummary = {
      kind: 'create', mint: CREATOR, creator: CREATOR, name: 'A', symbol: 'AB', uri: 'https://x', decimals: 6, openingBuy: null,
      platformReserve: { amount: 36_900_000_000_000n, bps: 369n, recipient: KEY(4), treasuryToken },
      treasuryAccountRent: 1_488_440n,
      plant: PLANT_SUMMARY,
    };
    const p = prepared(create, {
      simulated: {
        signerLamportsDelta: -5_000_000n,
        tokenDeltas: [
          { mint: CREATOR, account: treasuryToken, delta: 36_900_000_000_000n, role: 'treasury' },
          { mint: PLANT_SUMMARY.mint, account: PLANT_SUMMARY.from, delta: -100_000_000_000n },
          { mint: PLANT_SUMMARY.mint, account: PLANT_SUMMARY.workshopAccount, delta: 50_000_000_000n, role: 'workshop' },
        ],
      },
    });
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: p })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={9} signer={signer} />);
    const row = (label: string) => screen.getByText(label).parentElement!;
    const text = (label: string) => row(label).textContent?.replace(/\s+/g, ' ').trim();
    expect(text('Plant, in this transaction')).toBe('Plant, in this transaction100,000 $BAYLA');
    expect(text('Burned')).toBe('Burned50,000 $BAYLA');
    expect(text("To the island's Workshop")).toBe("To the island's Workshop50,000 $BAYLA");
    expect(row('Into its $BAYLA account')).toHaveTextContent(PLANT_SUMMARY.workshopAccount.toBase58());
    expect(row('From your $BAYLA account')).toHaveTextContent(PLANT_SUMMARY.from.toBase58());
    // The addresses are whole, in mono, and wrap on a phone.
    const workshop = screen.getByText(PLANT_SUMMARY.workshopAccount.toBase58());
    expect(workshop).toHaveClass('font-mono', 'break-all');
    // Right after the reserve rows: the reserve's last row comes before the plant's first.
    const reserveRow = row('You pay for that token account');
    expect(reserveRow.compareDocumentPosition(row('Plant, in this transaction')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The test run, in plain words for each role.
    expect(text('Test run: your $BAYLA changes by')).toBe('Test run: your $BAYLA changes by-100,000');
    expect(text("Test run: the island's Workshop receives")).toBe("Test run: the island's Workshop receives+50,000 $BAYLA");
    expect(row('Test run: the platform treasury receives')).toHaveTextContent('+36,900,000');
    expect(screen.queryByText('Test run: your tokens change by')).not.toBeInTheDocument();
    const review = document.body.textContent ?? '';
    expect(review).not.toMatch(/island coin|born in \$?BAYLA/i);
    expect(review).not.toContain(String.fromCharCode(0x2014));
  });

  it("create: the launch token's own change keeps its label, and $BAYLA is always read in 6 decimals", () => {
    const create: TxSummary = {
      kind: 'create', mint: MINT_X, creator: CREATOR, name: 'A', symbol: 'AB', uri: 'https://x', decimals: 6, openingBuy: null,
      platformReserve: null, treasuryAccountRent: 0n, plant: PLANT_SUMMARY,
    };
    const p = prepared(create, {
      simulated: {
        signerLamportsDelta: -5_000_000n,
        tokenDeltas: [
          { mint: MINT_X, account: KEY(14), delta: 3_500_000_000n },
          { mint: PLANT_SUMMARY.mint, account: PLANT_SUMMARY.from, delta: -100_000_000_000n },
        ],
      },
    });
    // The launch token's decimals unread: its own change shows in base units, $BAYLA's never does.
    render(<FeeRows prepared={p} decimals={null} />);
    expect(screen.getByText('Test run: your tokens change by').parentElement).toHaveTextContent('+3500000000 (base units)');
    expect(screen.getByText('Test run: your $BAYLA changes by').parentElement).toHaveTextContent(/^Test run: your \$BAYLA changes by-100,000$/);
  });

  // F3: graduation's rent is paid back inside the same instruction.
  it('migrate: does not call the refunded rent a cost', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    const p = prepared(
      { kind: 'migrate', mint: CREATOR, pool: CREATOR },
      { fees: { baseLamports: 5_000n, priorityLamports: 0n, priorityFeeRead: true, newAccountRentLamports: 0n } },
    );
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: p })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.queryByText(/One-time account rent/)).not.toBeInTheDocument();
    expect(screen.getByText(/paid\s+back to you inside the same transaction/)).toBeInTheDocument();
  });

  // UX2: a pool trade shows the fee it pays as an amount.
  it('pool buy: shows the pool fee amount', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    const quote = {
      poolAddress: CREATOR.toBase58(), outAmount: 900n, reserveIn: 1n, reserveOut: 1n, priceImpact: 0.01, creatorFeeOnInput: true,
      result: { outputAmount: 900n, tradeFee: 2_500_000n, protocolFee: 300_000n, fundFee: 0n, creatorFee: 0n, newInputVaultAmount: 0n, newOutputVaultAmount: 0n },
    };
    const pool: TxSummary = { kind: 'pool-buy', mint: CREATOR, pool: CREATOR, amountIn: SOL_1, minimumAmountOut: 800n, quote, unwrapsWsol: true };
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(pool) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByText('Pool fee (inside what you pay)').parentElement).toHaveTextContent('0.0025 SOL');
  });

  // F3: the review showed "0.00%" for an impact it could not compute, and warned at no size.
  it('price impact on the review: "could not compute" when unknown, and a warning when large', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    const s = buySummary();
    if (s.kind !== 'buy') throw new Error('kind');
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared({ ...s, priceImpactBps: null }) })));
    const view = render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByText('Price impact').parentElement).toHaveTextContent('could not compute');
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared({ ...s, priceImpactBps: 1_600n }) })));
    view.rerender(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByText(/This trade moves the price by 16\.00%\. You get far less/)).toBeInTheDocument();
  });

  // F13: the compute-unit count means nothing to a buyer.
  it('the test-run line is plain words, with no compute-unit count', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByText(/Test run passed/)).not.toHaveTextContent(/compute|61,234/);
  });

  it('cannot be signed without a wallet that signs', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={null} />);
    expect(screen.getByRole('button', { name: 'Sign in wallet' })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Screen readers and keyboard focus (F8/UX4). The flow replaces the panel's form,
// so the Review button that had focus is gone: each step takes focus, and says
// what it is.
// ---------------------------------------------------------------------------

describe('announced and focused', () => {
  it('building is a status that takes focus', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    let finish: (v: { ok: true; prepared: ReturnType<typeof prepared> }) => void = () => undefined;
    void act(() => {
      void result.current.prepare(() => new Promise((r) => (finish = r)));
    });
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/Building the transaction/);
    expect(document.activeElement).toBe(status);
    await act(async () => finish({ ok: true, prepared: prepared(buySummary()) }));
  });

  it('the review takes focus on its heading', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Review your buy' }));
  });

  it('an outcome that needs attention is an alert and takes focus; done is a status', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() =>
      result.current.prepare(async () => ({ ok: false, outcome: { status: 'not-sent', stage: 'simulate', message: 'x' } })),
    );
    const view = render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Not sent/);
    expect(document.activeElement).toBe(alert);
    view.unmount();
    outcome({ status: 'confirmed', signature: SIG, slot: 1 });
    expect(screen.getByRole('status')).toHaveTextContent(/Done\. The network confirmed it/);
  });
});

// ---------------------------------------------------------------------------
// The machine.
// ---------------------------------------------------------------------------

describe('useTxFlow', () => {
  // Mainnet on 2026-10-03: 219 to 228 slots a minute (getRecentPerformanceSamples) and 114
  // blocks in 30.6 seconds. A blockhash lasts 150 blocks: about 40 seconds, not a minute.
  it('the review clock runs out while the blockhash still has its signing margin', () => {
    const BLOCK_MS = 268;
    const BLOCKHASH_BLOCKS = 150;
    expect(REVIEW_TTL_MS / BLOCK_MS + SIGN_MARGIN_BLOCKS).toBeLessThanOrEqual(BLOCKHASH_BLOCKS);
  });

  it('a review goes stale when its clock runs out and can no longer be signed', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    expect(result.current.state).toMatchObject({ step: 'review', expired: false });
    act(() => {
      vi.advanceTimersByTime(REVIEW_TTL_MS + 1);
    });
    expect(result.current.state).toMatchObject({ step: 'review', expired: true });
    await act(() => result.current.confirm(signer));
    expect(api.submitPrepared).not.toHaveBeenCalled();
  });

  it('sends once, however many times Sign is pressed', async () => {
    let release: (o: TxOutcome) => void = () => undefined;
    const api = fakeApi({
      submitPrepared: vi.fn(() => new Promise<TxOutcome>((r) => (release = r))),
    });
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    const confirm = result.current.confirm;
    let p1: Promise<void> = Promise.resolve();
    act(() => {
      p1 = confirm(signer);
      void confirm(signer);
      void confirm(signer);
    });
    await act(async () => {
      // confirm() reads the block height before it hands anything to the wallet.
      await vi.waitFor(() => expect(api.submitPrepared).toHaveBeenCalled());
      release({ status: 'confirmed', signature: SIG, slot: 1 });
      await p1;
    });
    expect(api.submitPrepared).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({ step: 'outcome', outcome: { status: 'confirmed' } });
  });

  it('a submit that throws becomes unknown with no signature, never failed', async () => {
    const api = fakeApi({ submitPrepared: vi.fn(async () => Promise.reject(new Error('socket closed'))) });
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    await act(() => result.current.confirm(signer));
    expect(result.current.state).toMatchObject({ step: 'outcome', outcome: { status: 'unknown', signature: '' } });
  });

  it('a prepare that throws is not-sent, because nothing was signed', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => Promise.reject(new Error('boom'))));
    expect(result.current.state).toMatchObject({ step: 'outcome', outcome: { status: 'not-sent', stage: 'build' } });
  });

  // F1: a refusal is often "the price moved". The page must read the chain again, or
  // "Get a new quote" re-uses the same stale one.
  it('a refused or throwing prepare tells the page to read the chain again', async () => {
    const api = fakeApi();
    const settled = vi.fn();
    const { result } = renderHook(() => useTxFlow(api, rpc, settled));
    const refusal: TxOutcome = { status: 'not-sent', stage: 'simulate', message: 'The price moved past your limit.' };
    await act(() => result.current.prepare(async () => ({ ok: false, outcome: refusal })));
    expect(settled).toHaveBeenCalledWith(refusal, null);
    await act(() => result.current.prepare(async () => Promise.reject(new Error('boom'))));
    expect(settled).toHaveBeenCalledTimes(2);
    expect(settled.mock.calls[1]![0]).toMatchObject({ status: 'not-sent' });
    expect(settled.mock.calls[1]![1]).toBeNull();
  });

  it('locks while sent-but-unconfirmed, and Check again passes the blockhash window so it can say expired', async () => {
    const api = fakeApi({
      submitPrepared: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'slow' })),
      recheckOutcome: vi.fn(async () => ({ status: 'expired' as const, signature: SIG, message: '' })),
    });
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    await act(() => result.current.confirm(signer));
    expect(result.current.locked).toBe(true);
    await act(() => result.current.recheck());
    expect(api.recheckOutcome).toHaveBeenCalledWith(rpc, SIG, { lastValidBlockHeight: 1234 });
    expect(result.current.state).toMatchObject({ step: 'outcome', outcome: { status: 'expired' } });
    expect(result.current.locked).toBe(false);
  });

  // L4: the review's clock is the blockhash's, which starts while preparing.
  it('the review goes stale counted from when Review was pressed, not from when it appeared', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() =>
      result.current.prepare(async () => {
        vi.advanceTimersByTime(20_000); // the blockhash read, two test runs and the fee read
        return { ok: true, prepared: prepared(buySummary()) };
      }),
    );
    expect(result.current.state).toMatchObject({ step: 'review', expired: false });
    act(() => {
      vi.advanceTimersByTime(REVIEW_TTL_MS - 20_000 + 1);
    });
    expect(result.current.state).toMatchObject({ step: 'review', expired: true });
  });

  it('never asks the wallet to sign when the blockhash window is nearly over', async () => {
    const api = fakeApi({ submitPrepared: vi.fn(async () => ({ status: 'confirmed' as const, signature: SIG, slot: 1 })) });
    let height = 1234 - 5; // the fixture's lastValidBlockHeight is 1234
    const heightRpc = { getBlockHeight: vi.fn(async () => height) } as unknown as WriteRpc;
    const { result } = renderHook(() => useTxFlow(api, heightRpc));
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    await act(() => result.current.confirm(signer));
    expect(api.submitPrepared).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ step: 'review', expired: true });

    height = 1_000; // plenty of window left: it goes to the wallet
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    await act(() => result.current.confirm(signer));
    expect(api.submitPrepared).toHaveBeenCalledTimes(1);
  });

  // FS-1: the wait for the network (up to two minutes) had nothing saved and nothing
  // said: a reload in it brought back an open form while the first one could land.
  it('once the signature is known: the page is told BEFORE the wait, the step shows the signature, and leaving asks first', async () => {
    let release: (o: TxOutcome) => void = () => undefined;
    const api = fakeApi({
      submitPrepared: vi.fn((_r, _s, _p, deps) => {
        deps?.onSent?.(SIG, 1234);
        return new Promise<TxOutcome>((r) => (release = r));
      }),
    });
    const sent = vi.fn();
    const settled = vi.fn();
    const { result } = renderHook(() => useTxFlow(api, rpc, settled, sent));
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = result.current.confirm(signer);
      await vi.waitFor(() => expect(sent).toHaveBeenCalled());
    });
    expect(sent).toHaveBeenCalledWith(SIG, expect.objectContaining({ lastValidBlockHeight: 1234 }));
    expect(settled).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ step: 'sent', signature: SIG });
    const view = render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    const step = screen.getByTestId('tx-sent');
    expect(step).toHaveTextContent(SIG);
    expect(step).toHaveTextContent(/Sent\. Waiting for the network to confirm it/);
    expect(step).not.toHaveTextContent(/Waiting for your wallet/);
    expect(screen.getByRole('link', { name: /explorer/i })).toHaveAttribute('href', `https://explorer.test/tx/${SIG}`);
    expect(document.activeElement).toBe(step);
    // Reloading or closing the tab now asks first.
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
    await act(async () => {
      release({ status: 'confirmed', signature: SIG, slot: 1 });
      await done;
    });
    view.unmount();
    expect(settled).toHaveBeenCalledWith({ status: 'confirmed', signature: SIG, slot: 1 }, expect.anything(), SIG);
    // Settled: leaving no longer asks.
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('a submit that throws AFTER the signature was known keeps that signature, so it can still be checked', async () => {
    const api = fakeApi({
      submitPrepared: vi.fn(async (_r, _s, _p, deps) => {
        deps?.onSent?.(SIG, 1234);
        throw new Error('socket closed');
      }),
    });
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    await act(() => result.current.confirm(signer));
    expect(result.current.state).toMatchObject({ step: 'outcome', outcome: { status: 'unknown', signature: SIG } });
    expect(result.current.locked).toBe(true);
  });

  // UXR2: a stale review switched Sign off under the keyboard; focus fell to the page
  // and a screen reader heard nothing.
  it('a review going stale moves focus to an alert that says so', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    const view = render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    screen.getByRole('button', { name: 'Sign in wallet' }).focus();
    act(() => {
      vi.advanceTimersByTime(REVIEW_TTL_MS + 1);
    });
    view.rerender(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/too old to sign/);
    expect(document.activeElement).toBe(alert);
  });

  it('while the block height is read after Sign, a status line says so', async () => {
    let answer: (h: number) => void = () => undefined;
    const heightRpc = { getBlockHeight: vi.fn(() => new Promise<number>((r) => (answer = r))) } as unknown as WriteRpc;
    const api = fakeApi({ submitPrepared: vi.fn(async () => ({ status: 'confirmed' as const, signature: SIG, slot: 1 })) });
    const { result } = renderHook(() => useTxFlow(api, heightRpc));
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.confirm(signer);
    });
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking the network before your wallet opens…');
    await act(async () => {
      answer(1_000);
      await done;
    });
  });

  // UXR2: Check again was switched off while checking, dropping focus to the page.
  it('Check again keeps focus while it checks, and does nothing on a second press', async () => {
    let answer: (o: TxOutcome) => void = () => undefined;
    const api = fakeApi({
      submitPrepared: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'slow' })),
      recheckOutcome: vi.fn(() => new Promise<TxOutcome>((r) => (answer = r))),
    });
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    await act(() => result.current.confirm(signer));
    const view = render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    const btn = screen.getByRole('button', { name: 'Check again' });
    btn.focus();
    act(() => {
      fireEvent.click(btn);
    });
    view.rerender(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    const during = screen.getByRole('button', { name: 'Check again' });
    expect(during).not.toBeDisabled();
    expect(during).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(during);
    expect(screen.getByTestId('tx-check-result')).toHaveTextContent('Checking the network…');
    fireEvent.click(during);
    expect(api.recheckOutcome).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer({ status: 'unknown', signature: SIG, message: 'The network has no record of it yet. It may still be landing.' });
    });
    view.rerender(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByTestId('tx-check-result')).toHaveTextContent('Check 1: The network has no record of it yet.');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Check again' }));
  });

  it('renders Check again from the outcome and wires it to recheck', async () => {
    const api = fakeApi({
      submitPrepared: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'slow' })),
      recheckOutcome: vi.fn(async () => ({ status: 'confirmed' as const, signature: SIG, slot: 9 })),
    });
    const { result, rerender } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    await act(() => result.current.confirm(signer));
    const view = render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    });
    rerender();
    view.rerender(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByText(/Done\. The network confirmed it\./)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// A review left open past its blockhash. On a phone the review is two screens and a
// blockhash does not last long enough to read it, so Sign on a stale review builds it
// again on fresh reads: the same review goes to the wallet, a different one is shown first.
// ---------------------------------------------------------------------------

/** One of the transaction's own instructions (never compute budget), with its bytes. */
const ix = (data: number[], account: PublicKey = KEY(51)) =>
  new TransactionInstruction({
    programId: KEY(50),
    keys: [
      { pubkey: CREATOR, isSigner: true, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  });

function txOf(payer: PublicKey, ...ixs: TransactionInstruction[]): Transaction {
  const tx = new Transaction();
  tx.feePayer = payer;
  if (ixs.length) tx.add(...ixs);
  return tx;
}

type Buy = Extract<TxSummary, { kind: 'buy' }>;
const buyWith = (over: Partial<Buy>): TxSummary => ({ ...(buySummary() as Buy), ...over });

/** A transaction as prepared a second time: a newer blockhash, and whatever `over` changes. */
const again = (summary: TxSummary = buySummary(), over: Partial<PreparedTx> = {}) =>
  prepared(summary, { blockhash: '2'.repeat(32), lastValidBlockHeight: 5_000, ...over });

/** A build that answers with each prepared transaction in turn. */
function builds(...ps: PreparedTx[]) {
  const build = vi.fn<() => Promise<Prepared>>();
  for (const p of ps) build.mockResolvedValueOnce({ ok: true, prepared: p });
  return build;
}

const confirmedApi = (over: Partial<WriteApi> = {}) =>
  fakeApi({ submitPrepared: vi.fn(async () => ({ status: 'confirmed' as const, signature: SIG, slot: 1 })), ...over });

/** What each call handed the wallet. */
const signed = (api: WriteApi) => vi.mocked(api.submitPrepared).mock.calls.map((c) => c[2]);

const plain = (text: string): ReviewLine => ({ text, market: null });
const market = (key: string, text: string): ReviewLine => ({ text, market: key });

/** A buy review's lines, as the view hands them to the flow: enough to tell two apart. */
const lines = (p: PreparedTx): ReviewLine[] => {
  const s = p.summary;
  if (s.kind !== 'buy') throw new Error('kind');
  return [`You pay (at most): ${s.maxLamportsIn}`, `You receive at least: ${s.minTokensOut}`, `Priority fee: ${p.fees.priorityLamports}`].map(plain);
};

const pastItsClock = () =>
  act(() => {
    vi.advanceTimersByTime(REVIEW_TTL_MS + 1);
  });

describe('a review left open past its blockhash', () => {
  it('Sign builds it again and, when nothing changed, the wallet gets the FRESH transaction', async () => {
    vi.useFakeTimers();
    const fresh = again();
    const build = builds(prepared(buySummary()), fresh);
    const api = confirmedApi();
    const settled = vi.fn();
    const { result } = renderHook(() => useTxFlow(api, rpc, settled));
    await act(() => result.current.prepare(build, { repeatable: true }));
    pastItsClock();
    expect(result.current.state).toMatchObject({ step: 'review', expired: true, renewable: true });
    await act(() => result.current.confirm(signer, lines));
    expect(build).toHaveBeenCalledTimes(2);
    // The stale transaction never reaches the wallet: the one signed carries the newer blockhash.
    expect(signed(api)).toEqual([fresh]);
    expect(result.current.state).toMatchObject({ step: 'outcome', outcome: { status: 'confirmed' }, prepared: fresh });
    expect(settled).toHaveBeenCalledWith({ status: 'confirmed', signature: SIG, slot: 1 }, fresh, null);
  });

  it.each<[string, PreparedTx, string[], string[]]>([
    [
      'a lower minimum',
      again(buyWith({ minTokensOut: 2_900_000_000n }), { tx: txOf(CREATOR, ix([9])) }),
      ['You receive at least: 2900000000'],
      ['You receive at least: 3000000000'],
    ],
    [
      'the same instructions under a fee that reads differently',
      again(buySummary(), { fees: { baseLamports: 5_000n, priorityLamports: 90_000n, priorityFeeRead: true, newAccountRentLamports: 2_039_280n } }),
      ['Priority fee: 90000'],
      ['Priority fee: 12000'],
    ],
    ['different instructions under a review that reads the same', again(buySummary(), { tx: txOf(CREATOR, ix([9])) }), [], []],
    ['another wallet paying', again(buySummary(), { tx: txOf(KEY(60)) }), [], []],
  ])('built again with %s: the new review is shown with what reads differently, and nothing is signed unread', async (_what, fresh, now, gone) => {
    vi.useFakeTimers();
    const build = builds(prepared(buySummary()), fresh);
    const api = confirmedApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(build, { repeatable: true }));
    pastItsClock();
    await act(() => result.current.confirm(signer, lines));
    expect(api.submitPrepared).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ step: 'review', prepared: fresh, expired: false, renewable: true, replaced: { n: 1, now, gone } });
    // It is a review like any other now: one more press signs it, and only it.
    await act(() => result.current.confirm(signer, lines));
    expect(build).toHaveBeenCalledTimes(2);
    expect(signed(api)).toEqual([fresh]);
  });

  it.each<[string, ((p: PreparedTx) => ReviewLine[]) | undefined]>([
    ['is not given the review lines', undefined],
    [
      'cannot read the review lines',
      () => {
        throw new Error('no document');
      },
    ],
    // Two empty readings agree with each other and say nothing about the review.
    ['reads no lines at all', () => []],
  ])('a flow that %s never signs a rebuilt transaction unread', async (_what, read) => {
    vi.useFakeTimers();
    const fresh = again();
    const api = confirmedApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(builds(prepared(buySummary()), fresh), { repeatable: true }));
    pastItsClock();
    await act(() => result.current.confirm(signer, read));
    expect(api.submitPrepared).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ step: 'review', prepared: fresh, expired: false, replaced: { n: 1, now: [], gone: [] } });
  });

  it.each<[string, () => Promise<Prepared>, Partial<TxOutcome>]>([
    [
      'is refused',
      async () => ({ ok: false, outcome: { status: 'not-sent', stage: 'simulate', message: 'The price moved past your limit.' } }),
      { status: 'not-sent', stage: 'simulate', message: 'The price moved past your limit.' },
    ],
    ['throws', async () => Promise.reject(new Error('boom')), { status: 'not-sent', stage: 'build' }],
  ])('a second build that %s is not-sent: nothing is signed, and the page reads the chain again', async (_what, second, outcome) => {
    vi.useFakeTimers();
    const build = builds(prepared(buySummary())).mockImplementationOnce(second);
    const api = confirmedApi();
    const settled = vi.fn();
    const { result } = renderHook(() => useTxFlow(api, rpc, settled));
    await act(() => result.current.prepare(build, { repeatable: true }));
    pastItsClock();
    await act(() => result.current.confirm(signer, lines));
    expect(api.submitPrepared).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ step: 'outcome', outcome, prepared: null });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0]).toEqual([expect.objectContaining(outcome), null]);
  });

  // The launch: its build reads the door, asks the wallet for the upload and uploads.
  it('a build not marked repeatable is never run twice: its stale review still cannot be signed', async () => {
    vi.useFakeTimers();
    const build = builds(prepared(buySummary()), again());
    const api = confirmedApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(build));
    pastItsClock();
    expect(result.current.state).toMatchObject({ step: 'review', expired: true });
    expect(result.current.state).not.toMatchObject({ renewable: true });
    await act(() => result.current.confirm(signer, lines));
    expect(build).toHaveBeenCalledTimes(1);
    expect(api.submitPrepared).not.toHaveBeenCalled();
  });

  // The fixture's lastValidBlockHeight is 1234; a rebuilt one's is 5,000.
  const nearlyOver = () => ({ getBlockHeight: vi.fn(async () => 1234 - 5) }) as unknown as WriteRpc;

  it('a Sign press that finds the block window nearly over builds it again in the same press', async () => {
    const fresh = again();
    const build = builds(prepared(buySummary()), fresh);
    const api = confirmedApi();
    const heightRpc = nearlyOver();
    const { result } = renderHook(() => useTxFlow(api, heightRpc));
    await act(() => result.current.prepare(build, { repeatable: true }));
    await act(() => result.current.confirm(signer, lines));
    expect(build).toHaveBeenCalledTimes(2);
    expect(signed(api)).toEqual([fresh]);
  });

  it('a rebuilt transaction whose own window is nearly over is not signed, and that press does not build a third', async () => {
    const fresh = again(buySummary(), { lastValidBlockHeight: 1240 });
    const build = builds(prepared(buySummary()), fresh, again());
    const api = confirmedApi();
    const heightRpc = nearlyOver();
    const { result } = renderHook(() => useTxFlow(api, heightRpc));
    await act(() => result.current.prepare(build, { repeatable: true }));
    await act(() => result.current.confirm(signer, lines));
    expect(build).toHaveBeenCalledTimes(2);
    expect(api.submitPrepared).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ step: 'review', prepared: fresh, expired: true, renewable: true });
    expect(result.current.state).not.toHaveProperty('replaced');
  });

  it('a rebuild that outlasts the review clock is not signed', async () => {
    vi.useFakeTimers();
    const fresh = again();
    const build = builds(prepared(buySummary())).mockImplementationOnce(async () => {
      vi.advanceTimersByTime(REVIEW_TTL_MS); // a build that hung on the network
      return { ok: true, prepared: fresh };
    });
    const api = confirmedApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(build, { repeatable: true }));
    pastItsClock();
    await act(() => result.current.confirm(signer, lines));
    expect(api.submitPrepared).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ step: 'review', prepared: fresh, expired: true });
  });

  it('Start over while it is built again abandons the press: the wallet is never asked, and the flow is free', async () => {
    vi.useFakeTimers();
    let finish: (r: Prepared) => void = () => undefined;
    const build = builds(prepared(buySummary())).mockImplementationOnce(() => new Promise<Prepared>((r) => (finish = r)));
    const api = confirmedApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(build, { repeatable: true }));
    pastItsClock();
    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = result.current.confirm(signer, lines);
    });
    expect(result.current.state).toMatchObject({ step: 'review', expired: true, renewing: true });
    act(() => result.current.reset());
    expect(result.current.state).toEqual({ step: 'idle' });
    await act(async () => {
      finish({ ok: true, prepared: again() });
      await done;
    });
    expect(api.submitPrepared).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ step: 'idle' });
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    expect(result.current.state).toMatchObject({ step: 'review', expired: false });
  });

  it.each<[string, Prepared]>([
    ['a refusal', { ok: false, outcome: { status: 'not-sent', stage: 'simulate', message: 'The price moved past your limit.' } }],
    ['a review that changed', { ok: true, prepared: again(buyWith({ minTokensOut: 2_900_000_000n }), { tx: txOf(CREATOR, ix([9])) }) }],
  ])('Start over, then the abandoned build answers with %s: the flow stays closed and the page is told nothing', async (_what, answer) => {
    vi.useFakeTimers();
    let finish: (r: Prepared) => void = () => undefined;
    const build = builds(prepared(buySummary())).mockImplementationOnce(() => new Promise<Prepared>((r) => (finish = r)));
    const api = confirmedApi();
    const settled = vi.fn();
    const { result } = renderHook(() => useTxFlow(api, rpc, settled));
    await act(() => result.current.prepare(build, { repeatable: true }));
    pastItsClock();
    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = result.current.confirm(signer, lines);
    });
    act(() => result.current.reset());
    await act(async () => {
      finish(answer);
      await done;
    });
    expect(result.current.state).toEqual({ step: 'idle' });
    expect(settled).not.toHaveBeenCalled();
    expect(api.submitPrepared).not.toHaveBeenCalled();
  });

  it('Start over while the rebuilt transaction waits on the block height: the wallet is never asked', async () => {
    vi.useFakeTimers();
    let answer: (h: number) => void = () => undefined;
    const heightRpc = { getBlockHeight: vi.fn(() => new Promise<number>((r) => (answer = r))) } as unknown as WriteRpc;
    const api = confirmedApi();
    const { result } = renderHook(() => useTxFlow(api, heightRpc));
    await act(() => result.current.prepare(builds(prepared(buySummary()), again()), { repeatable: true }));
    pastItsClock();
    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = result.current.confirm(signer, lines);
    });
    expect(heightRpc.getBlockHeight).toHaveBeenCalledTimes(1);
    act(() => result.current.reset());
    await act(async () => {
      answer(1_000);
      await done;
    });
    expect(api.submitPrepared).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ step: 'idle' });
  });

  it('leaving the page while it is built again abandons the press: no wallet prompt for a review nobody is reading', async () => {
    vi.useFakeTimers();
    let finish: (r: Prepared) => void = () => undefined;
    const build = builds(prepared(buySummary())).mockImplementationOnce(() => new Promise<Prepared>((r) => (finish = r)));
    const api = confirmedApi();
    const { result, unmount } = flowAt(api);
    await act(() => result.current.prepare(build, { repeatable: true }));
    pastItsClock();
    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = result.current.confirm(signer, lines);
    });
    unmount();
    await act(async () => {
      finish({ ok: true, prepared: again() });
      await done;
    });
    expect(api.submitPrepared).not.toHaveBeenCalled();
  });

  // A line read from the market just now (a price check, its cost, a warning restating
  // them) reads differently on nearly every build of a live pool while the transaction is
  // the same. It may move or go and the press goes on to the wallet; one that is new stops it.
  describe('lines read from the market', () => {
    const PRICE = (pct: string) => market('price', `Price check: ${pct}% above the outside price (Jupiter), read just now`);
    const GAP = (sol: string) => market('gap', `Estimated cost of that gap: up to about ${sol} SOL of what you put in`);
    const texts = (ls: ReviewLine[]) => ls.map((l) => l.text);
    /** The buy's own lines, then `first`'s market lines on the review read and `then`'s on the fresh one. */
    const reading = (read: PreparedTx, first: ReviewLine[], fresh: PreparedTx, then: ReviewLine[]) => (p: PreparedTx) => [
      ...lines(p),
      ...(p === read ? first : p === fresh ? then : []),
    ];
    /** Sign on the stale review, until the press ends or the wallet is asked (and keeps it). */
    const pressStale = async (read: PreparedTx, fresh: PreparedTx, lineOf: (p: PreparedTx) => ReviewLine[]) => {
      vi.useFakeTimers();
      let asked: () => void = () => undefined;
      const reached = new Promise<void>((r) => (asked = r));
      const api = fakeApi({
        submitPrepared: vi.fn(() => {
          asked();
          return new Promise<TxOutcome>(() => undefined);
        }),
      });
      const { result } = flowAt(api);
      await act(() => result.current.prepare(builds(read, fresh), { repeatable: true }));
      pastItsClock();
      await act(async () => {
        await Promise.race([result.current.confirm(signer, lineOf), reached]);
      });
      return { api, result };
    };

    it.each<[string, ReviewLine[], ReviewLine[]]>([
      ['a price and its cost that moved', [PRICE('7.2'), GAP('0.001170414')], [PRICE('7.3'), GAP('0.001183002')]],
      ['a price back within 3%, its cost gone', [PRICE('3.4'), GAP('0.000412')], [PRICE('1.2')]],
    ])('%s: the wallet gets the fresh transaction in the same press, and what moved rides with it', async (_what, first, then) => {
      const read = prepared(buySummary());
      const fresh = again();
      const { api, result } = await pressStale(read, fresh, reading(read, first, fresh, then));
      expect(signed(api)).toEqual([fresh]);
      const left = texts(first).filter((t) => !texts(then).includes(t));
      expect(result.current.state).toMatchObject({ step: 'submitting', prepared: fresh, moved: { now: texts(then), gone: left } });
    });

    it('nothing moved: the wallet gets the fresh transaction and nothing rides with it', async () => {
      const read = prepared(buySummary());
      const fresh = again();
      const { api, result } = await pressStale(read, fresh, reading(read, [PRICE('7.2')], fresh, [PRICE('7.2')]));
      expect(signed(api)).toEqual([fresh]);
      expect(result.current.state).toEqual({ step: 'submitting', prepared: fresh });
    });

    it.each<[string, PreparedTx, ReviewLine[], string[], string[]]>([
      ['a price line that is new: the cost of a gap the reader never saw', again(), [PRICE('7.3'), GAP('0.001183002')], [GAP('0.001183002').text, PRICE('7.3').text], [PRICE('1.2').text]],
      [
        'a moved price beside a minimum that moved',
        again(buyWith({ minTokensOut: 2_900_000_000n })),
        [PRICE('1.3')],
        ['You receive at least: 2900000000', PRICE('1.3').text],
        ['You receive at least: 3000000000', PRICE('1.2').text],
      ],
    ])('%s: the new review is shown with every line that reads differently, and nothing is signed unread', async (_what, fresh, then, now, gone) => {
      const read = prepared(buySummary());
      const { api, result } = await pressStale(read, fresh, reading(read, [PRICE('1.2')], fresh, then));
      expect(api.submitPrepared).not.toHaveBeenCalled();
      const state = result.current.state;
      expect(state).toMatchObject({ step: 'review', prepared: fresh, expired: false });
      expect(state.step === 'review' && state.replaced).toBeTruthy();
      if (state.step !== 'review' || !state.replaced) return;
      expect([...state.replaced.now].sort()).toEqual([...now].sort());
      expect([...state.replaced.gone].sort()).toEqual([...gone].sort());
    });
  });

  it('builds again once and sends once, however many times Sign is pressed on a stale review', async () => {
    vi.useFakeTimers();
    const fresh = again();
    const build = builds(prepared(buySummary()), fresh, again());
    const api = confirmedApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(build, { repeatable: true }));
    pastItsClock();
    const confirm = result.current.confirm;
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = confirm(signer, lines);
      void confirm(signer, lines);
      void confirm(signer, lines);
      await first;
    });
    expect(build).toHaveBeenCalledTimes(2);
    expect(signed(api)).toEqual([fresh]);
  });
});

// The same, through the button a visitor presses and the review they read.
function Flow({ api, build }: { api: WriteApi; build: () => Promise<Prepared> }) {
  const flow = useTxFlow(api, rpc);
  return (
    <>
      <button type="button" onClick={() => void flow.prepare(build, { repeatable: true })}>
        Review
      </button>
      <TxFlowView flow={flow} api={api} cluster="localnet" decimals={6} signer={signer} />
    </>
  );
}

/** What the line above Sign in wallet says on a review that can be built again, whatever its age. */
const TAKE_YOUR_TIME =
  'Your wallet will show this transaction next. Sign only if it matches what is above. Take your time: once it has been open a while, Sign in wallet builds it again on fresh numbers first, and your wallet opens in the same press if every line about the transaction reads the same.';

/**
 * A deposit to a pool `pct`% above Jupiter, the gap estimated to cost `loss` lamports, with
 * the builder's own two warnings, which restate the price check and its cost.
 */
function depositOff(pct: string, loss: bigint, over: Partial<Extract<TxSummary, { kind: 'lp-deposit' }>> = {}): TxSummary {
  const diff = Number(pct) / 100;
  const said = [
    `Its price is ${pct}% above the outside price. A deposit here would hand that gap to the first arbitrage trade.`,
    `At these amounts, a move back to the outside price would take up to about ${(Number(loss) / 1e9).toFixed(9).replace(/0+$/, '')} SOL of what you put in. That is an estimate.`,
  ];
  return lpDepositSummary(KEY(30), KEY(31), {
    price: { state: 'disagrees', pool: 0.01 * (1 + diff), reference: 0.01, against: 'outside', diff },
    priceGap: { diff, lossQuote: loss },
    warnings: said,
    marketWarnings: said,
    ...over,
  });
}

describe('the stale review on screen', () => {
  const openStale = async (api: WriteApi, build: () => Promise<Prepared>) => {
    vi.useFakeTimers();
    render(<Flow api={api} build={build} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    });
    const sign = screen.getByRole('button', { name: 'Sign in wallet' });
    sign.focus();
    pastItsClock();
    return sign;
  };

  // A holder on a phone read an add-liquidity review through, as it asks, and every press
  // was met with "too old to sign" (2026-10-06). The time a reader takes is never a failure.
  it('keeps Sign in wallet on, and its clock running out changes nothing on screen: the same quiet line, no alert, focus where it was', async () => {
    vi.useFakeTimers();
    render(<Flow api={fakeApi()} build={builds(prepared(buySummary()))} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    });
    const sign = screen.getByRole('button', { name: 'Sign in wallet' });
    sign.focus();
    expect(screen.getByRole('status').textContent).toBe(TAKE_YOUR_TIME);
    pastItsClock();
    expect(sign).toBeEnabled();
    expect(sign).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toBe(TAKE_YOUR_TIME);
    expect(screen.getByRole('status')).not.toHaveClass('text-amber-300/90');
    expect(screen.queryByText(/too old/)).not.toBeInTheDocument();
    expect(document.activeElement).toBe(sign);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('a review with a price read just now says so in the same line, before and after its clock', async () => {
    vi.useFakeTimers();
    render(<Flow api={fakeApi()} build={builds(prepared(depositOff('7.2', 1_170_414n)))} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    });
    const line = `${TAKE_YOUR_TIME} A price read just now may have moved by then. That is shown, and does not stop you.`;
    expect(screen.getByRole('status').textContent).toBe(line);
    pastItsClock();
    expect(screen.getByRole('status').textContent).toBe(line);
  });

  it('Sign in wallet opens the wallet with the fresh transaction when every line reads the same', async () => {
    const fresh = again();
    const api = confirmedApi();
    const sign = await openStale(api, builds(prepared(buySummary()), fresh));
    await act(async () => {
      fireEvent.click(sign);
      await vi.waitFor(() => expect(api.submitPrepared).toHaveBeenCalled());
    });
    expect(signed(api)).toEqual([fresh]);
    expect(screen.getByText(/Done\. The network confirmed it\./)).toBeInTheDocument();
  });

  it('while it is built again, a status line says so and Sign in wallet keeps focus without acting twice', async () => {
    let finish: (r: Prepared) => void = () => undefined;
    const build = builds(prepared(buySummary())).mockImplementationOnce(() => new Promise<Prepared>((r) => (finish = r)));
    const api = confirmedApi();
    const sign = await openStale(api, build);
    await act(async () => {
      fireEvent.click(sign);
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Building this again on fresh numbers and test-running it. Your wallet opens next if every line about the transaction reads the same.',
    );
    expect(sign).not.toBeDisabled();
    expect(sign).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(sign);
    fireEvent.click(sign);
    expect(build).toHaveBeenCalledTimes(2);
    await act(async () => {
      finish({ ok: true, prepared: again() });
      await vi.waitFor(() => expect(api.submitPrepared).toHaveBeenCalled());
    });
  });

  it('a review that changed lists the lines that read differently beside Sign in wallet, takes focus there, and one more press signs it', async () => {
    const fresh = again(buyWith({ minTokensOut: 2_900_000_000n }), { tx: txOf(CREATOR, ix([9])) });
    const api = confirmedApi();
    const sign = await openStale(api, builds(prepared(buySummary()), fresh));
    await act(async () => {
      fireEvent.click(sign);
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This review was built again on fresh numbers. 1 line reads differently now:');
    expect(alert).toHaveTextContent('You receive at least: 2,900');
    expect(alert).toHaveTextContent('In place of:');
    expect(alert).toHaveTextContent('You receive at least: 3,000');
    expect(alert).toHaveTextContent('Every other line reads as it did. Sign in wallet if this is still what you want.');
    expect(alert).not.toHaveTextContent('You pay (at most)');
    expect(document.activeElement).toBe(alert);
    // It sits with the buttons, after the review, so nobody scrolls back up to find it.
    expect(screen.getByTestId('tx-review').compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(api.submitPrepared).not.toHaveBeenCalled();
    // The review above is the new one, and it can be signed.
    expect(screen.getByText('You receive at least').nextElementSibling).toHaveTextContent('2,900');
    const signNew = screen.getByRole('button', { name: 'Sign in wallet' });
    expect(signNew).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(signNew);
      await vi.waitFor(() => expect(api.submitPrepared).toHaveBeenCalled());
    });
    expect(signed(api)).toEqual([fresh]);
  });

  // The holder's case (2026-10-06): a pool 7.2% above Jupiter. Every build read Jupiter
  // again, so the price row, its cost and the two warnings restating them never read the
  // same twice, and every press shut the wallet. They are the market's lines, not the
  // transaction's: what leaves the wallet, the shares and the fees read the same.
  it('a deposit to a pool off its outside price, built again: only the price lines moved, so one press opens the wallet, and the wait says what moved', async () => {
    let release: (o: TxOutcome) => void = () => undefined;
    const api = fakeApi({ submitPrepared: vi.fn(() => new Promise<TxOutcome>((r) => (release = r))) });
    const fresh = again(depositOff('7.3', 1_183_002n));
    const sign = await openStale(api, builds(prepared(depositOff('7.2', 1_170_414n)), fresh));
    await act(async () => {
      fireEvent.click(sign);
      await vi.waitFor(() => expect(api.submitPrepared).toHaveBeenCalled());
    });
    expect(signed(api)).toEqual([fresh]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const wait = screen.getByRole('status');
    expect(wait).toHaveTextContent('Waiting for your wallet. Approve the transaction there to send it.');
    const moved = within(wait).getByTestId('tx-market-moved');
    expect(moved).toHaveTextContent('The price was read again as you pressed Sign in wallet. These lines read differently now:');
    expect(moved).toHaveTextContent('Price check: 7.3% above the outside price (Jupiter), read just now. That is off by more than 3%.');
    expect(moved).toHaveTextContent('Estimated cost of that gap: up to about 0.001183002 SOL of what you put in');
    expect(moved).toHaveTextContent('Its price is 7.3% above the outside price.');
    expect(moved).toHaveTextContent('In place of:');
    expect(moved).toHaveTextContent('Price check: 7.2% above the outside price (Jupiter), read just now.');
    expect(moved).toHaveTextContent('Nothing else changed, and none of these stops you signing. If one changes your mind, reject it in your wallet.');
    expect(moved).not.toHaveTextContent('You put in');
    await act(async () => release({ status: 'confirmed', signature: SIG, slot: 1 }));
    expect(screen.getByText(/Done\. The network confirmed it\./)).toBeInTheDocument();
  });

  it('a deposit whose shares moved with its price is shown again, the shares among what reads differently, and is not signed', async () => {
    const api = confirmedApi();
    const sign = await openStale(api, builds(prepared(depositOff('7.2', 1_170_414n)), again(depositOff('7.3', 1_183_002n, { lpAmount: 990_000n }))));
    await act(async () => {
      fireEvent.click(sign);
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This review was built again on fresh numbers.');
    expect(alert).toHaveTextContent('You get: 0.00099 pool shares, exactly');
    expect(alert).toHaveTextContent('Price check: 7.3% above');
    expect(api.submitPrepared).not.toHaveBeenCalled();
  });

  // The price can move while a review is read. A deposit built again that now carries a
  // price warning the reader never saw is never signed in that press.
  it('a deposit built again with a price warning it did not have: the warning is listed as new, and nothing is signed unread', async () => {
    const NEW = 'Its price is 10.0% above the outside price. A deposit here would hand that gap to the first arbitrage trade.';
    const api = confirmedApi();
    const sign = await openStale(api, builds(prepared(lpDepositSummary(KEY(30), KEY(31))), again(depositOff('10.0', 2_000_000n))));
    await act(async () => {
      fireEvent.click(sign);
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This review was built again on fresh numbers.');
    expect(alert).toHaveTextContent('Read these warnings first.');
    expect(alert).toHaveTextContent(NEW);
    expect(alert).toHaveTextContent('Estimated cost of that gap: up to about 0.002 SOL of what you put in');
    expect(api.submitPrepared).not.toHaveBeenCalled();
    // The new review has the warning at its head.
    expect(within(screen.getByTestId('tx-review-warnings')).getByText(NEW)).toBeInTheDocument();
  });

  it('a deposit whose price came back within 3%: its price warnings go, and one press opens the wallet', async () => {
    const api = confirmedApi();
    const back = lpDepositSummary(KEY(30), KEY(31), { price: { state: 'agrees', pool: 0.01012, reference: 0.01, against: 'outside', diff: 0.012 } });
    const fresh = again(back);
    const sign = await openStale(api, builds(prepared(depositOff('3.4', 412_000n)), fresh));
    await act(async () => {
      fireEvent.click(sign);
      await vi.waitFor(() => expect(api.submitPrepared).toHaveBeenCalled());
    });
    expect(signed(api)).toEqual([fresh]);
  });

  it('different instructions under the same words: says to read it through again, and names no line', async () => {
    const api = confirmedApi();
    const sign = await openStale(api, builds(prepared(buySummary()), again(buySummary(), { tx: txOf(CREATOR, ix([9])) })));
    await act(async () => {
      fireEvent.click(sign);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /^This review was built again on fresh numbers, and this page cannot say it is the same as the one you were reading\. Read it through again before you sign\.$/,
    );
    expect(api.submitPrepared).not.toHaveBeenCalled();
  });
});

// What the flow compares is what a visitor reads: every piece of text on the review is
// in one of its lines, for every kind, so nothing on screen can change unseen.
describe('the review as lines', () => {
  it('a row is "label: value"; the heading and each notice are lines of their own', () => {
    const got = reviewLines(<TxReview prepared={prepared(buySummary())} decimals={6} display={(s) => s} />).map((l) => l.text);
    expect(got[0]).toBe('Review your buy');
    expect(got).toContain('You pay (at most): 0.1 SOL');
    expect(got).toContain('You receive at least: 3,000');
    expect(got).toContain('Test run passed: the network ran this exact transaction without sending it.');
  });

  const create: TxSummary = {
    kind: 'create', mint: MINT_X, creator: CREATOR, name: 'A', symbol: 'AB', uri: 'https://x', decimals: 6, openingBuy: null,
    platformReserve: { amount: 36_900_000_000_000n, bps: 369n, recipient: KEY(4), treasuryToken: KEY(12) },
    treasuryAccountRent: 1_488_440n, plant: PLANT_SUMMARY,
  };
  const withWarnings = { tokenWarnings: [{ code: 'mint-authority' as const, text: 'Its creator can still mint more.' }], notices: ['An approved spender can move tokens.'] };
  // What the builder says must be read before signing: a price that is off, and its cost.
  const SAID = ['Its price is 10.0% above the outside price.', 'At these amounts, a move back to the outside price would take up to about 0.002 SOL of what you put in. That is an estimate.'];
  const WARNINGS_HEAD = 'Read these warnings first. Nothing here stops you signing, and each one is a risk to what you put in:';
  const offPrice = {
    ...withWarnings,
    warnings: SAID,
    marketWarnings: SAID,
    priceGap: { diff: 0.1, lossQuote: 2_000_000n },
    price: { state: 'disagrees' as const, pool: 0.011, reference: 0.01, against: 'outside' as const, diff: 0.1 },
  };

  it.each<[string, TxSummary]>([
    ['buy', buySummary()],
    ['buy that fills the curve', buyWith({ fillsCurve: true, requestedLamports: SOL_1, priceImpactBps: 1_600n })],
    ['create', create],
    ['migrate', { kind: 'migrate', mint: CREATOR, pool: KEY(40) }],
    ['lp-deposit', lpDepositSummary(KEY(30), KEY(31), withWarnings)],
    ['lp-deposit with warnings', lpDepositSummary(KEY(30), KEY(31), offPrice)],
    ['lp-withdraw', lpWithdrawSummary(KEY(30), KEY(31), KEY(32), { all: true, notices: ['Swaps on this pool are switched off.'] })],
    ['lp-create', lpCreateSummary(KEY(30), KEY(31), { ...withWarnings, origin: 'other' })],
    ['lp-create with warnings', lpCreateSummary(KEY(30), KEY(31), { ...offPrice, origin: 'other' })],
    ['venue-swap', venueSwapSummary(KEY(30), KEY(31), { notices: ['Swaps on this pool open in 2 minutes.'] })],
  ])('%s: no text on the review is outside its lines', (_kind, summary) => {
    const p = prepared(summary, {
      simulated: { signerLamportsDelta: -SOL_1, tokenDeltas: [{ mint: KEY(20), account: KEY(21), delta: 2_500_000n, role: 'token' }] },
    });
    const review = <TxReview prepared={p} decimals={6} display={(s) => s} />;
    const got = reviewLines(review).map((l) => l.text);
    render(review);
    const walker = document.createTreeWalker(screen.getByTestId('tx-review'), NodeFilter.SHOW_TEXT);
    const texts: string[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.trim()) texts.push(n.textContent);
    expect(texts.length).toBeGreaterThan(8);
    for (const t of texts) expect(got.some((l) => l.includes(t)), t).toBe(true);
    expect(got.every((l) => l.trim() !== '')).toBe(true);
  });

  // The warnings are part of what is compared when a review is built again: a warning that
  // appears, goes or changes its figure is a line that reads differently, never a silent one.
  it.each<[string, TxSummary]>([
    ['lp-deposit', lpDepositSummary(KEY(30), KEY(31), offPrice)],
    ['lp-create', lpCreateSummary(KEY(30), KEY(31), offPrice)],
  ])('%s: each warning is a line of its own, right under the heading, and the cost is a row', (_kind, summary) => {
    const got = reviewLines(<TxReview prepared={prepared(summary)} decimals={6} display={(s) => s} />).map((l) => l.text);
    expect(got.slice(1, 4)).toEqual([WARNINGS_HEAD, ...SAID]);
    expect(got).toContain('Estimated cost of that gap: up to about 0.002 SOL of what you put in');
  });

  // A review built again may sign over a line read from the market that moved or went
  // (useTxFlow), so the review marks those lines and no other: a line wrongly marked could
  // change under the reader unseen.
  const COPY = 'It copies the name of a well-known token.';
  it.each<[string, TxSummary, string]>([
    ['lp-deposit', lpDepositSummary(KEY(30), KEY(31), offPrice), 'Price check: 10.0% above the outside price (Jupiter), read just now. That is off by more than 3%.'],
    ['lp-create', lpCreateSummary(KEY(30), KEY(31), offPrice), 'Opening price: 1 token = 0.011 SOL. Market (Jupiter, read just now): 0.01 SOL, 10.0% above. That is off by more than 3%.'],
  ])('%s: the price, its cost and the warnings restating them are marked as the market\'s, and nothing else is', (_kind, summary, priceLine) => {
    const marked = (s: TxSummary) => reviewLines(<TxReview prepared={prepared(s)} decimals={6} display={(t) => t} />).filter((l) => l.market !== null);
    expect(marked(summary)).toEqual([
      { text: WARNINGS_HEAD, market: 'warnings-head' },
      { text: SAID[0], market: 'warning' },
      { text: SAID[1], market: 'warning' },
      { text: priceLine, market: 'price' },
      { text: 'Estimated cost of that gap: up to about 0.002 SOL of what you put in', market: 'gap' },
    ]);
    // Beside a warning that is not the market's, the head of the list is not either: it stays while that warning does.
    const mixed = { ...summary, warnings: [COPY, ...SAID] } as TxSummary;
    expect(marked(mixed).map((l) => l.text)).toEqual([SAID[0], SAID[1], priceLine, 'Estimated cost of that gap: up to about 0.002 SOL of what you put in']);
  });

  it.each<[string, TxSummary]>([
    ['buy', buySummary()],
    ['lp-withdraw', lpWithdrawSummary(KEY(30), KEY(31), KEY(32))],
    // The swap page settled the venue before the review: nothing on it is Jupiter's, so a rebuild signs over nothing that moved.
    ['venue-swap', venueSwapSummary(KEY(30), KEY(31))],
  ])('%s: no line is the market\'s', (_kind, summary) => {
    expect(reviewLines(<TxReview prepared={prepared(summary)} decimals={6} display={(t) => t} />).filter((l) => l.market !== null)).toEqual([]);
  });
});

// D27: one transaction can move three different tokens. Each test-run line is named
// for what it is and printed in that token's own decimals, never the page's.
describe('test-run lines, by what each account is', () => {
  it('a wrapped-SOL change prints in 9 decimals while the token has 6; a pool-share change is labelled "your pool shares"', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    const p = prepared(buySummary(), {
      simulated: {
        signerLamportsDelta: -SOL_1,
        tokenDeltas: [
          { mint: KEY(20), account: KEY(21), delta: 2_500_000n, role: 'token' },
          { mint: KEY(22), account: KEY(23), delta: 1_500_000_000n, role: 'wsol', decimals: 9 },
          { mint: KEY(24), account: KEY(25), delta: -3_000_000_000n, role: 'lp', decimals: 9 },
        ],
      },
    });
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: p })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    const value = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
    expect(value('Test run: your tokens change by')).toBe('+2.5');
    expect(value('Test run: your wrapped SOL changes by')).toBe('+1.5');
    expect(value('Test run: your pool shares change by')).toBe('-3');
  });

  it('a change with no role is still "your tokens", in the page’s decimals', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    const p = prepared(buySummary(), {
      simulated: { signerLamportsDelta: -SOL_1, tokenDeltas: [{ mint: KEY(20), account: KEY(21), delta: 2_500_000n }] },
    });
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: p })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByText('Test run: your tokens change by').nextElementSibling?.textContent).toBe('+2.5');
  });
});

// D27: the 44px tap-target rule in index.css applies only below 768px, so an iPad
// (820px) got short buttons. Every button here carries the minimum itself.
describe('every button is at least 44px tall at every width', () => {
  const MIN_44 = /(^|\s)min-h-\[44px\](\s|$)/;
  const allTall = () => {
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.className, b.textContent ?? '').toMatch(MIN_44);
  };

  it('Sign and Cancel are at least 44px tall at 820px (class assertion)', async () => {
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByRole('button', { name: 'Sign in wallet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    allTall();
  });

  it('every outcome card button, in every state', () => {
    const states: TxOutcome[] = [
      { status: 'confirmed', signature: SIG, slot: 9 },
      { status: 'reverted', signature: SIG, program: 'cp-swap', code: 6005, message: 'moved' },
      { status: 'expired', signature: SIG, message: 'gone' },
      { status: 'unknown', signature: SIG, message: 'slow' },
      { status: 'unknown', signature: '', message: 'lost' },
      { status: 'not-sent', stage: 'build', message: 'no' },
    ];
    for (const o of states) {
      const view = outcome(o);
      allTall();
      view.unmount();
    }
  });
});

// Spec 4.5: adding and removing liquidity. Every row comes from the prepared
// transaction's summary (the maxima and minima were decoded from its bytes), so each
// value below is one the summary carries and no form could have supplied.
describe('liquidity reviews', () => {
  const config = {
    address: KEY(6).toBase58(), index: 1, disableCreatePool: false, tradeFeeRate: 2_500n, protocolFeeRate: 120_000n,
    fundFeeRate: 0n, createPoolFee: 0n, creatorFeeRate: 0n, protocolOwner: KEY(7).toBase58(), fundOwner: KEY(7).toBase58(),
  };
  const deposit = (over: Partial<Extract<TxSummary, { kind: 'lp-deposit' }>> = {}): TxSummary => ({
    kind: 'lp-deposit', pool: KEY(30), origin: 'standard', config, enableCreatorFee: false, tokenMint: KEY(31), tokenDecimals: 6, quote: SOL_QUOTE, quoteIsToken0: true,
    lpAmount: 123_456_789_012n, lpDecimals: 9,
    quoted: { quote: 2_000_000_000n, token: 5_000_000n }, max: { quote: 2_020_000_001n, token: 5_050_001n },
    limitedByBalance: 'none', sharePct: { before: 0, after: 12.5 },
    price: { state: 'agrees', pool: 1, reference: 1, against: 'outside', diff: -0.012 },
    tokenWarnings: [{ code: 'mint-authority', text: 'Its creator can still mint more.' }],
    unwrapsWsol: true, wsolHeldBefore: 0n, notices: ['An approved spender can move tokens.'], warnings: [], marketWarnings: [], priceGap: null, ...over,
  });
  const withdraw = (over: Partial<Extract<TxSummary, { kind: 'lp-withdraw' }>> = {}): TxSummary => ({
    kind: 'lp-withdraw', pool: KEY(30), origin: 'launch-pool', config: null, tokenMint: KEY(31), tokenDecimals: 6, quote: SOL_QUOTE, quoteIsToken0: true,
    lpAccount: KEY(32), lpAmount: 250_000_000n, lpDecimals: 9, heldBefore: 1_000_000_000n, all: false, keep: 750_000_000n,
    quoted: { quote: 1_000_000_000n, token: 3_000_000n }, min: { quote: 990_000_001n, token: 2_970_001n },
    tokenAccount: KEY(33), tokenAccountRent: 2_074_080n, quoteAccount: null, unwrapsWsol: false, notices: ['Swaps on this pool are switched off.'], ...over,
  });
  const value = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
  const review = async (summary: TxSummary) => {
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(summary) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
  };

  it('adding: every row, from the prepared summary, bounds to the last digit', async () => {
    await review(deposit());
    expect(screen.getByRole('heading', { name: 'Review: add liquidity' })).toBeInTheDocument();
    expect(value('Pool')).toBe(KEY(30).toBase58());
    expect(value('Pool kind')).toBe('Standard address for fee tier 1');
    expect(value('Token (mint)')).toBe(KEY(31).toBase58());
    expect(value('Fee tier')).toBe('1: traders pay 0.25% a trade; LPs keep 0.220% of each trade');
    expect(value('You put in about')).toBe('2 SOL and 5 tokens');
    expect(value('At most')).toBe('2.020000001 SOL and 5.050001 tokens');
    expect(value('You get')).toBe('123.456789012 pool shares, exactly');
    expect(value('Your share of the pool')).toBe('none → 12.50%');
    expect(value('Price check')).toBe('1.2% below the outside price (Jupiter), read just now');
    expect(value('Pool fee to add')).toBe('none');
    expect(screen.getByText('Read these about this token first:')).toBeInTheDocument();
    expect(screen.getByText('Its creator can still mint more.')).toBeInTheDocument();
    expect(screen.getByText('An approved spender can move tokens.')).toBeInTheDocument();
    expect(screen.getByText(/closed at the end, so anything not used comes back as plain SOL/)).toBeInTheDocument();
  });

  it('adding: a balance-limited side, an own-average price, a launch pool, unread fees and kept wrapped SOL', async () => {
    await review(
      deposit({
        limitedByBalance: 'token', origin: 'launch-pool', config: null,
        price: { state: 'agrees', pool: 1, reference: 1, against: 'own-average', diff: 0.021 },
        unwrapsWsol: false, wsolHeldBefore: 500_000_000n, tokenWarnings: [], notices: [],
      }),
    );
    expect(value('At most')).toBe('2.020000001 SOL and 5.050001 tokens (all the tokens you have)');
    expect(value('Pool kind')).toBe('Launch pool: opened by the launch program at graduation');
    expect(value('Fee tier')).toBe('not read');
    expect(value('Price check')).toBe('2.1% from its own average over the last 30 minutes');
    expect(screen.getByText(/You already hold 0\.5 wrapped SOL\. None of it is spent\. Up to 0\.020000001 SOL/)).toBeInTheDocument();
    expect(screen.queryByText('Read these about this token first:')).not.toBeInTheDocument();
  });

  it('adding to a launch pool nobody has traded yet', async () => {
    await review(deposit({ origin: 'launch-pool', price: { state: 'no-trades-yet', pool: 1 } }));
    expect(value('Price check')).toBe('nobody has traded since the launch program opened it');
  });

  // Owner ruling 2026-10-04 ("any token"): a deposit is built for a pool whose price is off,
  // or has no market price, or whose token copies a name or can be frozen. The builder puts
  // what must be read on the summary (`warnings`), and the review says every sentence of it
  // FIRST: before the rows, and so well above the Sign button.
  const GAP = 'Its price is 10.0% above the outside price. A deposit here would hand that gap to the first arbitrage trade.';
  const COST = 'At these amounts, a move back to the outside price would take up to about 0.0045 SOL of what you put in. That is an estimate.';
  const COPY = 'It calls itself by a well-known token’s name but has a different mint, so it is not that token. If the copy turns out to be worth nothing, so is your share of this pool.';
  const off = (over: Partial<Extract<TxSummary, { kind: 'lp-deposit' }>> = {}) =>
    deposit({
      price: { state: 'disagrees', pool: 1.1, reference: 1, against: 'outside', diff: 0.1 },
      warnings: [COPY, GAP, COST],
      priceGap: { diff: 0.1, lossQuote: 4_500_000n },
      ...over,
    });

  it('adding with warnings: every sentence is shown first, under a line that says to read them first, in the warning colour', async () => {
    await review(off());
    const box = screen.getByTestId('tx-review-warnings');
    expect(box.querySelector('p')).toHaveTextContent('Read these warnings first. Nothing here stops you signing, and each one is a risk to what you put in:');
    expect(Array.from(box.querySelectorAll('li')).map((li) => li.textContent)).toEqual([COPY, GAP, COST]);
    expect(box.querySelector('p')).toHaveClass('text-amber-300/90');
    expect(box.querySelector('ul')).toHaveClass('text-amber-300/90');
    // First on the review: before its first row, and before the Sign button.
    const heading = screen.getByRole('heading', { name: 'Review: add liquidity' });
    expect(heading.nextElementSibling).toBe(box);
    const after = (el: Element) => box.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(after(screen.getByText('Pool'))).toBeTruthy();
    expect(after(screen.getByRole('button', { name: 'Sign in wallet' }))).toBeTruthy();
    // A screen reader lands on the heading: the warnings are what it is described by.
    expect(heading).toHaveAttribute('aria-describedby', box.id);
    // The token's own warnings keep their place, further down.
    expect(after(screen.getByText('Read these about this token first:'))).toBeTruthy();
    // A warning is not a stop: Sign is on.
    expect(screen.getByRole('button', { name: 'Sign in wallet' })).toBeEnabled();
  });

  it('adding with warnings: the price row does not read as a check that passed, and the cost has its own row', async () => {
    await review(off());
    expect(value('Price check')).toBe('10.0% above the outside price (Jupiter), read just now. That is off by more than 3%.');
    expect(value('Estimated cost of that gap')).toBe('up to about 0.0045 SOL of what you put in');
    // The words follow the rule (poolHealth.ts): more than 3% apart is what "off" means.
    expect(PRICE_TOLERANCE).toBe(0.03);
  });

  it('adding below a launch pool’s own average: the row says which way, and that it is off', async () => {
    await review(off({ origin: 'launch-pool', price: { state: 'disagrees', pool: 0.8, reference: 1, against: 'own-average', diff: -0.2 }, priceGap: { diff: -0.2, lossQuote: 1n } }));
    expect(value('Price check')).toBe('20.0% below its own average over the last 30 minutes. That is off by more than 3%.');
    expect(value('Estimated cost of that gap')).toBe('up to about 0.000000001 SOL of what you put in');
  });

  it('a cost that could not be worked out is said as that, never as 0', async () => {
    const UNKNOWN = 'What a move back to the outside price would cost you at these amounts could not be worked out.';
    await review(off({ warnings: [GAP, UNKNOWN], priceGap: { diff: 0.1, lossQuote: null } }));
    expect(value('Estimated cost of that gap')).toBe('could not be worked out');
    expect(within(screen.getByTestId('tx-review-warnings')).getByText(UNKNOWN)).toBeInTheDocument();
    // No figure is put in its place anywhere on the review.
    expect(screen.getByTestId('tx-review').textContent).not.toMatch(/up to about/);
  });

  it('adding to a pool with no market price: the row says it was checked against nothing', async () => {
    const NONE = 'Jupiter has no market price for this token, so this pool’s price was not checked against anything.';
    await review(deposit({ price: { state: 'no-market', pool: 1, detail: 'Jupiter has no route for this token' }, warnings: [NONE] }));
    expect(value('Price check')).toBe('not checked against anything: Jupiter has no market price for this token');
    expect(within(screen.getByTestId('tx-review-warnings')).getByText(NONE)).toBeInTheDocument();
    // Nothing to compare with, so no gap and no cost row.
    expect(screen.queryByText('Estimated cost of that gap')).not.toBeInTheDocument();
  });

  it('with nothing to warn of, the review has no warnings box and its heading is described by nothing', async () => {
    await review(deposit());
    expect(screen.queryByTestId('tx-review-warnings')).not.toBeInTheDocument();
    expect(screen.queryByText(/Read these warnings first/)).not.toBeInTheDocument();
    expect(screen.queryByText('Estimated cost of that gap')).not.toBeInTheDocument();
    const heading = screen.getByRole('heading', { name: 'Review: add liquidity' });
    expect(heading).not.toHaveAttribute('aria-describedby');
    // The first thing under the heading is the first row, as before.
    expect(heading.nextElementSibling).toHaveTextContent(`Pool${KEY(30).toBase58()}`);
  });

  // Taking liquidity out is never held up: a removal carries no warnings, and gets no box.
  it('removing: no warnings box, whatever the pool or its token is like', async () => {
    await review(withdraw());
    expect(screen.queryByTestId('tx-review-warnings')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review: remove liquidity' })).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Estimated cost of that gap')).not.toBeInTheDocument();
  });

  it('removing: every row, from the prepared summary', async () => {
    await review(withdraw());
    expect(screen.getByRole('heading', { name: 'Review: remove liquidity' })).toBeInTheDocument();
    expect(value('Pool kind')).toBe('Launch pool: opened by the launch program at graduation');
    expect(value('Pool shares you give back')).toBe('0.25 (25.00% of yours)');
    expect(value('You get about')).toBe('1 SOL and 3 tokens');
    expect(value('You get at least')).toBe('0.990000001 SOL and 2.970001 tokens');
    expect(value('You keep')).toBe('0.75 pool shares');
    expect(value('The tokens arrive in')).toBe(`${KEY(33).toBase58()} (opened for you; its deposit of 0.00207408 SOL stays in that account)`);
    expect(value('The SOL arrives')).toBe('as wrapped SOL in the account you already hold');
    expect(value('Pool fee to take out')).toBe('none');
    expect(screen.getByText('Swaps on this pool are switched off.')).toBeInTheDocument();
    expect(screen.queryByText('This is all of your share in this pool.')).not.toBeInTheDocument();
  });

  it('removing all of it: nothing kept, an existing token account, plain SOL', async () => {
    await review(withdraw({ lpAmount: 1_000_000_000n, all: true, keep: 0n, tokenAccountRent: 0n, quoteAccount: null, unwrapsWsol: true, origin: 'other' }));
    expect(value('Pool kind')).toBe('Its own address');
    expect(value('Pool shares you give back')).toBe('1 (100.00% of yours)');
    expect(screen.getByText('This is all of your share in this pool.')).toBeInTheDocument();
    expect(value('You keep')).toBe('none in this pool');
    expect(value('The tokens arrive in')).toBe(KEY(33).toBase58());
    expect(value('The SOL arrives')).toBe('as plain SOL');
  });

  it('a new token account’s rent is called a deposit that stays in the account, for both kinds', async () => {
    await review(withdraw());
    expect(screen.getByText('One-time deposit for your new token account (it stays in that account)')).toBeInTheDocument();
    expect(screen.queryByText('One-time account rent')).not.toBeInTheDocument();
  });

  it('the priority fee is measured against the SOL side of the liquidity change', async () => {
    // 12,000 lamports of priority (the fixture) against 100,000 lamports quoted.
    await review(deposit({ quoted: { quote: 100_000n, token: 5_000_000n } }));
    expect(value('Priority fee')).toMatch(/\(12\.00% of this trade\)$/);
  });
});

describe('liquidity outcomes', () => {
  it('unknown is never "failed" for either kind; taking liquidity out again has its own warning', () => {
    for (const kind of ['lp-deposit', 'lp-withdraw'] as const) {
      const view = render(
        <TxOutcomeCard outcome={{ status: 'unknown', signature: SIG, message: 'slow' }} explorerUrl={null} onRecheck={vi.fn()} onReset={vi.fn()} rechecking={false} kind={kind} />,
      );
      const text = document.body.textContent ?? '';
      expect(text).not.toMatch(/fail/i);
      expect(text).toMatch(/Sent, not confirmed yet\. Do not retry until you check\./);
      if (kind === 'lp-withdraw') {
        expect(text).toContain(
          'It may still land. Taking liquidity out again now could take out more than you meant. Check again, or look it up on the explorer.',
        );
      } else {
        expect(text).toContain('It may still land. Sending again could make you pay twice. Check again, or look it up on the explorer.');
      }
      view.unmount();
    }
  });

  it('the flow tells the outcome card what was sent, so a withdrawal left unknown gets its warning', async () => {
    const api = fakeApi({ submitPrepared: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'slow' })) });
    const { result } = flowAt(api);
    const summary: TxSummary = {
      kind: 'lp-withdraw', pool: KEY(30), origin: 'standard', config: null, tokenMint: KEY(31), tokenDecimals: 6, quote: SOL_QUOTE, quoteIsToken0: true,
      lpAccount: KEY(32), lpAmount: 1n, lpDecimals: 9, heldBefore: 1n, all: true, keep: 0n, quoted: { quote: 1n, token: 1n },
      min: { quote: 1n, token: 1n }, tokenAccount: KEY(33), tokenAccountRent: 0n, quoteAccount: null, unwrapsWsol: true, notices: [],
    };
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(summary) })));
    await act(() => result.current.confirm(signer));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(document.body.textContent).toContain('Taking liquidity out again now could take out more than you meant.');
    expect(document.body.textContent).not.toMatch(/fail/i);
  });
});

// Opening a pool (spec 4.4). Every row comes from the prepared transaction, never from
// what the panel was typed into; the fee account's test-run line and the rent line are
// said for an opening; and an opening left unknown warns about a second pool.
describe('opening a pool: the review', () => {
  const config = {
    address: KEY(6).toBase58(), index: 1, disableCreatePool: false, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n,
    fundFeeRate: 0n, createPoolFee: 150_000_000n, creatorFeeRate: 0n, protocolOwner: KEY(7).toBase58(), fundOwner: KEY(7).toBase58(),
  };
  const create = (over: Partial<Extract<TxSummary, { kind: 'lp-create' }>> = {}): TxSummary => ({
    kind: 'lp-create', pool: KEY(40), origin: 'standard', config, tokenMint: KEY(41), tokenDecimals: 6, quote: SOL_QUOTE, quoteIsToken0: true,
    put: { quote: 1_000_000_000n, token: 5_000_000n },
    supply: 70_710_678n, lpAmount: 70_710_578n, lpDecimals: 9,
    locked: { quote: 1_414n, token: 7n },
    createFee: 150_000_000n, feeReceiver: KEY(8),
    rents: { neverRefunded: 40_000_000n, lpAccount: 2_039_280n },
    price: { state: 'agrees', pool: 0.2, reference: 0.195, against: 'outside', diff: 0.2 / 0.195 - 1 },
    tokenWarnings: [{ code: 'mint-authority', text: 'Its creator can still mint more.' }],
    unwrapsWsol: true, wsolHeldBefore: 0n, notices: ['A spender is approved on your token account.'], warnings: [], marketWarnings: [], priceGap: null, ...over,
  });
  const value = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
  const review = async (summary: TxSummary, over: Partial<PreparedTx> = {}) => {
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(summary, over) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
  };

  it('every row, from the prepared summary', async () => {
    await review(create());
    expect(screen.getByRole('heading', { name: 'Review: open a pool' })).toBeInTheDocument();
    expect(value('Pool')).toBe(KEY(40).toBase58());
    expect(value('Pool kind')).toBe('Standard address for fee tier 1');
    expect(value('Token (mint)')).toBe(KEY(41).toBase58());
    expect(value('Fee tier')).toMatch(/^1: traders pay 1% a trade; LPs keep \d+\.\d{3}% of each trade$/);
    expect(value('You put in')).toBe('1 SOL and 5 tokens, exactly');
    expect(value('Opening price')).toBe('1 token = 0.2 SOL. Market (Jupiter, read just now): 0.195 SOL, 2.6% above');
    expect(value('Opens for trading')).toBe('At once (one second after it lands)');
    expect(value('Fee to open the pool')).toBe(
      `0.15 SOL, paid to the team's vault (into ${KEY(8).toBase58()}, the account the pool program fixes); not refundable`,
    );
    expect(value('Account deposits that never come back')).toBe(
      '0.04 SOL (the pool, its price record, its share token and its two vaults; none can be closed)',
    );
    expect(value('Your pool-share account')).toBe('0.00203928 SOL (it comes back if you close that account later)');
    expect(value('You get')).toBe('0.070710578 pool shares, exactly');
    expect(value('Locked in the pool forever')).toMatch(/^0\.0000001 pool shares \(100 of the smallest unit\), worth about .+ SOL and .+ tokens at these amounts$/);
    expect(value('Your share of the pool')).toBe('100.00%');
    expect(screen.getByText('Read these about this token first:')).toBeInTheDocument();
    expect(screen.getByText('Its creator can still mint more.')).toBeInTheDocument();
    expect(screen.getByText('Whoever holds it can make new tokens at any time and sell them into your pool for its SOL.')).toBeInTheDocument();
    expect(screen.getByText('A spender is approved on your token account.')).toBeInTheDocument();
    expect(screen.getByText(/wrapped into a token account for the opening, and that account is closed in the same transaction/)).toBeInTheDocument();
    expect(screen.queryByText(/needs a second signature/)).not.toBeInTheDocument();
  });

  it('a pool at its own address says so, and names the second signature', async () => {
    await review(create({ origin: 'other', tokenWarnings: [], notices: [], unwrapsWsol: false, wsolHeldBefore: 500_000_000n }));
    expect(value('Pool kind')).toBe('Its own address: the standard address is taken, so this pool gets a new address made in this browser');
    expect(
      screen.getByText(/Your wallet will show that this transaction needs a second signature\. That is the new pool's own address: this page signs it after you, then forgets the key\./),
    ).toBeInTheDocument();
    expect(screen.getByText('You already hold 0.5 wrapped SOL. None of it is spent.')).toBeInTheDocument();
    expect(screen.queryByText('Read these about this token first:')).not.toBeInTheDocument();
  });

  it("the rent line names the pool's accounts and the pool-share account, and the fee account's line names the vault", async () => {
    await review(create(), {
      simulated: {
        signerLamportsDelta: -1_192_039_280n,
        tokenDeltas: [{ mint: KEY(9), account: KEY(8), delta: 150_000_000n, role: 'treasury', decimals: 9 }],
      },
    });
    expect(
      screen.getByText(
        "One-time account deposits: the new pool's own accounts (never returned) and your pool-share account (yours to close later)",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('One-time account rent')).not.toBeInTheDocument();
    expect(value("Test run: the team's vault account gains, in SOL (the fee, plus any SOL that account was already holding)")).toBe('+0.15');
    expect(screen.queryByText('Test run: the platform treasury receives')).not.toBeInTheDocument();
  });

  it('the priority fee is measured against the SOL put in', async () => {
    // 12,000 lamports of priority (the fixture) against 100,000 lamports put in.
    await review(create({ put: { quote: 100_000n, token: 5_000_000n } }));
    expect(value('Priority fee')).toMatch(/\(12\.00% of this trade\)$/);
  });

  // Owner ruling 2026-10-04: a pool may open at a price that is off the market, or with no
  // market price at all. Neither is a check that passed, and the review says which it is.
  it('an opening price that is off the market: the warnings first, the row says it is off, and the cost has its own row', async () => {
    const OFF = 'Your opening price is 50.0% above the market price (Jupiter). The first trades would move it to the market price, at your cost.';
    const COST = 'At these amounts, a move back to the market price would take up to about 0.0334 SOL of what you put in. That is an estimate.';
    await review(
      create({
        price: { state: 'disagrees', pool: 0.3, reference: 0.2, against: 'outside', diff: 0.5 },
        warnings: [OFF, COST],
        priceGap: { diff: 0.5, lossQuote: 33_400_000n },
      }),
    );
    const box = screen.getByTestId('tx-review-warnings');
    expect(Array.from(box.querySelectorAll('li')).map((li) => li.textContent)).toEqual([OFF, COST]);
    const heading = screen.getByRole('heading', { name: 'Review: open a pool' });
    expect(heading.nextElementSibling).toBe(box);
    expect(heading).toHaveAttribute('aria-describedby', box.id);
    expect(box.compareDocumentPosition(screen.getByRole('button', { name: 'Sign in wallet' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(value('Opening price')).toBe('1 token = 0.3 SOL. Market (Jupiter, read just now): 0.2 SOL, 50.0% above. That is off by more than 3%.');
    expect(value('Estimated cost of that gap')).toBe('up to about 0.0334 SOL of what you put in');
    expect(screen.getByRole('button', { name: 'Sign in wallet' })).toBeEnabled();
  });

  it('an opening with no market price: the opening price is still said, and that nothing checks it', async () => {
    const ALONE = 'Jupiter has no market price for this token, so there is nothing to compare your opening price with.';
    await review(create({ price: { state: 'no-market', pool: 0.2, detail: 'Jupiter has no route for this token' }, warnings: [ALONE] }));
    expect(value('Opening price')).toBe(
      '1 token = 0.2 SOL. Jupiter has no market price for this token, so there is nothing to compare it with: you are setting the price yourself',
    );
    expect(within(screen.getByTestId('tx-review-warnings')).getByText(ALONE)).toBeInTheDocument();
    expect(screen.queryByText('Estimated cost of that gap')).not.toBeInTheDocument();
  });

  it('an opening cost that could not be worked out is said as that, never as 0', async () => {
    await review(create({ price: { state: 'disagrees', pool: 0.3, reference: 0.2, against: 'outside', diff: 0.5 }, warnings: ['x'], priceGap: { diff: 0.5, lossQuote: null } }));
    expect(value('Estimated cost of that gap')).toBe('could not be worked out');
  });

  it('with nothing to warn of, an opening has no warnings box and no cost row', async () => {
    await review(create());
    expect(screen.queryByTestId('tx-review-warnings')).not.toBeInTheDocument();
    expect(screen.queryByText('Estimated cost of that gap')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review: open a pool' })).not.toHaveAttribute('aria-describedby');
  });
});

describe('opening a pool: the outcome', () => {
  it('unknown warns about a second pool and a second fee, and never says failed', () => {
    render(
      <TxOutcomeCard outcome={{ status: 'unknown', signature: SIG, message: 'slow' }} explorerUrl={null} onRecheck={vi.fn()} onReset={vi.fn()} rechecking={false} kind="lp-create" />,
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain(
      'It may still land. Opening a pool again now could open a second pool and pay the fee to open twice. Check again, or look it up on the explorer.',
    );
    expect(text).not.toContain('Sending again could make you pay twice.');
    expect(text).not.toMatch(/fail/i);
  });
});

// B review person-5: on the review a person reads before signing, a sentence breaks only
// between words; only an address row (Pool, Token) may break anywhere.
describe('opening a pool: the review wraps sentences between words', () => {
  it('every prose row is mono={false}; the address rows stay mono', async () => {
    const config = {
      address: KEY(6).toBase58(), index: 1, disableCreatePool: false, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n,
      fundFeeRate: 0n, createPoolFee: 150_000_000n, creatorFeeRate: 0n, protocolOwner: KEY(7).toBase58(), fundOwner: KEY(7).toBase58(),
    };
    const summary: TxSummary = {
      kind: 'lp-create', pool: KEY(40), origin: 'standard', config, tokenMint: KEY(41), tokenDecimals: 6, quote: SOL_QUOTE, quoteIsToken0: true,
      put: { quote: 1_000_000_000n, token: 5_000_000n }, supply: 70_710_678n, lpAmount: 70_710_578n, lpDecimals: 9,
      locked: { quote: 1_414n, token: 7n }, createFee: 150_000_000n, feeReceiver: KEY(8),
      rents: { neverRefunded: 40_000_000n, lpAccount: 2_039_280n },
      price: { state: 'agrees', pool: 0.2, reference: 0.195, against: 'outside', diff: 0.2 / 0.195 - 1 },
      tokenWarnings: [], unwrapsWsol: true, wsolHeldBefore: 0n, notices: [], warnings: [], marketWarnings: [], priceGap: null,
    };
    const api = fakeApi();
    const { result } = renderHook(() => useTxFlow(api, rpc));
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(summary) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    const valueOf = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement;
    for (const label of [
      'You put in',
      'Fee to open the pool',
      'Account deposits that never come back',
      'Your pool-share account',
      'You get',
      'Locked in the pool forever',
      'Your share of the pool',
    ]) {
      expect(valueOf(label).className, label).not.toMatch(/break-all/);
    }
    for (const label of ['Pool', 'Token (mint)']) expect(valueOf(label).className, label).toMatch(/break-all/);
  });
});

// A swap in one of our pools, sent from the Solana swap page because that pool paid at
// least as much as Jupiter. Every row is the prepared summary's; none is the market's.
describe('a swap in our pool: the review', () => {
  const value = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
  const review = async (summary: TxSummary, simulated?: PreparedTx['simulated']) => {
    const api = fakeApi();
    const { result } = flowAt(api);
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(summary, simulated ? { simulated } : {}) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
  };
  const SOL_SIDE = { mint: KEY(29), symbol: 'SOL', decimals: 9 };
  const TOKEN = { mint: KEY(31), symbol: null, decimals: 6 };

  it('a buy: every row, from the prepared summary, to the last digit', async () => {
    await review(venueSwapSummary(KEY(30), KEY(31)));
    expect(screen.getByRole('heading', { name: 'Review your swap in our pool' })).toBeInTheDocument();
    expect(value('Pool')).toBe(KEY(30).toBase58());
    expect(value('Pool kind')).toBe('Standard address for fee tier 1');
    expect(value('Fee tier')).toBe('1: traders pay 1% a trade; LPs keep 0.840% of each trade');
    expect(value('You pay')).toBe('1 SOL');
    expect(value('You receive (quoted)')).toBe('123.4567 tokens');
    expect(value('You receive at least')).toBe('122.222221 tokens');
    expect(value('Pool fee (inside what you pay)')).toBe(
      "0.01 SOL, of which 0.0016 SOL goes to the venue and the rest to the pool's liquidity providers",
    );
    expect(value('Price impact')).toBe('0.99%');
    expect(screen.queryByText(/Creator fee/)).not.toBeInTheDocument();
    expect(screen.getByText('Your SOL is wrapped into a token account for the swap, and that account is closed at the end.')).toBeInTheDocument();
    expect(screen.getByText('One-time deposit for your new token account (it stays in that account)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in wallet' })).toBeEnabled();
  });

  it('a sale for SOL: the wrapped SOL is closed so SOL comes back plain, or left open when it was already there', async () => {
    const sale = { input: TOKEN, output: SOL_SIDE, amountIn: 5_000_000n, minimumAmountOut: 39_600_000n };
    const q = venueSwapSummary(KEY(30), KEY(31)).quote;
    const quote = { ...q, outAmount: 40_000_000n, result: { ...q.result, tradeFee: 50_000n, protocolFee: 8_000n } };
    await review(venueSwapSummary(KEY(30), KEY(31), { ...sale, quote }));
    expect(value('You pay')).toBe('5 tokens');
    expect(value('You receive (quoted)')).toBe('0.04 SOL');
    expect(value('You receive at least')).toBe('0.0396 SOL');
    expect(value('Pool fee (inside what you pay)')).toBe(
      "0.05 tokens, of which 0.008 tokens goes to the venue and the rest to the pool's liquidity providers",
    );
    expect(screen.getByText('The pool pays out wrapped SOL, and that account is closed at the end, so you get plain SOL back.')).toBeInTheDocument();
    cleanup();
    await review(venueSwapSummary(KEY(30), KEY(31), { ...sale, quote, unwrapsWsol: false }));
    expect(screen.getByText('The pool pays out wrapped SOL. You already had a wrapped SOL account, so it is left open with its balance.')).toBeInTheDocument();
  });

  it('a creator fee is its own row, on the side the pool takes it from', async () => {
    const q = venueSwapSummary(KEY(30), KEY(31)).quote;
    await review(venueSwapSummary(KEY(30), KEY(31), { enableCreatorFee: true, quote: { ...q, creatorFeeOnInput: false, result: { ...q.result, creatorFee: 61_729n } } }));
    expect(value('Creator fee (taken from what you receive)')).toBe('0.061729 tokens');
    cleanup();
    await review(venueSwapSummary(KEY(30), KEY(31), { enableCreatorFee: true, quote: { ...q, creatorFeeOnInput: true, result: { ...q.result, creatorFee: 500_000n } } }));
    expect(value('Creator fee (on top, from what you pay)')).toBe('0.0005 SOL');
  });

  it('a pool paired with USDC: both sides in their own decimals and names, and no SOL is wrapped', async () => {
    const usdc = { mint: KEY(28), symbol: USDC_QUOTE.symbol, decimals: USDC_QUOTE.decimals };
    const bayla = { mint: KEY(27), symbol: BAYLA_QUOTE.symbol, decimals: BAYLA_QUOTE.decimals };
    const q = venueSwapSummary(KEY(30), KEY(27)).quote;
    await review(
      venueSwapSummary(KEY(30), KEY(27), {
        input: usdc, output: bayla, amountIn: 250_000_000n, minimumAmountOut: 1_000_000n, wrapsSol: false, unwrapsWsol: false, outputAccountRent: 0n,
        quote: { ...q, outAmount: 1_010_101n, result: { ...q.result, tradeFee: 2_500_000n, protocolFee: 400_000n } },
      }),
      { signerLamportsDelta: -5_000n, tokenDeltas: [
        { mint: KEY(28), account: KEY(21), delta: -250_000_000n, role: 'token' },
        { mint: KEY(27), account: KEY(22), delta: 1_010_101n, role: 'token' },
      ] },
    );
    expect(value('You pay')).toBe('250 USDC');
    expect(value('You receive (quoted)')).toBe('1.0101 BAYLA');
    expect(value('You receive at least')).toBe('1 BAYLA');
    expect(value('Pool fee (inside what you pay)')).toBe("2.5 USDC, of which 0.4 USDC goes to the venue and the rest to the pool's liquidity providers");
    expect(value('Test run: your USDC changes by')).toBe('-250');
    expect(value('Test run: your BAYLA changes by')).toBe('+1.0101');
    expect(screen.queryByText(/wrapped/)).not.toBeInTheDocument();
  });

  it('a test-run change of a token with no name is "your tokens", in its own decimals', async () => {
    await review(venueSwapSummary(KEY(30), KEY(31), { output: { mint: KEY(31), symbol: null, decimals: 9 } }), {
      signerLamportsDelta: -SOL_1,
      tokenDeltas: [{ mint: KEY(31), account: KEY(21), delta: 2_500_000_000n, role: 'token', decimals: 6 }],
    });
    expect(value('Test run: your tokens change by')).toBe('+2.5');
  });

  it("a builder's notice is shown in the warning colour", async () => {
    await review(venueSwapSummary(KEY(30), KEY(31), { notices: ['This token can charge a fee on each transfer.'] }));
    expect(screen.getByText('This token can charge a fee on each transfer.')).toBeInTheDocument();
  });

  it('a rebuild that found Jupiter paying more is not sent, and says the trade was checked again', () => {
    outcome({ status: 'not-sent', stage: 'venue', message: 'Jupiter now pays more for this trade. Press Buy again to swap through Jupiter.' });
    expect(screen.getByText('Not sent. This trade was checked against Jupiter again before your wallet was asked, and nothing was signed.')).toBeInTheDocument();
    expect(screen.getByText('Nothing was charged.')).toBeInTheDocument();
  });
});
