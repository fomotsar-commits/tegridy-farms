import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { decodeFunctionData } from 'viem';
import { WHYPE, hyperEvmVenueFrom } from '../../lib/chains/hyperEvm';
import { POOL_OPENER_ABI } from '../../lib/hyperevm/opener';
import type { ReadCall } from '../../lib/hyperevm/pools';

/**
 * The open form, walked against a pretend chain and wallet (the addresses are not contracts):
 * a coin off the list shows its own ticker, whole address and a warning; a wallet without
 * big blocks cannot press Review; with them, the review names the fee and the treasury, and the
 * one transaction pays exactly the opener's fee with the coins sorted.
 */
const OPENER = '0x1000000000000000000000000000000000000007' as const;
const PEPE = '0xfffffffffffffffffffffffffffffffffffff001';
const POOL = '0x3000000000000000000000000000000000000003';
const FEE = 230_000_000_000_000_000n;
const TREASURY = '0x1000000000000000000000000000000000000006';
const chainState = { bigBlocks: true as boolean, poolOpen: false, treasury: TREASURY as string, coinThrows: false };
const sent: { label: string; tx: () => Promise<unknown> }[][] = [];

vi.mock('./useHyperEvm', () => ({
  asReader: (c: unknown) => c,
  useHyperEvmClient: () => client,
  useBalance: () => 10n ** 18n,
}));
const client = {
  request: async ({ method }: { method: string }) => (method === 'eth_usingBigBlocks' ? chainState.bigBlocks : null),
  multicall: async ({ contracts }: { contracts: ReadCall[] }) => {
    if (chainState.coinThrows && contracts.some((c) => c.address.toLowerCase() === PEPE)) throw new Error('rate limited');
    return answers(contracts);
  },
};
const answers = (contracts: ReadCall[]) => contracts.map((c) => {
    const ok = (result: unknown) => ({ status: 'success' as const, result });
    if (c.address.toLowerCase() === PEPE) return ok(c.functionName === 'decimals' ? 18 : c.functionName === 'symbol' ? 'PEPE' : 'Pepe');
    if (c.functionName === 'POOL_OPENING_FEE') return ok(FEE);
    if (c.functionName === 'TREASURY') return ok(chainState.treasury);
    if (c.functionName === 'getPool') return ok(chainState.poolOpen ? POOL : '0x0000000000000000000000000000000000000000');
    if (c.functionName === 'slot0') return ok([1n << 96n, 0, 0, 0, 0, 0x66, true]);
    if (c.functionName === 'liquidity' || c.functionName === 'balanceOf') return ok(0n);
    return { status: 'failure' as const };
  });

import { OpenPoolCard } from './OpenPoolCard';

const VENUE = hyperEvmVenueFrom({
  factory: '0x1000000000000000000000000000000000000001', positionManager: '0x1000000000000000000000000000000000000002',
  quoterV2: '0x1000000000000000000000000000000000000003', universalRouter: '0x1000000000000000000000000000000000000004',
  feeAdapter: '0x1000000000000000000000000000000000000005', treasury: '0x1000000000000000000000000000000000000006',
  siteFeeBps: 50, poolOpener: OPENER,
})!;
const send = {
  state: { kind: 'idle' as const }, reset: () => {}, onChain: true, isConnected: true, switchToHyperEvm: async () => {},
  address: '0x7000000000000000000000000000000000000007' as const,
  run: async (steps: { label: string; tx: () => Promise<unknown> }[]) => {
    sent.push(steps);
    return true;
  },
};

function renderCard(onAdd = vi.fn(), pools: unknown[] = []) {
  render(<OpenPoolCard venue={VENUE} opener={OPENER} pools={pools as never} send={send as never} onAdd={onAdd} onDone={() => {}} />);
  fireEvent.change(screen.getByTestId('hyperevm-open-coin'), { target: { value: PEPE } });
}

describe('the open-a-pool form', () => {
  beforeEach(() => {
    chainState.bigBlocks = true;
    chainState.poolOpen = false;
    chainState.treasury = TREASURY;
    chainState.coinThrows = false;
    sent.length = 0;
  });

  it('shows a coin off the list by its own ticker and whole address, with a warning', async () => {
    renderCard();
    expect(await screen.findByText('Not on the site\'s list: the ticker is its own claim. Check the address.')).toBeTruthy();
    expect(screen.getByText(PEPE)).toBeTruthy();
    expect(screen.getAllByText('PEPE').length).toBeGreaterThan(0);
  });

  it('a wallet without the big-block setting cannot press Review', async () => {
    chainState.bigBlocks = false;
    renderCard();
    fireEvent.change(await screen.findByTestId('hyperevm-open-price'), { target: { value: '0.001' } });
    expect(await screen.findByText('Your wallet needs Hyperliquid’s big-block setting on to open a pool.')).toBeTruthy();
    expect((screen.getByTestId('hyperevm-open-review-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('with it, reviews the fee and the treasury, then sends one transaction paying exactly the fee', async () => {
    renderCard();
    fireEvent.change(await screen.findByTestId('hyperevm-open-price'), { target: { value: '0.001' } });
    await waitFor(() => expect((screen.getByTestId('hyperevm-open-review-button') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('hyperevm-open-review-button'));
    expect(screen.getByText('0.23 HYPE, to the treasury Safe')).toBeTruthy();
    expect(screen.getByText(VENUE.treasury)).toBeTruthy();
    fireEvent.click(screen.getByTestId('hyperevm-open-send'));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]!.length).toBe(1);
    const tx = (await sent[0]![0]!.tx()) as { to: string; value: bigint; data: `0x${string}` };
    expect(tx.to).toBe(OPENER);
    expect(tx.value).toBe(FEE);
    const { args } = decodeFunctionData({ abi: POOL_OPENER_ABI, data: tx.data });
    // WHYPE sorts first; the 0.3% tier is the default.
    expect([String(args[0]).toLowerCase(), String(args[1]).toLowerCase(), args[2]]).toEqual([WHYPE.toLowerCase(), PEPE, 3000]);
  });

  it('reads the price back, and refuses "1,000" rather than open at 1', async () => {
    renderCard();
    const box = await screen.findByTestId('hyperevm-open-price');
    fireEvent.change(box, { target: { value: '1,000' } });
    expect(await screen.findByText('Type the price without thousands marks: 1000, not 1,000.')).toBeTruthy();
    expect((screen.getByTestId('hyperevm-open-review-button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: '0.000000000123' } });
    expect(await screen.findByText('1 PEPE = 0.000000000123 HYPE')).toBeTruthy();
  });

  it('refuses to send when the opener pays a treasury the site does not know', async () => {
    chainState.treasury = '0x00000000000000000000000000000000000BAD00';
    renderCard();
    fireEvent.change(await screen.findByTestId('hyperevm-open-price'), { target: { value: '0.001' } });
    expect(await screen.findByText('This opener pays a treasury the site does not know. Nothing can be sent.')).toBeTruthy();
    expect((screen.getByTestId('hyperevm-open-review-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a pool opened straight on the factory: it offers to list it for the fee at its own price, with no big blocks', async () => {
    chainState.poolOpen = true;
    chainState.bigBlocks = false; // a listing is small: it needs no big blocks
    const onAdd = vi.fn();
    renderCard(onAdd);
    expect(await screen.findByText(/Opened straight on the factory, so it is not on the list/)).toBeTruthy();
    // No "Add to it" until it is listed: a position in a pool off the list would not show on the site.
    await screen.findByText('Price now');
    expect(screen.queryByText('Add to it')).toBeNull();
    await waitFor(() => expect((screen.getByTestId('hyperevm-open-review-button') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('hyperevm-open-review-button'));
    fireEvent.click(screen.getByTestId('hyperevm-open-send'));
    await waitFor(() => expect(sent.length).toBe(1));
    const tx = (await sent[0]![0]!.tx()) as { to: string; value: bigint; data: `0x${string}` };
    expect([tx.to, tx.value]).toEqual([OPENER, FEE]);
    const d = decodeFunctionData({ abi: POOL_OPENER_ABI, data: tx.data });
    expect([d.functionName, String(d.args![0]).toLowerCase()]).toEqual(['list', POOL]);
  });

  it('a pool already on the list is neither opened nor listed again: it offers to add to it', async () => {
    chainState.poolOpen = true;
    const onAdd = vi.fn();
    renderCard(onAdd, [{ address: POOL, token0: { address: WHYPE, symbol: 'WHYPE', name: 'Wrapped HYPE', decimals: 18 }, token1: { address: PEPE, symbol: 'PEPE', name: 'Pepe', decimals: 18, unlisted: true }, fee: 3000, tickSpacing: 60, sqrtPriceX96: 1n << 96n, tick: 0, liquidity: 0n, reserve0: 0n, reserve1: 0n, venueShare0: 6, venueShare1: 6 }]);
    expect(await screen.findByText('This pool is already open, and on the list above.')).toBeTruthy();
    fireEvent.click(await screen.findByText('Add to it'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('hyperevm-open-review-button') as HTMLButtonElement).disabled).toBe(true);
  });

  // CodeRabbit's review of #1350, 2026-11-28.
  it('the big-block setting can be checked again after it is switched on elsewhere, with no reload', async () => {
    chainState.bigBlocks = false;
    renderCard();
    fireEvent.change(await screen.findByTestId('hyperevm-open-price'), { target: { value: '0.001' } });
    expect(await screen.findByText('Your wallet needs Hyperliquid’s big-block setting on to open a pool.')).toBeTruthy();
    chainState.bigBlocks = true; // switched on in Hyperliquid, outside the site
    fireEvent.click(screen.getByTestId('hyperevm-open-bigblocks-recheck'));
    await waitFor(() => expect((screen.getByTestId('hyperevm-open-review-button') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId('hyperevm-open-bigblocks-recheck')).toBeNull();
  });

  it('a wallet switched after Review to one without big blocks cannot send', async () => {
    const card = (s: unknown) => <OpenPoolCard venue={VENUE} opener={OPENER} pools={[]} send={s as never} onAdd={() => {}} onDone={() => {}} />;
    const { rerender } = render(card(send));
    fireEvent.change(screen.getByTestId('hyperevm-open-coin'), { target: { value: PEPE } });
    fireEvent.change(await screen.findByTestId('hyperevm-open-price'), { target: { value: '0.001' } });
    await waitFor(() => expect((screen.getByTestId('hyperevm-open-review-button') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('hyperevm-open-review-button'));
    chainState.bigBlocks = false;
    rerender(card({ ...send, address: '0x7000000000000000000000000000000000000008' }));
    expect(await screen.findByText('Your wallet needs Hyperliquid’s big-block setting on to open a pool.')).toBeTruthy();
    const button = screen.getByTestId('hyperevm-open-send') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.length).toBe(0);
  });

  it('a coin that could not be read says so, never that it is not a coin', async () => {
    chainState.coinThrows = true;
    renderCard();
    expect(await screen.findByText('Could not read this coin just now.')).toBeTruthy();
    expect(screen.queryByText('This address does not answer as a coin.')).toBeNull();
  });
});
