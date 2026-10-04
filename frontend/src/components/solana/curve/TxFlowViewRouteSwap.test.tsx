// A swap through one of our pools from the main swap page (`lp-swap`), as the shared
// review, outcome card and pending note show it (SPEC_S3 4.5, 4.6). Every row comes from
// the prepared transaction's summary: the amount into the pool, the minimum and the site
// fee were decoded from its bytes, so each value below is one the summary carries and no
// form could have supplied.
//
// Nothing on any page builds this kind yet; these pin what the page will get.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { TxFlowView, TxOutcomeCard } from './TxFlowView';
import { useTxFlow } from './useTxFlow';
import { CREATOR, KEY, SIG, fakeApi, prepared } from './fakeWriteApi.fixture';
import { yieldClaim } from '../../../lib/solana/lp/yieldCopy.fixture';
import { LP_PENDING_SCOPE, readPendingTrades, savePendingTrade } from './pendingTrade';
import { usePendingTrades, type CheckSignature } from './usePendingTrades';
import type { CurveWriteConfig, PreparedTx, TxSigner, TxSummary, WriteRpc } from './ports';

type RouteSummary = Extract<TxSummary, { kind: 'lp-swap' }>;

const POOL = KEY(30);
const TOKEN = KEY(31);
const FEE_ACCOUNT = KEY(32);
const rpc = {} as WriteRpc;
const signer: TxSigner = { publicKey: CREATOR, signTransaction: async (t) => t };
// A scope of its own: the swap page's scope constant arrives with the page wiring.
const SCOPE = 'test:route-swap';

const config = {
  address: KEY(6).toBase58(), index: 1, disableCreatePool: false, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n,
  fundFeeRate: 0n, createPoolFee: 150_000_000n, creatorFeeRate: 0n, protocolOwner: KEY(7).toBase58(), fundOwner: KEY(7).toBase58(),
};

const quote = (over: Partial<RouteSummary['quote']> = {}): RouteSummary['quote'] => ({
  poolAddress: POOL.toBase58(), outAmount: 2_291_212_251n, reserveIn: 85_000_000_000n, reserveOut: 200_000_000_000_000n,
  priceImpact: 0.0116, creatorFeeOnInput: true,
  result: { outputAmount: 2_291_212_251n, tradeFee: 9_950_000n, protocolFee: 1_592_000n, fundFee: 0n, creatorFee: 0n, newInputVaultAmount: 0n, newOutputVaultAmount: 0n },
  ...over,
});

// 1 SOL typed: fee 5,000,000, into the pool 995,000,000.
const buy = (over: Partial<RouteSummary> = {}): RouteSummary => ({
  kind: 'lp-swap', pool: POOL, origin: 'standard', config, enableCreatorFee: false, tier: 1, side: 'buy', tokenMint: TOKEN, tokenDecimals: 6,
  amountIn: 1_000_000_000n,
  swap: { amountIn: 995_000_000n, minimumAmountOut: 2_279_756_189n },
  fee: { amount: 5_000_000n, to: FEE_ACCOUNT },
  quote: quote(), netExpected: 2_291_212_251n, netGuaranteed: 2_279_756_189n,
  versus: 2_280_000_000n, priceCheck: null, tokenWarnings: [], unwrapsWsol: true, wsolHeldBefore: 0n, notices: [],
  ...over,
});

// 2,000,000 tokens sold: gross 839,081,226, minimum 834,885,819, fee 4,174,429.
const sell = (over: Partial<RouteSummary> = {}): RouteSummary => ({
  kind: 'lp-swap', pool: POOL, origin: 'launch-pool', config: { ...config, index: 0, tradeFeeRate: 2_500n }, enableCreatorFee: true, tier: 0, side: 'sell',
  tokenMint: TOKEN, tokenDecimals: 6,
  amountIn: 2_000_000_000_000n,
  swap: { amountIn: 2_000_000_000_000n, minimumAmountOut: 834_885_819n },
  fee: { amount: 4_174_429n, to: FEE_ACCOUNT },
  quote: quote({
    outAmount: 839_081_226n, creatorFeeOnInput: false,
    result: { outputAmount: 839_081_226n, tradeFee: 5_000_000_000n, protocolFee: 0n, fundFee: 0n, creatorFee: 1_200_000n, newInputVaultAmount: 0n, newOutputVaultAmount: 0n },
  }),
  netExpected: 834_885_820n, netGuaranteed: 830_711_390n,
  versus: null, priceCheck: { state: 'no-trades-yet', pool: 1 }, tokenWarnings: [], unwrapsWsol: false, wsolHeldBefore: 250_000_000n, notices: [],
  ...over,
});

const value = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

async function review(summary: TxSummary, over: Partial<PreparedTx> = {}) {
  const api = fakeApi();
  const { result } = renderHook(() => useTxFlow(api, rpc));
  await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(summary, over) })));
  render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={9} signer={signer} />);
}

beforeEach(() => sessionStorage.clear());

describe('the review of a swap through one of our pools', () => {
  it('a buy: every row, from the prepared summary, bounds to the last digit', async () => {
    await review(buy({ tokenWarnings: [{ code: 'mint-authority', text: 'Its creator can still mint more.' }], notices: ['A note from the builder.'] }));
    expect(screen.getByRole('heading', { name: 'Review your swap' })).toBeInTheDocument();
    expect(value('Token address (mint)')).toBe(TOKEN.toBase58());
    expect(value('Pool')).toBe(POOL.toBase58());
    expect(value('Pool kind')).toBe('Standard address for fee tier 1');
    expect(value('Fee tier')).toBe('1: traders pay 1% a trade; LPs keep 0.840% of each trade');
    expect(value('You pay')).toBe('1 SOL');
    expect(value('Platform fee (0.50%)')).toBe(`0.005 SOL, to the site's fee account ${FEE_ACCOUNT.toBase58()}; the same fee as on Jupiter's route`);
    expect(value('Goes into the pool')).toBe('0.995 SOL');
    // The token's own decimals (6) from the summary, never the page's (9 here).
    expect(value('You receive, expected')).toBe('2,291.2122 tokens');
    expect(value('You receive, at least')).toBe('2,279.756189 tokens');
    expect(value('Pool fee (inside what you pay)')).toBe('0.0099 SOL');
    expect(value('Compared with')).toBe('Jupiter: 2,280 tokens after the same fee');
    expect(screen.getByText('Your SOL is wrapped for the swap, and that account is closed at the end.')).toBeInTheDocument();
    expect(screen.getByText('Read these about this token first:')).toBeInTheDocument();
    expect(screen.getByText('Its creator can still mint more.')).toBeInTheDocument();
    expect(screen.getByText('A note from the builder.')).toBeInTheDocument();
    expect(screen.queryByText(/Creator fee/)).not.toBeInTheDocument();
  });

  it('a sell: the guaranteed SOL is the pool’s minimum LESS the fee, and the fee row says what it is a share of', async () => {
    await review(sell());
    expect(value('Pool kind')).toBe('Launch pool: opened by the launch program at graduation');
    expect(value('Fee tier')).toBe('0: traders pay 0.25% a trade; LPs keep 0.210% of each trade');
    expect(value('You pay')).toBe('2,000,000 tokens');
    expect(value('Platform fee (0.50%)')).toBe(
      `0.004174429 SOL, to the site's fee account ${FEE_ACCOUNT.toBase58()}; 0.50% of the minimum below, never more than 0.50% of what you get`,
    );
    expect(screen.queryByText('Goes into the pool')).not.toBeInTheDocument();
    expect(value('You receive, expected')).toBe('about 0.8348 SOL');
    // 834,885,819 - 4,174,429 = 830,711,390 lamports.
    expect(value('You receive, at least')).toBe('0.83071139 SOL');
    expect(value('Pool fee (inside what you pay)')).toBe('5,000 tokens');
    expect(value('Creator fee (taken from what you receive)')).toBe('0.0012 SOL');
    expect(value('Compared with')).toBe('Jupiter has no route for this token');
    expect(screen.getByText('The pool pays out wrapped SOL. You already had a wrapped-SOL account, so it is left open with its balance.')).toBeInTheDocument();
    expect(screen.queryByText('Read these about this token first:')).not.toBeInTheDocument();
  });

  // What a trade costs includes the creator fee wherever the pool charges one (#698): the
  // tier's creator rate counts only when the pool's OWN switch is on, read with the pool.
  it('the fee tier row adds the creator fee when this pool charges one, and says so when its tier has one it does not charge', async () => {
    const launchTier = { ...config, index: 0, tradeFeeRate: 2_500n, creatorFeeRate: 500n };
    await review(sell({ config: launchTier, enableCreatorFee: true }));
    expect(value('Fee tier')).toBe('0: traders pay 0.3% a trade (0.25% trade fee, 0.05% creator fee); LPs keep 0.210% of each trade');
  });

  it('the fee tier row of a pool on the same tier whose own switch is off names no creator fee', async () => {
    const launchTier = { ...config, index: 0, tradeFeeRate: 2_500n, creatorFeeRate: 500n };
    await review(sell({ config: launchTier, enableCreatorFee: false }));
    expect(value('Fee tier')).toBe('0: traders pay 0.25% a trade (no creator fee); LPs keep 0.210% of each trade');
  });

  it('a buy when Jupiter has no route: the fee row does not claim "the same fee as on Jupiter’s route", there is no such route', async () => {
    await review(buy({ origin: 'launch-pool', versus: null, priceCheck: { state: 'no-trades-yet', pool: 1 } }));
    expect(value('Platform fee (0.50%)')).toBe(`0.005 SOL, to the site's fee account ${FEE_ACCOUNT.toBase58()}; 0.50% of the SOL you pay`);
    expect(value('Compared with')).toBe('Jupiter has no route for this token');
    expect(screen.queryByText(/same fee/)).not.toBeInTheDocument();
  });

  it('a pool at its own address, and the wrapped-SOL endings the other way round', async () => {
    await review(buy({ origin: 'other', unwrapsWsol: false }));
    expect(value('Pool kind')).toBe('Its own address');
    expect(screen.getByText('Your SOL is wrapped for the swap. You already had a wrapped-SOL account, so it is left open with its balance.')).toBeInTheDocument();
  });

  it('the fee lines: the new token account’s deposit, the site fee account’s test-run line, the priority share of the SOL side', async () => {
    await review(buy({ amountIn: 100_000n }), {
      simulated: {
        signerLamportsDelta: -1_000_000_000n,
        tokenDeltas: [
          { mint: TOKEN, account: KEY(40), delta: 2_291_212_251n, role: 'token', decimals: 6 },
          { mint: KEY(41), account: FEE_ACCOUNT, delta: 5_000_000n, role: 'treasury', decimals: 9 },
        ],
      },
    });
    expect(screen.getByText('One-time deposit for your new token account (it stays in that account)')).toBeInTheDocument();
    expect(screen.queryByText('One-time account rent')).not.toBeInTheDocument();
    expect(value("Test run: the site's fee account receives")).toBe('+0.005');
    expect(screen.queryByText('Test run: the platform treasury receives')).not.toBeInTheDocument();
    expect(value('Test run: your tokens change by')).toBe('+2,291.2122');
    // 12,000 lamports of priority (the fixture) against the 100,000 lamports paid.
    expect(value('Priority fee')).toMatch(/\(12\.00% of this trade\)$/);
  });

  it('a sell measures the priority fee against the SOL it is quoted to pay out', async () => {
    await review(sell({ quote: quote({ outAmount: 100_000n }) }));
    expect(value('Priority fee')).toMatch(/\(12\.00% of this trade\)$/);
  });

  it('no row promises a yield, and nothing has an em dash', async () => {
    await review(sell());
    const text = screen.getByTestId('tx-review').textContent ?? '';
    expect(yieldClaim(text)).toBeNull();
    expect(text).not.toContain('—');
  });
});

describe('a swap left unconfirmed', () => {
  it('is never "failed", and warns that swapping again could swap twice', () => {
    render(
      <TxOutcomeCard outcome={{ status: 'unknown', signature: SIG, message: 'slow' }} explorerUrl={null} onRecheck={vi.fn()} onReset={vi.fn()} rechecking={false} kind="lp-swap" />,
    );
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/fail/i);
    expect(text).toMatch(/Sent, not confirmed yet\. Do not retry until you check\./);
    expect(text).toContain('It may still land. Swapping again now could swap twice. Check again, or look it up on the explorer.');
  });

  it('its note is written the moment it is sent, WITH its pool, and survives a reload read', () => {
    const { result } = renderHook(() => usePendingTrades(SCOPE, null, vi.fn()));
    act(() => result.current.sent(SIG, prepared(buy())));
    expect(readPendingTrades(SCOPE)).toMatchObject([{ kind: 'lp-swap', signature: SIG, lastValidBlockHeight: 1234, pool: POOL.toBase58() }]);
    expect(JSON.parse(sessionStorage.getItem(SCOPE) ?? '[]')).toMatchObject([{ kind: 'lp-swap', pool: POOL.toBase58() }]);
  });

  it('left unknown the note is kept; confirmed, it is cleared', () => {
    const { result } = renderHook(() => usePendingTrades(SCOPE, null, vi.fn()));
    act(() => result.current.record({ status: 'unknown', signature: SIG, message: 'slow' }, prepared(sell())));
    expect(readPendingTrades(SCOPE)).toMatchObject([{ kind: 'lp-swap', pool: POOL.toBase58() }]);
    act(() => result.current.record({ status: 'confirmed', signature: SIG, slot: 1 }, prepared(sell())));
    expect(readPendingTrades(SCOPE)).toEqual([]);
  });

  it('its check is told it is a swap, so a refusal found later is said in the swap’s words', async () => {
    savePendingTrade(SCOPE, { kind: 'lp-swap', signature: SIG, lastValidBlockHeight: 99, pool: POOL.toBase58() });
    const check = vi.fn<CheckSignature>(async (signature) => ({ status: 'unknown' as const, signature, message: 'still out there' }));
    const { result } = renderHook(() => usePendingTrades(SCOPE, check, vi.fn()));
    await waitFor(() => expect(check).toHaveBeenCalledWith(SIG, 99, 'lp-swap'));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.notes).toMatchObject([{ kind: 'lp-swap', pool: POOL.toBase58() }]);
  });

  it('Check again on the flow passes the swap’s config and kind', async () => {
    const CFG = { programId: KEY(50), cpSwapProgram: KEY(51), cluster: 'localnet' } as CurveWriteConfig;
    const api = fakeApi({
      submitPrepared: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'slow' })),
      recheckOutcome: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'slow' })),
    });
    const { result } = renderHook(() => useTxFlow(api, rpc));
    const p = prepared(buy(), { check: { intent: { cfg: CFG } } as unknown as PreparedTx['check'] });
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: p })));
    await act(() => result.current.confirm(signer));
    await act(() => result.current.recheck());
    expect(api.recheckOutcome).toHaveBeenCalledWith({}, SIG, { lastValidBlockHeight: 1234, cfg: CFG, kind: 'lp-swap' });
  });

  it('a swap note is not a liquidity note: the liquidity scope never receives one from here', () => {
    const { result } = renderHook(() => usePendingTrades(SCOPE, null, vi.fn()));
    act(() => result.current.sent(SIG, prepared(buy())));
    expect(readPendingTrades(LP_PENDING_SCOPE)).toEqual([]);
  });
});
