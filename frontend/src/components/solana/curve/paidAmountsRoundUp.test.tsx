// What a visitor pays on the Solana curve is rounded UP at the last digit shown, so it never reads
// below what can leave the wallet, and the same amount reads the same in a notice and in its row.
// Each amount below runs past the fourth decimal, where a cut and a round-up differ.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CurveTradePanel, type CurveTradePanelProps } from './CurveTradePanel';
import { SummaryRows } from './TxFlowView';
import { LaunchCreateForm } from './LaunchCreateForm';
import { CREATOR, KEY, MINT, PLANT_SUMMARY, SOL, bondingCurve, buySummary, curveAccount, fakeApi, launchState, openGate } from './fakeWriteApi.fixture';
import type { CurveSignerState } from './useCurveSigner';
import type { TxSummary, WriteRpc } from './ports';

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
