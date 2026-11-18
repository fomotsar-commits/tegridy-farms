// What a visitor pays on the Solana curve is rounded UP at the last digit shown, so it never reads
// below what can leave the wallet, and the same amount reads the same in a notice and in its row.
// Each amount below runs past the fourth decimal, where a cut and a round-up differ.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CurveTradePanel, type CurveTradePanelProps } from './CurveTradePanel';
import { PoolSwapPanel, type PoolSwapPanelProps } from './PoolSwapPanel';
import { SummaryRows } from './TxFlowView';
import { LaunchCreateForm } from './LaunchCreateForm';
import { CREATOR, KEY, MINT, PLANT_SUMMARY, SOL, ammConfig, bondingCurve, buySummary, curveAccount, fakeApi, launchState, openGate } from './fakeWriteApi.fixture';
import { lpDepositSummary, lpWithdrawSummary } from '../lp/fakeLpWriteApi.fixture';
import { WSOL_MINT, quoteSellOnCurve } from '../../../lib/launcher/solana/curve';
import { quoteOwnPool } from '../../../lib/solana/cpswap/read';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';
import { CREATOR_FEE_ON_BOTH, type PoolStateView } from '../../../lib/solana/cpswap/program';
import type { CurveSignerState } from './useCurveSigner';
import type { LaunchPool, TxSummary, WriteRpc } from './ports';

vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const ready: CurveSignerState = {
  kind: 'ready',
  address: CREATOR.toBase58(),
  signer: { publicKey: CREATOR, signTransaction: async (t) => t },
  signMessage: null,
};

/** The value printed beside a review or form row's label. */
const rowValue = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

function renderPanel(realSolReserves = 0n) {
  const c = bondingCurve({ realSolReserves });
  const props: CurveTradePanelProps = {
    api: fakeApi(),
    rpc: {} as WriteRpc,
    gate: openGate(),
    launch: launchState(c),
    curve: curveAccount(c),
    mint: MINT,
    decimals: 6,
    rentFloor: 2_000_000n,
    actions: { create: true, buy: true, sell: true, migrate: false, poolSwap: false },
    signerState: ready,
    onSettled: vi.fn(),
  };
  render(<CurveTradePanel {...props} />);
}

const rows = (summary: TxSummary) => render(<SummaryRows summary={summary} decimals={6} display={(s) => s} />);

// 1,234,567,890 lamports in; the curve's own fee on it is 12,345,679 lamports.
const PAID = 1_234_567_890n;
const FEE = 12_345_679n;

describe('curve trade panel: what you pay is rounded up', () => {
  it('"You pay (at most)" and its fee row', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '1.23456789' } });
    expect(rowValue('You pay (at most)')).toBe('1.2346 SOL');
    expect(rowValue('Trade fee (inside that amount)')).toBe('0.0124 SOL');
  });

  it('the notice on a buy that fills the curve names what is used as its row does', () => {
    // 25.9 of 26 SOL in: the curve takes 101,010,102 lamports of the 5 SOL typed.
    renderPanel(26n * SOL - SOL / 10n);
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '5' } });
    expect(screen.getByText(/This buy fills the curve/)).toHaveTextContent(/only 0\.1011 of your 5 SOL is used/);
    expect(rowValue('You pay (at most)')).toBe('0.1011 SOL');
  });
});

describe('curve review: what you pay is rounded up', () => {
  const buy = buySummary();
  if (buy.kind !== 'buy') throw new Error('kind');
  const filling: TxSummary = {
    ...buy,
    fillsCurve: true,
    requestedLamports: 2n * SOL,
    maxLamportsIn: PAID,
    quote: { ...buy.quote, lamportsIn: PAID, feeLamports: FEE, capped: true },
  };

  it('"You pay (at most)"', () => {
    rows(filling);
    expect(rowValue('You pay (at most)')).toBe('1.2346 SOL');
  });

  it('"…of which trade fee"', () => {
    rows(filling);
    expect(rowValue('…of which trade fee')).toBe('0.0124 SOL');
  });

  it('the fills-the-curve notice names the same at-most as its row', () => {
    rows(filling);
    expect(screen.getByText(/This buy fills the curve/)).toHaveTextContent(/at most 1\.2346 SOL of the 2 SOL you entered/);
  });

  it('a launch review: the opening buy and its fee, as the form showed them', () => {
    rows({
      kind: 'create', mint: MINT, creator: CREATOR, name: 'Farm Fresh', symbol: 'FRESH', uri: 'https://x.test/m.json', decimals: 6,
      openingBuy: { quote: { lamportsIn: PAID, feeLamports: FEE, lamportsToCurve: PAID - FEE, tokensOut: 3_500_000_000_000n, capped: false }, minTokensOut: 3_500_000_000_000n },
      platformReserve: { amount: 36_900_000_000_000n, bps: 369n, recipient: KEY(4), treasuryToken: KEY(12) },
      treasuryAccountRent: 1_488_440n,
      plant: PLANT_SUMMARY,
    } as TxSummary);
    expect(rowValue('Your opening buy: you pay')).toBe('1.2346 SOL');
    expect(rowValue('…of which trade fee')).toBe('0.0124 SOL');
  });

  it('a sell: "You sell"', () => {
    rows({
      kind: 'sell', mint: MINT, tokensIn: 1_234_567_891n, minLamportsOut: 900n,
      quote: { lamportsOut: 1_000n, feeLamports: 10n, grossLamports: 1_010n },
      priceImpactBps: 5n, feeSplit: { total: 10n, creator: 5n, platform: 5n },
    });
    expect(rowValue('You sell')).toBe('1,234.5679');
  });

  it('a pool swap: "You pay", in SOL on a buy and in tokens on a sell', () => {
    const quote = {
      poolAddress: CREATOR.toBase58(), outAmount: 900n, reserveIn: 1n, reserveOut: 1n, priceImpact: 0.01, creatorFeeOnInput: true,
      result: { outputAmount: 900n, tradeFee: 2_500_000n, protocolFee: 300_000n, fundFee: 0n, creatorFee: 0n, newInputVaultAmount: 0n, newOutputVaultAmount: 0n },
    };
    const { unmount } = rows({ kind: 'pool-buy', mint: MINT, pool: CREATOR, amountIn: PAID, minimumAmountOut: 800n, quote, unwrapsWsol: true });
    expect(rowValue('You pay')).toBe('1.2346 SOL');
    unmount();
    rows({ kind: 'pool-sell', mint: MINT, pool: CREATOR, amountIn: 1_234_567_891n, minimumAmountOut: 800n, quote, unwrapsWsol: true });
    expect(rowValue('You pay')).toBe('1,234.5679');
  });
});

/** `raw` at `decimals`, rounded up at four decimals, trailing zeros dropped, whole part grouped: a fee row's figure. */
function up4(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals - 4);
  const units = (raw + unit - 1n) / unit;
  const frac = (units % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${(units / 10_000n).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

const TRANSFER_FEE = 'The token’s own transfer fee';
const poolQuote = (tradeFee: bigint, creatorFee = 0n, creatorFeeOnInput = true) => ({
  poolAddress: CREATOR.toBase58(), outAmount: 900n, reserveIn: 1n, reserveOut: 1n, priceImpact: 0.01, creatorFeeOnInput,
  result: { outputAmount: 900n, tradeFee, protocolFee: 0n, fundFee: 0n, creatorFee, newInputVaultAmount: 0n, newOutputVaultAmount: 0n },
});
// 1,234.567891 of a 6-decimal token: cut at four it reads 1,234.5678.
const TOKENS = 1_234_567_891n;

describe('review rows: a fee you pay, or the token’s own cut, is rounded up', () => {
  it('a sell on the curve: "Trade fee"', () => {
    rows({
      kind: 'sell', mint: MINT, tokensIn: 1_000_000n, minLamportsOut: 900n,
      quote: { lamportsOut: 1_000n, feeLamports: FEE, grossLamports: 1_010n },
      priceImpactBps: 5n, feeSplit: { total: FEE, creator: FEE / 2n, platform: FEE - FEE / 2n },
    });
    expect(rowValue('Trade fee')).toBe('0.0124 SOL');
  });

  it('a pool swap: the pool fee in SOL on a buy and in tokens on a sell, and the creator fee either way', () => {
    const { unmount } = rows({ kind: 'pool-buy', mint: MINT, pool: CREATOR, amountIn: PAID, minimumAmountOut: 800n, quote: poolQuote(FEE, FEE, true), unwrapsWsol: true });
    expect(rowValue('Pool fee (inside what you pay)')).toBe('0.0124 SOL');
    expect(rowValue('Creator fee (on top, from what you pay)')).toBe('0.0124 SOL');
    unmount();
    // Selling, a creator fee taken from what you receive comes out of the SOL.
    rows({ kind: 'pool-sell', mint: MINT, pool: CREATOR, amountIn: TOKENS, minimumAmountOut: 800n, quote: poolQuote(TOKENS, FEE, false), unwrapsWsol: true });
    expect(rowValue('Pool fee (inside what you pay)')).toBe('1,234.5679');
    expect(rowValue('Creator fee (taken from what you receive)')).toBe('0.0124 SOL');
  });

  it('adding to a pool: the token’s own cut is rounded up; "You put in about" stays cut under its exact "At most"', () => {
    rows(lpDepositSummary(KEY(40), MINT, { quoted: { quote: 100_000_001n, token: 10_000_001n }, transferFee: { kept: TOKENS, rate: '1%' } }));
    expect(rowValue('You put in about')).toBe('0.1 SOL and 10 tokens');
    expect(rowValue(TRANSFER_FEE)).toMatch(/^about 1,234\.5679 tokens of what you put in \(1%\)/);
  });

  it('taking out of a pool: the token’s own cut of what the pool pays out', () => {
    rows(lpWithdrawSummary(KEY(40), MINT, KEY(44), { transferFee: { kept: TOKENS, rate: '1%' } }));
    expect(rowValue(TRANSFER_FEE)).toMatch(/^about 1,234\.5679 tokens more of what the pool pays out \(1%\)/);
  });

  it('a swap in our own pool: the pool fee, the creator fee and the token’s own cut, on both sides', () => {
    const TIER = { address: KEY(42).toBase58(), index: 1, disableCreatePool: false, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n, createPoolFee: 0n, creatorFeeRate: 0n, protocolOwner: 'A', fundOwner: 'B' };
    const swap = (paysCoin: boolean): TxSummary => ({
      kind: 'venue-swap', pool: KEY(40), origin: 'standard', config: TIER, tokenMint: MINT, tokenDecimals: 6, coin: SOL_QUOTE, paysCoin,
      amountIn: 100_000_000n, minimumAmountOut: 900n, quoted: { ...poolQuote(paysCoin ? FEE : TOKENS, paysCoin ? FEE : TOKENS, true) },
      aggregator: { kind: 'quoted', out: 800n, when: 'now' }, unwrapsWsol: true, wsolHeldBefore: 0n, notices: [], transferFee: { kept: TOKENS, rate: '1%' },
    } as TxSummary);
    const { unmount } = rows(swap(true));
    expect(rowValue('Pool fee (inside what you pay)')).toBe('0.0124 SOL (1%)');
    expect(rowValue('Creator fee (on top, from what you pay)')).toBe('0.0124 SOL');
    expect(rowValue(TRANSFER_FEE)).toMatch(/^1,234\.5679 tokens of what the pool pays out \(1%\)/);
    unmount();
    rows(swap(false));
    expect(rowValue('Pool fee (inside what you pay)')).toBe('1,234.5679 tokens (1%)');
    expect(rowValue('Creator fee (on top, from what you pay)')).toBe('1,234.5679 tokens');
    expect(rowValue(TRANSFER_FEE)).toMatch(/^1,234\.5679 tokens of what you pay \(1%\)/);
  });
});

describe('curve trade panel: the fee on a sell is rounded up', () => {
  it('"Fee" on a sell', () => {
    const c = bondingCurve({ realSolReserves: 10n * SOL });
    renderPanel(10n * SOL);
    fireEvent.click(screen.getByRole('button', { name: /^sell$/i }));
    fireEvent.change(screen.getByLabelText('Sell (tokens)'), { target: { value: '1234567.891' } });
    const q = quoteSellOnCurve(c, 1_234_567_891_000n, 0n, { curveAccountLamports: curveAccount(c).lamports, rentExemptLamports: 2_000_000n });
    if (!q.ok) throw new Error('quote');
    // The fee must run past the fourth decimal for a cut and a round-up to differ.
    expect(q.value.feeLamports % 100_000n).not.toBe(0n);
    expect(rowValue('Fee')).toBe(`${up4(q.value.feeLamports, 9)} SOL`);
  });
});

describe('pool swap panel: the pool fee is rounded up, in SOL and in tokens', () => {
  function pool(creatorFeeRate = 0n): LaunchPool {
    const [t0, t1] = [WSOL_MINT, MINT].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
    const view = { address: KEY(40).toBase58(), ammConfig: KEY(6).toBase58(), token0Mint: t0!.toBase58(), token1Mint: t1!.toBase58(), status: 0, openTime: 0n, enableCreatorFee: creatorFeeRate > 0n, creatorFeeOn: CREATOR_FEE_ON_BOTH } as unknown as PoolStateView;
    const n = 1_000_000_000_000n;
    return { address: KEY(40), ammConfigAddress: KEY(6), ammConfig: { ...ammConfig, creatorFeeRate }, snapshot: { pool: view, vault0Amount: n, vault1Amount: n, reserve0: n, reserve1: n } };
  }
  function renderPool(p: LaunchPool) {
    const props: PoolSwapPanelProps = {
      api: fakeApi(), rpc: {} as WriteRpc, gate: openGate(), mint: MINT, pool: { kind: 'ok', value: p }, decimals: 6,
      actions: { create: false, buy: false, sell: false, migrate: false, poolSwap: true }, signerState: ready, onSettled: vi.fn(),
    };
    render(<PoolSwapPanel {...props} />);
  }

  it('a buy pays the fee in SOL, a sell in tokens', () => {
    const p = pool();
    renderPool(p);
    fireEvent.change(screen.getByLabelText('Pay (SOL)'), { target: { value: '1.23456789' } });
    const buy = quoteOwnPool(p.snapshot, p.ammConfig, WSOL_MINT.toBase58(), PAID, 0);
    if (!buy) throw new Error('quote');
    expect(buy.result.tradeFee % 100_000n).not.toBe(0n);
    expect(rowValue('Pool fee (inside what you pay)')).toBe(`${up4(buy.result.tradeFee, 9)} SOL`);
    fireEvent.click(screen.getByRole('button', { name: /^sell$/i }));
    fireEvent.change(screen.getByLabelText('Sell (tokens)'), { target: { value: '1234.567891' } });
    const sell = quoteOwnPool(p.snapshot, p.ammConfig, MINT.toBase58(), TOKENS, 0);
    if (!sell) throw new Error('quote');
    expect(sell.result.tradeFee % 100n).not.toBe(0n);
    expect(rowValue('Pool fee (inside what you pay)')).toBe(up4(sell.result.tradeFee, 6));
  });

  it('a pool whose creator takes 0.25% on top: that fee is rounded up, in SOL on a buy and in tokens on a sell', () => {
    const p = pool(2_500n);
    renderPool(p);
    const CREATOR = 'Creator fee (on top, from what you pay)';
    fireEvent.change(screen.getByLabelText('Pay (SOL)'), { target: { value: '1.23456789' } });
    const buy = quoteOwnPool(p.snapshot, p.ammConfig, WSOL_MINT.toBase58(), PAID, 0);
    if (!buy) throw new Error('quote');
    expect(buy.result.creatorFee % 100_000n).not.toBe(0n);
    expect(rowValue(CREATOR)).toBe(`${up4(buy.result.creatorFee, 9)} SOL`);
    fireEvent.click(screen.getByRole('button', { name: /^sell$/i }));
    fireEvent.change(screen.getByLabelText('Sell (tokens)'), { target: { value: '1234.567891' } });
    const sell = quoteOwnPool(p.snapshot, p.ammConfig, MINT.toBase58(), TOKENS, 0);
    if (!sell) throw new Error('quote');
    expect(sell.result.creatorFee % 100n).not.toBe(0n);
    expect(rowValue(CREATOR)).toBe(up4(sell.result.creatorFee, 6));
  });
});

describe('launch form: the opening buy you pay is rounded up', () => {
  it('"You pay X SOL (fee Y SOL)"', () => {
    const api = fakeApi({
      quoteOpeningBuy: vi.fn(() => ({
        ok: true as const,
        value: { lamportsIn: PAID, feeLamports: FEE, lamportsToCurve: PAID - FEE, tokensOut: 3_500_000_000_000n, capped: false },
      })),
    });
    render(
      <MemoryRouter>
        <LaunchCreateForm api={api} rpc={{} as WriteRpc} gate={openGate()} actions={{ create: true, buy: false, sell: false, migrate: false, poolSwap: false }} signerState={ready} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Opening buy (SOL)'), { target: { value: '1.23456789' } });
    expect(rowValue('You pay')).toBe('1.2346 SOL (fee 0.0124 SOL)');
  });
});
