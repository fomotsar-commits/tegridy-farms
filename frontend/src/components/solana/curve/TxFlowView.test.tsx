import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { TxFlowView, TxOutcomeCard } from './TxFlowView';
import { REVIEW_TTL_MS, useTxFlow } from './useTxFlow';
import { CREATOR, KEY, SIG, buySummary, fakeApi, prepared } from './fakeWriteApi.fixture';
import type { PreparedTx, TxOutcome, TxSigner, TxSummary, WriteRpc } from './ports';

const SOL_1 = 1_000_000_000n;

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
      platformReserve: null, treasuryAccountRent: 1_488_440n,
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
  it('a review goes stale after a minute and can no longer be signed', async () => {
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
    kind: 'lp-deposit', pool: KEY(30), origin: 'standard', config, tokenMint: KEY(31), tokenDecimals: 6, solIsToken0: true,
    lpAmount: 123_456_789_012n, lpDecimals: 9,
    quoted: { sol: 2_000_000_000n, token: 5_000_000n }, max: { sol: 2_020_000_001n, token: 5_050_001n },
    limitedByBalance: 'none', sharePct: { before: 0, after: 12.5 },
    price: { state: 'agrees', pool: 1, reference: 1, against: 'outside', diff: -0.012 },
    tokenWarnings: [{ code: 'mint-authority', text: 'Its creator can still mint more.' }],
    unwrapsWsol: true, wsolHeldBefore: 0n, notices: ['An approved spender can move tokens.'], ...over,
  });
  const withdraw = (over: Partial<Extract<TxSummary, { kind: 'lp-withdraw' }>> = {}): TxSummary => ({
    kind: 'lp-withdraw', pool: KEY(30), origin: 'launch-pool', config: null, tokenMint: KEY(31), tokenDecimals: 6, solIsToken0: true,
    lpAccount: KEY(32), lpAmount: 250_000_000n, lpDecimals: 9, heldBefore: 1_000_000_000n, all: false, keep: 750_000_000n,
    quoted: { sol: 1_000_000_000n, token: 3_000_000n }, min: { sol: 990_000_001n, token: 2_970_001n },
    tokenAccount: KEY(33), tokenAccountRent: 2_074_080n, unwrapsWsol: false, notices: ['Swaps on this pool are switched off.'], ...over,
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
    expect(screen.getByText(/You already hold 0\.5 wrapped SOL\. It is left exactly as it is\. Up to 0\.020000001 SOL/)).toBeInTheDocument();
    expect(screen.queryByText('Read these about this token first:')).not.toBeInTheDocument();
  });

  it('adding to a launch pool nobody has traded yet', async () => {
    await review(deposit({ origin: 'launch-pool', price: { state: 'no-trades-yet', pool: 1 } }));
    expect(value('Price check')).toBe('nobody has traded since the launch program opened it');
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
    await review(withdraw({ lpAmount: 1_000_000_000n, all: true, keep: 0n, tokenAccountRent: 0n, unwrapsWsol: true, origin: 'other' }));
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
    await review(deposit({ quoted: { sol: 100_000n, token: 5_000_000n } }));
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
      kind: 'lp-withdraw', pool: KEY(30), origin: 'standard', config: null, tokenMint: KEY(31), tokenDecimals: 6, solIsToken0: true,
      lpAccount: KEY(32), lpAmount: 1n, lpDecimals: 9, heldBefore: 1n, all: true, keep: 0n, quoted: { sol: 1n, token: 1n },
      min: { sol: 1n, token: 1n }, tokenAccount: KEY(33), tokenAccountRent: 0n, unwrapsWsol: true, notices: [],
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
    kind: 'lp-create', pool: KEY(40), origin: 'standard', config, tokenMint: KEY(41), tokenDecimals: 6, solIsToken0: true,
    put: { sol: 1_000_000_000n, token: 5_000_000n },
    supply: 70_710_678n, lpAmount: 70_710_578n, lpDecimals: 9,
    locked: { sol: 1_414n, token: 7n },
    createFee: 150_000_000n, feeReceiver: KEY(8),
    rents: { neverRefunded: 40_000_000n, lpAccount: 2_039_280n },
    price: { state: 'agrees', pool: 0.2, reference: 0.195, against: 'outside', diff: 0.2 / 0.195 - 1 },
    tokenWarnings: [{ code: 'mint-authority', text: 'Its creator can still mint more.' }],
    unwrapsWsol: true, wsolHeldBefore: 0n, notices: ['A spender is approved on your token account.'], ...over,
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
    expect(screen.getByText('You already hold 0.5 wrapped SOL. It is left exactly as it is.')).toBeInTheDocument();
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
    expect(value("Test run: the fee to open arrives at the team's vault (SOL)")).toBe('+0.15');
    expect(screen.queryByText('Test run: the platform treasury receives')).not.toBeInTheDocument();
  });

  it('the priority fee is measured against the SOL put in', async () => {
    // 12,000 lamports of priority (the fixture) against 100,000 lamports put in.
    await review(create({ put: { sol: 100_000n, token: 5_000_000n } }));
    expect(value('Priority fee')).toMatch(/\(12\.00% of this trade\)$/);
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
