import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import * as validate from '../../../lib/launchMetadata/validate.js';
import { BAYLA_MINT, WSOL_MINT } from '../../../lib/solana/lp/tokenSafety';
import { decodeAmmConfig, decodePersonalPosition, decodePoolState, sortMints, type AmmConfigView } from '../../../lib/solana/clmm/program';
import { getTickAtSqrtPrice } from '../../../lib/solana/clmm/math';
import { encodeAmmConfig, encodePool, encodePosition } from '../../../lib/solana/clmm/encode.fixture';
import type { RangePool, Read, WalletPosition, WalletPositionsRead } from '../../../lib/solana/clmm/read';
import type { CurveWriteConfig, Prepared, RangeWriteApi } from '../curve/ports';
import { PLATFORM_TREASURY_VAULT } from '../../../lib/launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../../lib/launcher/solana/write/plant';
import { RangeInner, type RangeReaders } from './RangeSection';

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

function positionOf(o: { n: number; lower: number; upper: number; status: WalletPosition['status']; fees: WalletPosition['fees']; liquidity?: bigint }, rp: RangePool): WalletPosition {
  const nft = key(40 + o.n);
  const position = decodePersonalPosition(key(60 + o.n).toBase58(), encodePosition({ nftMint: nft, pool: POOL, tickLower: o.lower, tickUpper: o.upper, liquidity: o.liquidity ?? 10n ** 9n }))!;
  return { position, nftAccount: key(80 + o.n).toBase58(), pool: rp.pool, config: rp.config, status: o.status, amounts: { amount0: 1_000_000n, amount1: 2_000_000_000n }, fees: o.fees, rewardsOwed: [0n, 0n, 0n] };
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
    meta: { displaySafe: validate.displaySafe },
  };
}

function readers(o: { tiers?: Read<AmmConfigView[]>; pools?: Read<RangePool[]>; positions?: Read<WalletPositionsRead> } = {}): RangeReaders {
  const t = tier();
  return {
    programId: PROG,
    feeTiers: vi.fn(async () => o.tiers ?? { kind: 'ok' as const, value: [t] }),
    pairPools: vi.fn(async () => o.pools ?? { kind: 'ok' as const, value: [poolOn(t)] }),
    walletPositions: vi.fn(async () => o.positions ?? { kind: 'ok' as const, value: { positions: [], unread: [] } }),
    outsidePrice: vi.fn(async () => ({ kind: 'no-route' as const, detail: 'Jupiter has no route for this token' })),
  };
}

function show(r: RangeReaders, api: RangeWriteApi | null = fakeApi(), mode: 'on' | 'withdraw-only' | 'off' = 'on') {
  const load = vi.fn(async () => api!);
  render(
    <MemoryRouter>
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
    const split = within(card).getByText(/The venue’s cut is split: 65% to the team’s shared wallet, .* and 35% to the island’s Workshop, the island’s agreed share\./);
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
    expect(flag.querySelector('strong')?.textContent).toMatch(/goes somewhere other than the agreed split .*: the island’s part/);
    expect(flag.textContent).toContain(stranger.toBase58());
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
  it('fee tiers that did not read are said as unread, never as no pools', async () => {
    show(readers({ tiers: { kind: 'unread', detail: 'down' } }));
    const card = await screen.findByTestId('range-pools');
    await waitFor(() => expect(card.textContent).toContain('could not be read just now. This does not mean there are none.'));
    expect(card.textContent).not.toContain('No range pool');
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
    expect(card.textContent).toContain('Price now 0.0003 SOL per BAYLA');
  });
});

describe('picking a range', () => {
  it('BAYLA only, above today’s price: holds BAYLA only, takes no SOL, and says it earns nothing until the price rises', async () => {
    show(readers());
    const open = await screen.findByTestId('range-open');
    fireEvent.click(within(open).getByRole('button', { name: 'BAYLA only, above today’s price' }));
    expect(open.textContent).toContain('This range is above today’s price, so it holds BAYLA only.');
    fireEvent.change(within(open).getByLabelText(/How much BAYLA to put in/), { target: { value: '1000' } });
    const plan = await within(open).findByTestId('range-plan');
    expect(plan.textContent).toMatch(/You put in about\s*1,000 BAYLA and 0 SOL/);
  });

  it('SOL only, below: holds SOL only and the amount is of SOL', async () => {
    show(readers());
    const open = await screen.findByTestId('range-open');
    fireEvent.click(within(open).getByRole('button', { name: 'SOL only, below' }));
    expect(open.textContent).toContain('This range is below today’s price, so it holds SOL only.');
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
    fireEvent.click(within(open).getByRole('button', { name: 'BAYLA only, above today’s price' }));
    expect(document.body.textContent).not.toContain('—');
  });
});
