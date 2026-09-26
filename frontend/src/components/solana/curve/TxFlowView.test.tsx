import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { TxFlowView, TxOutcomeCard } from './TxFlowView';
import { REVIEW_TTL_MS, useTxFlow } from './useTxFlow';
import { CREATOR, SIG, buySummary, fakeApi, prepared } from './fakeWriteApi.fixture';
import type { TxOutcome, TxSigner, TxSummary, WriteRpc } from './ports';

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

  it('expired: did not go through, nothing charged, safe to retry', () => {
    outcome({ status: 'expired', signature: SIG, message: '' });
    expect(screen.getByText(/Did not go through\. Nothing was charged\. It is safe to try again\./)).toBeInTheDocument();
  });

  it('reverted: names the program reason and says only the fee was spent', () => {
    outcome({ status: 'reverted', signature: SIG, program: 'launch', code: 6007, message: 'The price moved past your limit.' });
    expect(screen.getByText('The price moved past your limit.')).toBeInTheDocument();
    expect(screen.getByText(/Nothing moved except the network fee/)).toBeInTheDocument();
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
    };
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(create) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.queryByText('One-time account rent')).not.toBeInTheDocument();
    expect(screen.getByText(/token details account.s rent and the token details program.s own fee are not in that line/)).toBeInTheDocument();
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
      poolAddress: CREATOR.toBase58(), outAmount: 900n, reserveIn: 1n, reserveOut: 1n, priceImpact: 0.01,
      result: { outputAmount: 900n, tradeFee: 2_500_000n, protocolFee: 300_000n, fundFee: 0n, creatorFee: 0n, newInputVaultAmount: 0n, newOutputVaultAmount: 0n },
    };
    const pool: TxSummary = { kind: 'pool-buy', mint: CREATOR, pool: CREATOR, amountIn: SOL_1, minimumAmountOut: 800n, quote, unwrapsWsol: true };
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(pool) })));
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByText('Pool fee (inside what you pay)').parentElement).toHaveTextContent('0.0025 SOL');
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
