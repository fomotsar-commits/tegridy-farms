import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import * as validate from '../../../lib/launchMetadata/validate.js';
import { BAYLA_MINT, WSOL_MINT } from '../../../lib/solana/lp/tokenSafety';
import { decodeAmmConfig, decodePersonalPosition, decodePoolState, sortMints, type AmmConfigView } from '../../../lib/solana/clmm/program';
import { getTickAtSqrtPrice } from '../../../lib/solana/clmm/math';
import { encodeAmmConfig, encodePool, encodePosition } from '../../../lib/solana/clmm/encode.fixture';
import type { MintFreeze, RangePool, Read, WalletPosition, WalletPositionsRead } from '../../../lib/solana/clmm/read';
import type { CurveWriteConfig, Prepared, RangeWriteApi } from '../curve/ports';
import { PLATFORM_TREASURY_VAULT } from '../../../lib/launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../../lib/launcher/solana/write/plant';
import { RangeInner, type RangeReaders } from './RangeSection';
import { ownPoolPrograms } from '../../../lib/solana/lp/ownPools';
import { RANGE_PROGRAM_ADDRESS } from '../../../lib/solana/clmm/programId';
import { PROGRAM_ID as LAUNCH_PROGRAM_ID } from '../../../lib/launcher/solana/curve/program';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { LIVE_PROGRAM_ID } from '../../../lib/solana/cpswap/program';
import { depositFrom, pairOf, planFromCeiling, presetRange } from '../../../lib/solana/clmm/rangeMath';
import { bothAmounts } from './rangeText';
import { RANGE_RISK_SHORT } from './RangeRisks';
import { prepared } from '../curve/fakeWriteApi.fixture';
import { SOL_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import type { RangeSummary } from '../../../lib/launcher/solana/write/types';

/**
 * The Range tab as a visitor meets it, on fake reads (web3's address derivation cannot run
 * under jsdom, so the views are decoded from the program's own byte layout here) and a fake
 * write API that records what Review asked it to build.
 */

const wallet = vi.hoisted(() => ({ publicKey: null as null | PublicKey, signTransaction: undefined as undefined | (() => Promise<never>), connecting: false, wallet: null }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => ({ connection: { rpcEndpoint: 'fake' } }) }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const PROG = key(1);
const ME = key(2);
const CONFIG = key(3);
const POOL = key(4);
const { token0: M0, token1: M1 } = sortMints(new PublicKey(BAYLA_MINT), new PublicKey(WSOL_MINT));
const BAYLA_IS_0 = M0.toBase58() === BAYLA_MINT;

/** sqrt(price) as Q64.64 for 0.0003 SOL per BAYLA, in the pool's own order. */
function sqrtAt(num: bigint, den: bigint): bigint {
  const [n0, d0] = BAYLA_IS_0 ? [num, den] : [den, num];
  const [dec0, dec1] = BAYLA_IS_0 ? [6, 9] : [9, 6];
  const n = (n0 * 10n ** BigInt(dec1)) << 128n;
  const d = d0 * 10n ** BigInt(dec0);
  let x = 1n << 100n;
  for (let i = 0; i < 200; i++) x = (x + n / d / x) >> 1n;
  while (x * x > n / d) x -= 1n;
  return x;
}
const SQRT = sqrtAt(3n, 10_000n);
const TICK = getTickAtSqrtPrice(SQRT);

/** The agreed island split by default (owner, 2026-10-20): of each fee, 10.4% to the vault and 5.6% to the Workshop. */
function tier(rates: Partial<{ tradeFeeRate: number; protocolFeeRate: number; fundFeeRate: number; owner: PublicKey; fundOwner: PublicKey }> = {}): AmmConfigView {
  return decodeAmmConfig(
    CONFIG.toBase58(),
    encodeAmmConfig({ index: 0, tradeFeeRate: 10_000, protocolFeeRate: 104_000, fundFeeRate: 56_000, tickSpacing: 120, owner: PLATFORM_TREASURY_VAULT, fundOwner: WORKSHOP_WALLET, ...rates }),
  )!;
}

function poolOn(config: AmmConfigView): RangePool {
  const data = encodePool({
    ammConfig: CONFIG, mint0: M0, mint1: M1, vault0: key(5), vault1: key(6), observation: key(7),
    decimals0: BAYLA_IS_0 ? 6 : 9, decimals1: BAYLA_IS_0 ? 9 : 6, tickSpacing: 120, liquidity: 10n ** 12n, sqrtPriceX64: SQRT, tickCurrent: TICK,
  });
  return { pool: decodePoolState(POOL.toBase58(), data)!, config };
}

function positionOf(o: { n: number; lower: number; upper: number; status: WalletPosition['status']; fees: WalletPosition['fees']; liquidity?: bigint; nftProgram?: WalletPosition['nftProgram'] }, rp: RangePool): WalletPosition {
  const nft = key(40 + o.n);
  const position = decodePersonalPosition(key(60 + o.n).toBase58(), encodePosition({ nftMint: nft, pool: POOL, tickLower: o.lower, tickUpper: o.upper, liquidity: o.liquidity ?? 10n ** 9n }))!;
  return { position, nftAccount: key(80 + o.n).toBase58(), nftProgram: o.nftProgram ?? 'token-2022', pool: rp.pool, config: rp.config, status: o.status, amounts: { amount0: 1_000_000n, amount1: 2_000_000_000n }, fees: o.fees, rewardsOwed: [0n, 0n, 0n] };
}

const cfg: CurveWriteConfig = { programId: key(9), cpSwapProgram: key(10), cluster: 'localnet' } as CurveWriteConfig;
const refused: Prepared = { ok: false, outcome: { status: 'not-sent', stage: 'build', message: 'The fake builder built nothing.' } };

function fakeApi(): RangeWriteApi {
  return {
    rangeWriteConfig: vi.fn(() => cfg),
    prepareRangeOpen: vi.fn(async () => refused),
    prepareRangeRemove: vi.fn(async () => refused),
    prepareRangeClose: vi.fn(async () => refused),
    submitPrepared: vi.fn(),
    recheckOutcome: vi.fn(),
    explorerTxUrl: vi.fn((sig: string) => `https://explorer.test/tx/${sig}`),
    explorerAddressUrl: vi.fn((address: string) => `https://explorer.test/account/${address}`),
    meta: { displaySafe: validate.displaySafe },
  };
}

/** Jupiter's price for BAYLA by default: the pool's own, 0.0003 SOL. */
const MARKET_AGREES: OutsidePrice = { kind: 'ok', solPerToken: 0.0003, source: 'Jupiter' };

function readers(o: { tiers?: Read<AmmConfigView[]>; pools?: Read<RangePool[]>; positions?: Read<WalletPositionsRead>; market?: OutsidePrice; freeze?: Read<MintFreeze> } = {}): RangeReaders {
  const t = tier();
  return {
    programId: PROG,
    feeTiers: vi.fn(async () => o.tiers ?? { kind: 'ok' as const, value: [t] }),
    pairPools: vi.fn(async () => o.pools ?? { kind: 'ok' as const, value: [poolOn(t)] }),
    walletPositions: vi.fn(async () => o.positions ?? { kind: 'ok' as const, value: { positions: [], unread: [] } }),
    outsidePrice: vi.fn(async () => o.market ?? MARKET_AGREES),
    freezeAuthority: vi.fn(async () => o.freeze ?? { kind: 'ok' as const, value: { kind: 'mint' as const, freezeAuthority: null } }),
  };
}

function show(r: RangeReaders, api: RangeWriteApi | null = fakeApi(), mode: 'on' | 'withdraw-only' | 'off' = 'on', path = '/range-pools') {
  const load = vi.fn(async () => api!);
  render(
    <MemoryRouter initialEntries={[path]}>
      <RangeInner readers={r} load={load} mode={mode} />
    </MemoryRouter>,
  );
  return load;
}

beforeEach(() => {
  wallet.publicKey = null;
  wallet.signTransaction = undefined;
  sessionStorage.clear();
});

describe('how a range position earns', () => {
  it('says what LPs keep and what the venue keeps, from the pool’s fee tier, and that out of range earns nothing', async () => {
    show(readers());
    const card = await screen.findByTestId('range-earns');
    await waitFor(() => expect(card.textContent).toContain('pays a 1% fee'));
    expect(card.textContent).toContain('share 84% of it (0.84% of the swap)');
    expect(card.textContent).toContain('The venue keeps 16% (0.16% of the swap)');
    // Visible, not folded into the fine print.
    const warning = within(card).getByText(/Out of range, a position earns nothing/);
    expect(warning.closest('details')).toBeNull();
    // Where the venue's cut goes, as the Rates card says it: the agreed split, in the fine print.
    const split = within(card).getByText(/The venue’s cut is split: 10\.4% of each fee \(0\.104% of the swap\) to the team’s shared wallet, .* and 5\.6% of each fee \(0\.056% of the swap\) to the island’s Workshop, the island’s agreed share\./);
    expect(split.closest('details')).not.toBeNull();
    expect(card.textContent).toContain(PLATFORM_TREASURY_VAULT.toBase58());
    expect(card.textContent).toContain(WORKSHOP_WALLET.toBase58());
    expect(within(card).queryByTestId('range-venue-elsewhere')).toBeNull();
  });

  it('a tier that sends part of the venue’s cut to any other wallet is said in bold, in plain sight, naming it', async () => {
    const stranger = key(77);
    const t = tier({ fundOwner: stranger });
    show(readers({ tiers: { kind: 'ok', value: [t] }, pools: { kind: 'ok', value: [poolOn(t)] } }));
    const flag = await screen.findByTestId('range-venue-elsewhere');
    expect(flag.closest('details')).toBeNull();
    expect(flag.querySelector('strong')?.textContent).toMatch(/does not follow the agreed split .* 5\.6% of each fee \(0\.056% of the swap\) to another wallet\./);
    expect(flag.textContent).toContain(stranger.toBase58());
  });

  it('the vault as the tier’s fund owner (the program’s default) loses the island its share: said in bold, in plain sight', async () => {
    const t = tier({ fundOwner: PLATFORM_TREASURY_VAULT });
    show(readers({ tiers: { kind: 'ok', value: [t] }, pools: { kind: 'ok', value: [poolOn(t)] } }));
    const flag = await screen.findByTestId('range-venue-elsewhere');
    expect(flag.closest('details')).toBeNull();
    expect(flag.querySelector('strong')?.textContent).toMatch(/16% of each fee \(0\.16% of the swap\) to the team’s shared wallet, 0% of each fee \(0% of the swap\) to the island’s Workshop\./);
  });

  it('a pool with a dynamic fee: the card says the fee as a range and each share of the swap as a floor, as the position link does', async () => {
    const t = tier();
    const base = poolOn(t);
    const dyn: RangePool = { ...base, pool: { ...base.pool, dynamicFeeInfo: { ...(base.pool.dynamicFeeInfo ?? {}), dynamicFeeControl: 99_999, maxVolatilityAccumulator: 100_000 } as NonNullable<RangePool['pool']['dynamicFeeInfo']> } };
    show(readers({ pools: { kind: 'ok', value: [dyn] } }));
    const card = await screen.findByTestId('range-earns');
    await waitFor(() => expect(card.textContent).toContain('pays a 1% to 4% fee'));
    expect(card.textContent).toContain('share 84% of it (at least 0.84% of the swap)');
    expect(card.textContent).toContain('The venue keeps 16% (at least 0.16% of the swap)');
    expect(within(await screen.findByTestId('range-pools')).getByText(/1% to 4% fee per swap/)).toBeInTheDocument();
  });

  it('lists the fee tiers as the chain has them, each with its split, before any pool exists', async () => {
    const low = { ...tier({ tradeFeeRate: 2_500 }), address: key(31).toBase58() };
    show(readers({ tiers: { kind: 'ok', value: [tier(), low] }, pools: { kind: 'ok', value: [] } }));
    const list = await screen.findByTestId('range-tiers');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      '011%of each swap. 84% of that fee (0.84% of the swap) goes to the positions in range, by their liquidity; the venue keeps 16% (0.16%).',
      '020.25%of each swap. 84% of that fee (0.21% of the swap) goes to the positions in range, by their liquidity; the venue keeps 16% (0.04%).',
    ]);
    expect(list.closest('details')).toBeNull();
    expect(within(await screen.findByTestId('range-pools')).getByText('No range pool for BAYLA with SOL yet.')).toBeInTheDocument();
  });

  it('a tier whose venue cut goes anywhere but the agreed split is said in bold in its row, before any pool is picked', async () => {
    const t = tier({ fundOwner: PLATFORM_TREASURY_VAULT });
    show(readers({ tiers: { kind: 'ok', value: [t] }, pools: { kind: 'ok', value: [] } }));
    const row = within(await screen.findByTestId('range-tiers')).getByRole('listitem');
    expect(row.querySelector('strong')?.textContent).toMatch(/does not follow the agreed split/);
    expect(row.closest('details')).toBeNull();
  });

  it('no tier list when the tiers did not read: the unread notice speaks instead', async () => {
    show(readers({ tiers: { kind: 'unread', detail: 'down' } }));
    await within(await screen.findByTestId('range-pools')).findByText(/could not be read just now/);
    expect(screen.queryByTestId('range-tiers')).toBeNull();
  });

  it('a tier with another split is said with that split: nothing is hard-coded', async () => {
    const t = tier({ tradeFeeRate: 2_500, protocolFeeRate: 100_000, fundFeeRate: 20_000 });
    show(readers({ tiers: { kind: 'ok', value: [t] }, pools: { kind: 'ok', value: [poolOn(t)] } }));
    const card = await screen.findByTestId('range-earns');
    await waitFor(() => expect(card.textContent).toContain('pays a 0.25% fee'));
    expect(card.textContent).toContain('share 88% of it (0.22% of the swap)');
    expect(card.textContent).toContain('The venue keeps 12% (0.03% of the swap)');
  });
});

describe('picking a pool', () => {
  it('fee tiers that did not read are said as unread, never as no tiers or no pools', async () => {
    show(readers({ tiers: { kind: 'unread', detail: 'down' } }));
    const card = await screen.findByTestId('range-pools');
    await waitFor(() => expect(card.textContent).toContain('could not be read just now. This does not mean there are none.'));
    expect(card.textContent).not.toContain('No range pool');
    expect(card.textContent).not.toContain('no fee tiers');
    expect(within(card).getByRole('button', { name: 'Read again' })).toBeInTheDocument();
  });

  it('no fee tiers on chain is said as that, apart from a read that failed', async () => {
    show(readers({ tiers: { kind: 'ok', value: [] } }));
    const card = await screen.findByTestId('range-pools');
    await waitFor(() => expect(card.textContent).toContain('The range program has no fee tiers on this network yet'));
    expect(card.textContent).not.toContain('could not be read just now');
  });

  it('a pair with no pool on any tier says so', async () => {
    show(readers({ pools: { kind: 'ok', value: [] } }));
    const card = await screen.findByTestId('range-pools');
    await waitFor(() => expect(card.textContent).toContain('No range pool for BAYLA with SOL yet.'));
    expect(screen.queryByTestId('range-open')).toBeNull();
  });

  it('shows the pool’s fee and price now', async () => {
    show(readers());
    const card = await screen.findByTestId('range-pools');
    await waitFor(() => expect(card.textContent).toContain('1% fee per swap'));
    expect(card.textContent).toContain('Pool price now 0.0003 SOL per BAYLA');
  });
});

describe('picking a range', () => {
  it('BAYLA only, above this pool’s price: holds BAYLA only, takes no SOL, and says it earns nothing until the price rises', async () => {
    show(readers());
    const open = await screen.findByTestId('range-open');
    fireEvent.click(within(open).getByRole('button', { name: 'BAYLA only, above this pool’s price' }));
    expect(open.textContent).toContain('This range is above this pool’s price, so it holds BAYLA only.');
    fireEvent.change(within(open).getByLabelText(/How much BAYLA to put in/), { target: { value: '1000' } });
    const plan = await within(open).findByTestId('range-plan');
    expect(plan.textContent).toMatch(/You put in about\s*990\.\d+ BAYLA and 0 SOL/);
  });

  it('the card’s “You put in about” is the review’s: planned from the amount less the tolerance, as the builder plans it', async () => {
    show(readers());
    const open = await screen.findByTestId('range-open');
    fireEvent.click(within(open).getByRole('button', { name: 'Wide' }));
    fireEvent.change(within(open).getByLabelText(/How much BAYLA to put in/), { target: { value: '2.5' } });
    const plan = await within(open).findByTestId('range-plan');
    const view = poolOn(tier()).pool;
    const pair = pairOf(view)!;
    const range = presetRange(pair, view, 'wide');
    if (typeof range !== 'object') throw new Error('range');
    const want = depositFrom(pair, view, range, 'token', planFromCeiling(2_500_000n, 100))!;
    expect(plan.textContent).toContain(bothAmounts(pair, want.amount0, want.amount1));
  });

  it('shows this pool’s price beside the market’s (Jupiter), and warns before Review when they differ', async () => {
    show(readers({ market: { kind: 'ok', solPerToken: 0.0004, source: 'Jupiter' } }));
    const open = await screen.findByTestId('range-open');
    await waitFor(() => expect(open.textContent).toContain('Market price (Jupiter)0.0004 SOL per BAYLA'));
    expect(open.textContent).toContain('This pool’s price now0.0003 SOL per BAYLA');
    const warning = within(open).getByText(/^This pool’s price is 25% below the market price\. Anyone can open a range pool at any price/);
    // Before the presets and before Review.
    const presets = within(open).getByRole('group', { name: 'Range presets' });
    expect(warning.compareDocumentPosition(presets) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws the range: this pool’s price, the market’s, and the picked range as a band that says where the price is', async () => {
    show(readers({ market: { kind: 'ok', solPerToken: 0.0004, source: 'Jupiter' } }));
    const open = await screen.findByTestId('range-open');
    const strip = await within(open).findByTestId('range-strip');
    await waitFor(() => expect(within(strip).getByRole('img').getAttribute('aria-label')).toContain('The market price is 0.0004 SOL per BAYLA.'));
    expect(strip.getAttribute('data-where')).toBe('none');
    expect(within(strip).queryByTestId('range-strip-band')).toBeNull();
    fireEvent.click(within(open).getByRole('button', { name: 'Wide' }));
    expect(strip.getAttribute('data-where')).toBe('inside');
    expect(within(strip).getByTestId('range-strip-band')).toBeInTheDocument();
    expect(within(strip).getByRole('img').getAttribute('aria-label')).toMatch(/^This pool’s price, 0\.0003 SOL per BAYLA, is inside your range, .+ to .+\. The market price is 0\.0004 SOL per BAYLA\.$/);
    fireEvent.click(within(open).getByRole('button', { name: 'BAYLA only, above this pool’s price' }));
    expect(strip.getAttribute('data-where')).toBe('below');
    expect(strip.textContent).toContain('out of range now: earns once the price reaches it');
  });

  it('a market price that agrees is shown, with no warning', async () => {
    show(readers());
    const open = await screen.findByTestId('range-open');
    await waitFor(() => expect(open.textContent).toContain('Market price (Jupiter)0.0003 SOL per BAYLA'));
    expect(open.textContent).not.toMatch(/the market price\. Anyone can open/);
  });

  it('no route on Jupiter is said beside this pool’s price, never read as agreeing', async () => {
    show(readers({ market: { kind: 'no-route', detail: 'Jupiter has no route for this token' } }));
    const open = await screen.findByTestId('range-open');
    await waitFor(() => expect(open.textContent).toContain('Market price (Jupiter)none: Jupiter has no route for this pair'));
    expect(open.textContent).toContain('so this pool’s price cannot be checked against a market price');
  });

  it('the TOKEN can be the freezable one: USDC as the token says Circle can freeze it, where it is picked', async () => {
    show(readers(), fakeApi(), 'on', `/range-pools?mint=${USDC_QUOTE.mint}`);
    const card = await screen.findByTestId('range-pools');
    await waitFor(() => expect(within(card).getByTestId('lp-coin-risk')).toHaveTextContent(/Circle/));
    expect(within(card).getAllByTestId('lp-coin-risk')).toHaveLength(1);
  });

  it('a token with a live freeze authority is said where it is picked, in the LP deposit’s words; none says nothing, an unread check says so', async () => {
    const freezable = key(91).toBase58();
    const auth = key(92).toBase58();
    show(readers({ freeze: { kind: 'ok', value: { kind: 'mint', freezeAuthority: auth } } }), fakeApi(), 'on', `/range-pools?mint=${freezable}`);
    const card = await screen.findByTestId('range-pools');
    await waitFor(() => expect(within(card).getByTestId('range-token-freeze')).toHaveTextContent(`Its creator can freeze any account that holds it (freeze authority ${auth}), a pool’s own vault and your own account included.`));
  });

  it('an address that is not a token mint is said as that, apart from a check that failed', async () => {
    const notMint = key(93).toBase58();
    show(readers({ freeze: { kind: 'ok', value: { kind: 'not-a-mint', detail: 'the account is not owned by a token program' } } }), fakeApi(), 'on', `/range-pools?mint=${notMint}`);
    const card = await screen.findByTestId('range-pools');
    await waitFor(() => expect(within(card).getByTestId('range-token-freeze')).toHaveTextContent('This address is not a token mint (the account is not owned by a token program)'));
    expect(within(card).getByTestId('range-token-freeze')).not.toHaveTextContent('could not be read');
  });

  it('no freeze authority: nothing is said; a freeze check that did not read: said as unread, never as safe', async () => {
    show(readers());
    const card = await screen.findByTestId('range-pools');
    await waitFor(() => expect(card.textContent).toContain('1% fee per swap'));
    expect(within(card).queryByTestId('range-token-freeze')).toBeNull();
    cleanup();
    show(readers({ freeze: { kind: 'unread', detail: 'down' } }));
    const again = await screen.findByTestId('range-pools');
    await waitFor(() => expect(within(again).getByTestId('range-token-freeze')).toHaveTextContent('could not be read just now (down)'));
  });

  it('paired with USDC, the picker says Circle can freeze the pool’s USDC, where the coin is chosen', async () => {
    show(readers());
    const card = await screen.findByTestId('range-pools');
    expect(within(card).queryByTestId('lp-coin-risk')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'With USDC' }));
    await waitFor(() => expect(within(card).getByTestId('lp-coin-risk')).toHaveTextContent(/Circle/));
  });

  it('a market price is never taken through our own pools: our range, constant-product and launch programs, and the one the page reads', () => {
    expect(new Set(ownPoolPrograms([PROG.toBase58()]))).toEqual(new Set([LIVE_PROGRAM_ID!.toBase58(), RANGE_PROGRAM_ADDRESS, LAUNCH_PROGRAM_ID.toBase58(), PROG.toBase58()]));
  });

  it('a market price that could not be read is said as unread: never as agreeing, never as 0%', async () => {
    show(readers({ market: { kind: 'unread', detail: 'Jupiter’s price came through our own pools, so it is not an outside price' } }));
    const open = await screen.findByTestId('range-open');
    await waitFor(() => expect(open.textContent).toContain('Market price (Jupiter)could not be read just now (Jupiter’s price came through our own pools, so it is not an outside price)'));
    expect(open.textContent).not.toMatch(/0% (above|below)|the market price\. Anyone can open/);
  });

  it('SOL only, below: holds SOL only and the amount is of SOL', async () => {
    show(readers());
    const open = await screen.findByTestId('range-open');
    fireEvent.click(within(open).getByRole('button', { name: 'SOL only, below' }));
    expect(open.textContent).toContain('This range is below this pool’s price, so it holds SOL only.');
    expect(within(open).getByLabelText(/How much SOL to put in/)).toBeTruthy();
  });

  it('typed prices the wrong way round are refused in words', async () => {
    show(readers());
    const open = await screen.findByTestId('range-open');
    fireEvent.change(within(open).getByLabelText(/Lowest price/), { target: { value: '0.0005' } });
    fireEvent.change(within(open).getByLabelText(/Highest price/), { target: { value: '0.0002' } });
    expect(within(open).getByRole('alert').textContent).toBe('The lowest price must be below the highest.');
  });

  it('Review asks the builder for exactly the range, side, amount and tolerance on screen', async () => {
    wallet.publicKey = ME;
    wallet.signTransaction = vi.fn();
    const api = fakeApi();
    const r = readers();
    show(r, api);
    const open = await screen.findByTestId('range-open');
    fireEvent.click(within(open).getByRole('button', { name: 'Wide' }));
    fireEvent.change(within(open).getByLabelText(/How much BAYLA to put in/), { target: { value: '2.5' } });
    const review = await within(open).findByRole('button', { name: 'Review: open this position' });
    await waitFor(() => expect((review as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(review);
    await waitFor(() => expect(api.prepareRangeOpen).toHaveBeenCalledTimes(1));
    const [, gotCfg, gotProgram, gotReads, args] = vi.mocked(api.prepareRangeOpen).mock.calls[0]!;
    expect(gotCfg).toBe(cfg);
    expect(gotProgram.equals(PROG)).toBe(true);
    // The opening's market check asks the section's own reader, which refuses a range pool's price.
    expect(gotReads).toBe(r);
    expect(args.owner.equals(ME)).toBe(true);
    expect(args.pool.equals(POOL)).toBe(true);
    expect([args.side, args.amount, args.toleranceBps]).toEqual(['token', 2_500_000n, 100]);
    expect(args.tickLower).toBeLessThan(TICK);
    expect(args.tickUpper).toBeGreaterThan(TICK);
    await within(open).findByText(/The fake builder built nothing/);
  });

  it('with LP’s switch on withdraw-only, amounts are worked out but nothing can be opened', async () => {
    wallet.publicKey = ME;
    wallet.signTransaction = vi.fn();
    show(readers(), fakeApi(), 'withdraw-only');
    const open = await screen.findByTestId('range-open');
    fireEvent.click(within(open).getByRole('button', { name: 'Wide' }));
    fireEvent.change(within(open).getByLabelText(/How much BAYLA to put in/), { target: { value: '2.5' } });
    const review = await within(open).findByRole('button', { name: 'Review: open this position' });
    expect((review as HTMLButtonElement).disabled).toBe(true);
    expect(open.textContent).toContain('opening a position is not switched on here');
  });
});

describe('your positions', () => {
  it('asks for a wallet first', async () => {
    show(readers());
    const card = await screen.findByTestId('range-positions');
    expect(card.textContent).toContain('Connect a wallet to see the range positions it holds.');
  });

  it('says in range or not, the fees, and offers Claim, Remove and Close; a fee it could not work out is said, never zero', async () => {
    wallet.publicKey = ME;
    wallet.signTransaction = vi.fn();
    const rp = poolOn(tier());
    const api = fakeApi();
    show(
      readers({
        positions: {
          kind: 'ok',
          value: {
            positions: [
              positionOf({ n: 1, lower: TICK - 1200 - (TICK % 120), upper: TICK + 1200 - (TICK % 120), status: 'in-range', fees: { fee0: 5_000_000n, fee1: 7_000_000n } }, rp),
              positionOf({ n: 2, lower: TICK + 2400 - (TICK % 120), upper: TICK + 3600 - (TICK % 120), status: 'below', fees: null }, rp),
            ],
            unread: [{ position: key(99).toBase58(), detail: 'its pool or the pool’s fee tier did not read' }],
          },
        },
      }),
      api,
    );
    const card = await screen.findByTestId('range-positions');
    const rows = await within(card).findAllByTestId('range-position');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('In range: earning fees now.');
    expect(rows[1]!.textContent).toContain('Out of range (the price is below it): earning nothing until the price comes back into it.');
    expect(rows[1]!.textContent).toContain('could not be worked out just now; Claim pays them in full all the same');
    expect(card.textContent).toContain(`A position (${key(99).toBase58()}) could not be read just now`);
    // Claim asks for a take of nothing; Close for the closing.
    const claim = within(rows[0]!).getByRole('button', { name: 'Claim fees' });
    await waitFor(() => expect((claim as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(claim);
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Review: claim fees' }));
    await waitFor(() => expect(api.prepareRangeRemove).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.prepareRangeRemove).mock.calls[0]![3]).toMatchObject({ percent: 0 });
  });

  it('Close asks for the closing of that position', async () => {
    wallet.publicKey = ME;
    wallet.signTransaction = vi.fn();
    const rp = poolOn(tier());
    const api = fakeApi();
    const w = positionOf({ n: 3, lower: -1200, upper: 1200, status: 'in-range', fees: { fee0: 0n, fee1: 0n } }, rp);
    show(readers({ positions: { kind: 'ok', value: { positions: [w], unread: [] } } }), api);
    const row = await screen.findByTestId('range-position');
    // No fees earned: nothing to claim.
    await waitFor(() => expect((within(row).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(false));
    expect((within(row).getByRole('button', { name: 'Claim fees' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(row).getByRole('button', { name: 'Close' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Review: close the position' }));
    await waitFor(() => expect(api.prepareRangeClose).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.prepareRangeClose).mock.calls[0]![3].position.toBase58()).toBe(w.position.address);
  });

  it('a position held as a classic SPL-Token NFT is listed, says this site cannot take it out yet, and offers no button that would fail', async () => {
    wallet.publicKey = ME;
    wallet.signTransaction = vi.fn();
    const rp = poolOn(tier());
    const w = positionOf({ n: 5, lower: -1200, upper: 1200, status: 'in-range', fees: { fee0: 3n, fee1: 4n }, nftProgram: 'token' }, rp);
    show(readers({ positions: { kind: 'ok', value: { positions: [w], unread: [] } } }));
    const row = await screen.findByTestId('range-position');
    expect(row).toHaveTextContent(w.position.address);
    expect(row).toHaveTextContent('This position’s NFT is a classic SPL token, and this site takes out only positions whose NFT is a Token-2022 one');
    expect(row).toHaveTextContent('It is still yours');
    for (const name of ['Claim fees', 'Remove', 'Close']) expect(within(row).queryByRole('button', { name })).toBeNull();
  });

  it('positions that did not read are said as unread, never as none', async () => {
    wallet.publicKey = ME;
    show(readers({ positions: { kind: 'unread', detail: 'down' } }));
    const card = await screen.findByTestId('range-positions');
    await waitFor(() => expect(card.textContent).toContain('Your positions could not be read just now. This does not mean you have none.'));
  });

  it('with LP’s switch off, no write code is fetched and nothing can be taken out', async () => {
    wallet.publicKey = ME;
    const rp = poolOn(tier());
    const load = show(readers({ positions: { kind: 'ok', value: { positions: [positionOf({ n: 4, lower: -1200, upper: 1200, status: 'in-range', fees: null }, rp)], unread: [] } } }), fakeApi(), 'off');
    const row = await screen.findByTestId('range-position');
    expect((within(row).getByRole('button', { name: 'Claim fees' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('range-positions').textContent).toContain('Claiming and taking out are not switched on here yet.');
    expect(load).not.toHaveBeenCalled();
  });
});

describe('the words', () => {
  it('carry no em dash', async () => {
    wallet.publicKey = ME;
    const rp = poolOn(tier());
    show(readers({ positions: { kind: 'ok', value: { positions: [positionOf({ n: 5, lower: -1200, upper: 1200, status: 'above', fees: null }, rp)], unread: [] } } }));
    await screen.findByTestId('range-position');
    const open = await screen.findByTestId('range-open');
    fireEvent.click(within(open).getByRole('button', { name: 'BAYLA only, above this pool’s price' }));
    expect(document.body.textContent).not.toContain('—');
  });
});

/** A built opening as the review shows it: the agreed split, both coins in. */
function openSummary(): RangeSummary {
  return {
    kind: 'range-open',
    nftMint: key(30),
    max: { token: 2_500_000n, quote: 800_000n },
    quoted: { token: 2_475_000n, quote: 792_000n },
    rentLamports: 9_375_120n,
    unwrapsWsol: true,
    notices: [],
    warnings: [],
    price: { state: 'agrees', pool: 0.0003, reference: 0.0003, diff: 0 },
    poolLine: {
      feeCeiling: null,
      pool: POOL, tokenMint: new PublicKey(BAYLA_MINT), tokenDecimals: 6, quote: SOL_QUOTE, tokenIsToken0: BAYLA_IS_0,
      tradeFeeRate: 10_000, venueShareRate: 160_000, protocolFeeRate: 104_000, fundFeeRate: 56_000,
      owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58(),
    },
    range: { tickLower: TICK - 1_200, tickUpper: TICK + 1_200, minPrice: 0.00027, maxPrice: 0.00033, holds: 'both' },
  };
}

describe('the risks, beside the deposit and on the review', () => {
  it('the deposit has a Risks list: what the vault can do, its wait as read, no outside review; a band’s deposit never comes back', async () => {
    show(readers());
    const open = await screen.findByTestId('range-open');
    const risks = within(open).getByTestId('range-risks');
    expect(risks).toHaveTextContent(RANGE_RISK_SHORT);
    expect(risks).toHaveTextContent(/each of its actions waits 48 hours, as read on chain on 2026-10-21/);
    expect(risks).toHaveTextContent(/switch off openings, withdrawals or swaps on a range pool/);
    expect(risks).toHaveTextContent(/replace the range program/);
    expect(risks).toHaveTextContent(/Those changes have not had an outside review/);
    expect(risks).toHaveTextContent(/applies to positions already open in its pools/);
    expect(risks).toHaveTextContent(/Jupiter does not send trades to range pools/);
    // With range pools in the swap route, the site's own swap is where their trades come from.
    expect(risks).toHaveTextContent(/This site’s own swap sends a trade to one only when it pays the trader at least as much as Jupiter does/);
    const earns = screen.getByTestId('range-earns');
    // Rent is the chain's to say (mainnet's fell: 0.0527 SOL a band on 2026-10-24, not 0.072): the review reads it, the fine print names no figure.
    expect(earns).toHaveTextContent(/A band of prices nobody has used yet also takes a deposit that never comes back; Review shows how much, read from the chain\./);
    expect(earns).not.toHaveTextContent(/\d SOL each/);
    expect(earns).not.toHaveTextContent(/refundable/);
    expect(earns).not.toHaveTextContent(/The range program is the venue’s own/);
  });

  it('a prepared opening shows the review with the risk lines above its rows', async () => {
    wallet.publicKey = ME;
    wallet.signTransaction = vi.fn();
    const api = fakeApi();
    vi.mocked(api.prepareRangeOpen).mockResolvedValue({ ok: true, prepared: prepared(openSummary()) });
    show(readers(), api);
    const open = await screen.findByTestId('range-open');
    fireEvent.click(within(open).getByRole('button', { name: 'Wide' }));
    fireEvent.change(within(open).getByLabelText(/How much BAYLA to put in/), { target: { value: '2.5' } });
    const review = await within(open).findByRole('button', { name: 'Review: open this position' });
    await waitFor(() => expect((review as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(review);
    const disclosure = await within(open).findByTestId('range-review-disclosure');
    expect(disclosure).toHaveTextContent(RANGE_RISK_SHORT);
    expect(disclosure).toHaveTextContent(/you could not take your money out until it switched them back on/);
  });
});
