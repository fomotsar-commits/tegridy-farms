import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { TxFlowView } from './TxFlowView';
import { useTxFlow } from './useTxFlow';
import { CREATOR, KEY, SIG, buySummary, fakeApi } from './fakeWriteApi.fixture';
import { BAYLA, EVERY_KIND, LOG, RANGE_PROGRAM, TEST_RUN_AT, rangeOpening, underTheHood } from './reviewKinds.fixture';
import type { Prepared, PreparedTx, TxSigner, WriteApi, WriteRpc } from './ports';
import { siteAndNetwork, unsignedBase64 } from './signingFacts';

// web3's byte encoders refuse jsdom's Uint8Array, so the bytes are checked in signingFacts.test.ts
// (node); here the button is checked to hand over exactly what that function makes.
vi.mock('./signingFacts', async (actual) => {
  const real = await actual<typeof import('./signingFacts')>();
  return { ...real, unsignedBase64: vi.fn(() => 'AQID'), siteAndNetwork: vi.fn(real.siteAndNetwork) };
});

// What a visitor meets under a review: this site's figures beside the network's test run, and
// the fold "What you are signing". Neither may ever make a signable review unsignable.

const rpc = {} as WriteRpc;
const signer: TxSigner = { publicKey: CREATOR, signTransaction: async (t) => t };
const confirmedApi = () => fakeApi({ submitPrepared: vi.fn(async () => ({ status: 'confirmed' as const, signature: SIG, slot: 1 })) });

async function reviewOf(p: PreparedTx, api: WriteApi = fakeApi()) {
  const { result } = renderHook(() => useTxFlow(api, rpc));
  await act(() => result.current.prepare(async () => ({ ok: true, prepared: p })));
  render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
  return screen.getByTestId('tx-under-the-hood');
}

const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('What you are signing', () => {
  it('is closed until opened, under the test run line and above Sign', async () => {
    const fold = await reviewOf(underTheHood(EVERY_KIND['range-open']));
    expect(fold.tagName).toBe('DETAILS');
    expect(fold).not.toHaveAttribute('open');
    expect(before(screen.getByText(/^Test run passed/), fold)).toBe(true);
    expect(before(fold, screen.getByRole('button', { name: 'Sign in wallet' }))).toBe(true);
  });

  it('lists the steps read back out of the bytes, in order, each with its program by name and address', async () => {
    const fold = await reviewOf(underTheHood(EVERY_KIND['range-open']));
    const steps = within(fold).getAllByRole('listitem').filter((li) => li.closest('ol'));
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent('Compute limit: 120,000 units.Compute budget: ComputeBudget111111111111111111111111111111');
    expect(steps[1]).toHaveTextContent('Priority price: 10,000 micro-lamports a unit.');
    expect(steps[2]).toHaveTextContent(`Open a position in the pool ${KEY(51).toBase58()} from tick -1200 to tick 1200: liquidity 1,284,112`);
    expect(steps[2]).toHaveTextContent(`This venue's range program: ${RANGE_PROGRAM.toBase58()}`);
    expect(within(steps[2]!).getByRole('link', { name: RANGE_PROGRAM.toBase58() })).toHaveAttribute('href', `https://explorer.test/account/${RANGE_PROGRAM.toBase58()}`);
  });

  it("lists every account it writes, the wallet first; the wallet's address is in no link", async () => {
    const fold = await reviewOf(underTheHood(EVERY_KIND['range-open']));
    expect(fold).toHaveTextContent('Accounts it writes (5)');
    expect(fold).toHaveTextContent(`Your wallet, which pays the fees · payer${CREATOR.toBase58()}`);
    expect(within(fold).getByRole('link', { name: KEY(51).toBase58() }).closest('li')).toHaveTextContent('The pool · pool_state');
    expect(within(fold).getByRole('link', { name: KEY(54).toBase58() }).closest('li')).toHaveTextContent(/^tick_array_lower/);
    for (const a of Array.from(document.querySelectorAll('a'))) expect(a.getAttribute('href') ?? '').not.toContain(CREATOR.toBase58());
  });

  it('says what the network did not say: units it did not report are never the limit, a slot it did not give is said as missing', async () => {
    const fold = await reviewOf(underTheHood(EVERY_KIND.buy, { simulation: { unitsConsumed: null, logs: [], slot: null, at: TEST_RUN_AT, wsolLamportsDelta: null } }));
    expect(fold).toHaveTextContent('Compute: the test run did not say how many units it used; limit 120,000.');
    expect(fold).toHaveTextContent('Test run at 14:02:11 UTC; the network did not give its slot.');
    expect(fold).toHaveTextContent('Test run log (0 lines)');
    expect(fold).toHaveTextContent('The network sent no log with this test run.');
  });

  it('the log: its lines, Copy log, and a log the network cut short says so', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const fold = await reviewOf(underTheHood(EVERY_KIND['range-open'], { simulation: { unitsConsumed: 84_211, logs: [...LOG, 'Log truncated'], slot: 1, at: TEST_RUN_AT, wsolLamportsDelta: null } }));
    const log = within(fold).getByTestId('tx-under-the-hood-log');
    expect(log).toHaveTextContent('Test run log (7 lines)');
    expect(log).toHaveTextContent('The network cut this log short.');
    expect(log.querySelector('pre')?.textContent).toBe([...LOG, 'Log truncated'].join('\n'));
    await act(async () => {
      fireEvent.click(within(log).getByRole('button', { name: 'Copy log' }));
    });
    expect(writeText).toHaveBeenCalledWith([...LOG, 'Log truncated'].join('\n'));
    expect(log).toHaveTextContent('Copied.');
  });

  it('Copy the unsigned transaction hands over base64 of the bytes as built; a browser that will not copy shows it to select', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const p = underTheHood(EVERY_KIND['range-open']);
    const fold = await reviewOf(p);
    await act(async () => {
      fireEvent.click(within(fold).getByRole('button', { name: 'Copy the unsigned transaction (base64)' }));
    });
    expect(fold).toHaveTextContent('This browser did not let the page copy. Here it is: select it and copy it.');
    expect(unsignedBase64).toHaveBeenCalledWith(p.tx);
    expect(within(fold).getByRole('textbox', { name: 'Copy the unsigned transaction (base64)' })).toHaveValue('AQID');
  });

  it('bytes that cannot be put together are said as that, never copied half made', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.mocked(unsignedBase64).mockImplementationOnce(() => {
      throw new Error('Transaction recentBlockhash required');
    });
    const fold = await reviewOf(underTheHood(EVERY_KIND['range-open']));
    await act(async () => {
      fireEvent.click(within(fold).getByRole('button', { name: 'Copy the unsigned transaction (base64)' }));
    });
    expect(fold).toHaveTextContent('Could not be put together here: Transaction recentBlockhash required');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('steps that do not line up with the instructions are said as that, never listed short', async () => {
    const p = underTheHood(EVERY_KIND['range-open']);
    const fold = await reviewOf({ ...p, steps: p.steps.slice(0, 2) });
    expect(fold).toHaveTextContent("The steps could not be lined up with this transaction's instructions here. Your wallet decodes them itself.");
    expect(within(fold).queryByText(/^Compute limit/)).toBeNull();
  });

  it('a review that is never built again says these are the bytes the wallet is handed', async () => {
    const fold = await reviewOf(underTheHood(EVERY_KIND['range-open']));
    expect(fold).toHaveTextContent("Read back out of this build's own bytes, the ones your wallet is handed.");
  });

  it('a fold that cannot be drawn says so in one line, and the review stays signable', async () => {
    const broken = { ...underTheHood(EVERY_KIND.buy), simulation: undefined } as unknown as PreparedTx;
    const api = confirmedApi();
    const { result } = renderHook(() => useTxFlow(api, rpc));
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: broken })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    expect(screen.getByText('What you are signing could not be shown here. Your wallet shows the transaction itself before you sign.')).toBeInTheDocument();
    expect(screen.getByText(/^Test run passed/)).toBeInTheDocument();
    const sign = screen.getByRole('button', { name: 'Sign in wallet' });
    expect(sign).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(sign);
    });
    expect(api.submitPrepared).toHaveBeenCalledTimes(1);
  });
});

describe("this site's figures beside the test run", () => {
  it('the same to the last unit: they agree, and say what SOL leaves out', async () => {
    const fees = { baseLamports: 5_000n, priorityLamports: 12_000n, priorityFeeRead: true, newAccountRentLamports: 59_300_000n };
    await reviewOf(
      underTheHood(rangeOpening(), {
        fees,
        simulated: { signerLamportsDelta: -(4_098_800_000n + 5_000n + 12_000n + 59_300_000n), tokenDeltas: [{ mint: BAYLA, account: KEY(60), delta: -10_000_000_000n, role: 'token' }] },
      }),
    );
    const box = screen.getByTestId('tx-site-and-network');
    expect(box).toHaveTextContent('Worked out by this site-10,000 BAYLA and -4.0988 SOL');
    expect(box).toHaveTextContent("The network's test run moved-10,000 BAYLA and -4.0988 SOL");
    expect(box).toHaveTextContent('They agree, to the last unit.');
    expect(box).toHaveTextContent('SOL on both lines counts your wrapped-SOL account as SOL, and leaves out the fees and deposits listed above.');
  });

  it('a coin the test run reported no account for is not compared, and is never read as 0', async () => {
    await reviewOf(underTheHood(rangeOpening(), { simulated: { signerLamportsDelta: 0n, tokenDeltas: [] } }));
    const box = screen.getByTestId('tx-site-and-network');
    expect(box).toHaveTextContent("The network's test run movedBAYLA: none reported and");
    expect(box).toHaveTextContent('Not compared: the test run reported no account of yours for BAYLA.');
    expect(box).not.toHaveTextContent(/They (agree|differ)/);
  });

  it('a removal whose fees owed did not read: could not be worked out, said in the shared words', async () => {
    const s = EVERY_KIND['range-remove'];
    await reviewOf(underTheHood({ ...s, fees: null } as typeof s));
    expect(screen.getByTestId('tx-site-and-network')).toHaveTextContent('Worked out by this siteCould not be worked out: the fees owed did not read.');
  });

  it('figures that cannot be set side by side say so in one line; the fold and Sign stay', async () => {
    const spy = vi.mocked(siteAndNetwork);
    const real = spy.getMockImplementation()!;
    spy.mockImplementation(() => {
      throw new Error('a figure would not work out');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const api = confirmedApi();
      await reviewOf(underTheHood(rangeOpening()), api);
      expect(screen.getByText("This site's figures could not be set beside the test run here.")).toBeInTheDocument();
      expect(screen.getByTestId('tx-under-the-hood')).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
      });
      expect(api.submitPrepared).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockImplementation(real);
    }
  });

  it('graduation has no figures of the wallet’s own to set side by side, and draws none', async () => {
    await reviewOf(underTheHood(EVERY_KIND.migrate));
    expect(screen.queryByTestId('tx-site-and-network')).toBeNull();
    expect(screen.getByTestId('tx-under-the-hood')).toBeInTheDocument();
  });
});

describe('never a line that Sign compares', () => {
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

  it('a review built again whose test run used other units, at another slot, with another log, still opens the wallet with the fresh one', async () => {
    vi.useFakeTimers();
    const first = underTheHood(buySummary());
    const fresh = underTheHood(buySummary(), {
      blockhash: '2'.repeat(32),
      lastValidBlockHeight: 5_000,
      simulation: { unitsConsumed: 91_007, logs: [...LOG, 'Program log: one more line'], slot: 460_730_002, at: TEST_RUN_AT + 21_000, wsolLamportsDelta: null },
    });
    const build = vi.fn<() => Promise<Prepared>>().mockResolvedValueOnce({ ok: true, prepared: first }).mockResolvedValueOnce({ ok: true, prepared: fresh });
    const api = confirmedApi();
    render(<Flow api={api} build={build} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    });
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    });
    expect(build).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('tx-review-changed')).toBeNull();
    expect(vi.mocked(api.submitPrepared).mock.calls.map((c) => c[2])).toEqual([fresh]);
  });

  it('a review that can be built again says so: past 30 seconds, Sign hands the wallet a new build, not these bytes', async () => {
    render(<Flow api={confirmedApi()} build={async () => ({ ok: true, prepared: underTheHood(buySummary()) })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    });
    const fold = screen.getByTestId('tx-under-the-hood');
    expect(fold).toHaveTextContent("Read back out of this build's own bytes. Press Sign 30 seconds or more after asking for this review");
    expect(fold).toHaveTextContent("that build goes to your wallet without another press, so check your wallet's copy.");
    expect(fold).not.toHaveTextContent('the ones your wallet');
  });

  it('a copy made under one build is not said under the next', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
    const first = underTheHood(buySummary());
    const moved = buySummary();
    if (moved.kind !== 'buy') throw new Error('kind');
    const fresh = underTheHood({ ...moved, quote: { ...moved.quote, tokensOut: 3_400_000_000n } }, { blockhash: '2'.repeat(32), lastValidBlockHeight: 5_000 });
    const build = vi.fn<() => Promise<Prepared>>().mockResolvedValueOnce({ ok: true, prepared: first }).mockResolvedValueOnce({ ok: true, prepared: fresh });
    render(<Flow api={confirmedApi()} build={build} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy the unsigned transaction (base64)' }));
    });
    expect(screen.getByTestId('tx-under-the-hood')).toHaveTextContent('Copied.');
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    });
    expect(screen.getByTestId('tx-review-changed')).toBeInTheDocument();
    expect(screen.getByTestId('tx-under-the-hood')).not.toHaveTextContent('Copied.');
  });
});
