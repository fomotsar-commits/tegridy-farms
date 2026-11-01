// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../solanaPolyfill';
import { Connection, PublicKey } from '@solana/web3.js';
// The dashboard's Solana reads. Loaded only once a Solana wallet is connected (useWalletBoard's
// dynamic import), so a visitor who never connects Solana never downloads any of it.
//
// Every read here is an existing reader, wired the way its own page wires it:
// holdings through the LP pages' transport (getTokenAccountsByOwner, both token programs), the
// lock ladder through readLadderPool/readLadderWallet + earnedNow (SolanaLadderPoolLive), the
// Streamflow stakes through readEntries/readPool (LighthousePoolLive), and the pool shares
// through the LP section's own readers.positions (YourPositions). Each says when it could not
// read, and that is passed on as an unread leg, never as an empty one.
import { browserRpc, type SolanaRpc } from '../launcher/solana/curve/rpc';
import { withReadCommitment } from '../../components/solana/curve/confirmedRpc';
import { browserLpReaders } from '../../components/solana/lp/readers';
import { lpFetch } from '../solana/lp/readFetch';
import { noteResponse } from '../solana/lp/rpcBudget';
import { getMultipleAccounts, getTokenAccountsByOwner } from '../solana/lp/accounts';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT, decodeMintAccount } from '../solana/lp/tokenSafety';
import { getUsdPrices } from '../jupiter';
import { solanaRpcEndpoint } from '../solana';
import { readLadderPool, readLadderWallet } from '../ladder/read';
import { earnedNow, isLadderConfigured, ladderProgramId } from '../ladder/program';
import { boostLabel } from '../ladder/format';
import { readEntries, readPool, unlockTs } from '../bungalowStaking';
import { BUNGALOWS, bungalowByAddress, type Bungalow } from '../bungalows';
import { clipReason, fmtAmount, islandCoinsOn, unlockWords, usdOf, type HoldingRow, type Leg, type PositionRow, type StakeTarget } from './walletRows';

const SOL_DECIMALS = 9;
const toBase58 = (b: Uint8Array) => new PublicKey(b).toBase58();
const nowSecs = () => Math.floor(Date.now() / 1000);

function chainRpc(): SolanaRpc {
  return withReadCommitment(browserRpc(lpFetch({ what: 'the chain', onResponse: noteResponse })), 'confirmed');
}

type PriceRead = (mints: string[]) => Promise<Record<string, number>>;

const PRICE_HOLD_MS = 30_000;
let heldPrices: { at: number; read: Promise<Record<string, number>> } | null = null;

/**
 * USD prices for the board's figures. SOL, USDC and every island coin on Solana are one fixed list,
 * read at the proxy's shared 30 s (getUsdPrices `shared`: display only, it sizes no trade) and held
 * here as long, so every leg of a board read shares one call: the free Jupiter key is one call a
 * second, site-wide. A coin off that list (a pool share in a coin the island does not list) is
 * asked for on its own.
 */
export async function boardPrices(mints: string[]): Promise<Record<string, number>> {
  const listed = [WSOL_MINT, USDC_MINT, ...islandCoinsOn('solana').map((c) => c.address!)];
  if (!heldPrices || Date.now() - heldPrices.at > PRICE_HOLD_MS) {
    const read = getUsdPrices(listed, undefined, { shared: true });
    heldPrices = { at: Date.now(), read };
    // A failed read is not held: the next leg asks again.
    read.catch(() => { if (heldPrices?.read === read) heldPrices = null; });
  }
  const prices = await heldPrices.read;
  const others = mints.filter((m) => !listed.includes(m));
  return others.length ? { ...prices, ...(await getUsdPrices(others)) } : prices;
}

/** Test seam. A held price that survives between tests is a flake farm. */
export function __resetBoardPricesForTests(): void {
  heldPrices = null;
}

/** Prices for a leg's figures. A price that does not come back leaves that USD out; it never fails the leg. */
async function pricesOrNone(priceOf: PriceRead, mints: string[]): Promise<Record<string, number>> {
  try {
    return await priceOf(mints);
  } catch {
    return {};
  }
}

function lamportsOf(payload: unknown): bigint {
  const v = (payload as { value?: unknown } | null)?.value;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('getBalance: the response carried no balance');
  return BigInt(v);
}

/** SOL and every island coin on Solana the wallet holds, with USD where Jupiter priced it. */
export async function readSolanaHoldings(
  owner: string,
  opts: { rpc?: SolanaRpc; coins?: readonly Bungalow[]; prices?: PriceRead } = {},
): Promise<Leg<HoldingRow>> {
  const rpc = opts.rpc ?? chainRpc();
  const coins = opts.coins ?? islandCoinsOn('solana');
  const priceOf = opts.prices ?? boardPrices;
  try {
    const [balance, classic, t22] = await Promise.all([
      rpc('getBalance', [owner, { commitment: 'confirmed' }]),
      getTokenAccountsByOwner(rpc, owner, TOKEN_PROGRAM, toBase58),
      getTokenAccountsByOwner(rpc, owner, TOKEN_2022_PROGRAM, toBase58),
    ]);
    const lamports = lamportsOf(balance);
    const byMint = new Map<string, bigint>();
    const island = new Set(coins.map((c) => c.address!));
    for (const t of [...classic, ...t22]) {
      if (island.has(t.mint) && t.amount > 0n) byMint.set(t.mint, (byMint.get(t.mint) ?? 0n) + t.amount);
    }
    const held = coins.filter((c) => byMint.has(c.address!));
    // Decimals read off each mint, never assumed: a wrong decimals is a wrong amount.
    const mints = held.length ? await getMultipleAccounts(rpc, held.map((c) => c.address!)) : [];
    const decimals = new Map<string, number>();
    mints.forEach((a, i) => {
      const d = a ? decodeMintAccount(a.owner, a.data) : null;
      if (!d || !d.ok) throw new Error(`${held[i]!.symbol}'s mint could not be read`);
      decimals.set(held[i]!.address!, d.value.decimals);
    });
    const prices = await pricesOrNone(priceOf, [WSOL_MINT, ...held.map((c) => c.address!)]);
    const rows: HoldingRow[] = [];
    if (lamports > 0n) {
      rows.push({ key: 'sol', symbol: 'SOL', chain: 'solana', amount: fmtAmount(lamports, SOL_DECIMALS), usd: usdOf(lamports, SOL_DECIMALS, prices[WSOL_MINT]), roomId: null, to: null });
    }
    for (const c of held) {
      const raw = byMint.get(c.address!)!;
      const dec = decimals.get(c.address!)!;
      rows.push({ key: `sol:${c.id}`, symbol: c.symbol, chain: 'solana', amount: fmtAmount(raw, dec), usd: usdOf(raw, dec, prices[c.address!]), roomId: c.id, to: `/${c.id}` });
    }
    return { status: 'ok', rows };
  } catch (e) {
    return { status: 'unread', detail: clipReason(e) };
  }
}

/** The wallet's open BAYLA lock-ladder positions: amount, unlock, multiplier, earned and worth. */
export async function readSolanaLadder(owner: string, opts: { prices?: PriceRead } = {}): Promise<Leg<PositionRow>> {
  const room = BUNGALOWS.find((b) => b.live && b.chain === 'solana' && b.ladderPool);
  if (!room?.ladderPool || !isLadderConfigured()) return { status: 'ok', rows: [] };
  try {
    const conn = new Connection(solanaRpcEndpoint(), 'confirmed');
    const programId = ladderProgramId();
    const pool = new PublicKey(room.ladderPool);
    const [p, w] = await Promise.all([
      readLadderPool(conn, programId, pool),
      readLadderWallet(conn, programId, pool, new PublicKey(owner)),
    ]);
    if (!w.ok) return { status: 'unread', detail: w.reason };
    if (!w.value.stats) return { status: 'ok', rows: [] };
    if (w.value.truncated || w.value.slots.some((s) => s.state === 'unreadable')) {
      return { status: 'unread', detail: 'some of your locks could not be read' };
    }
    if (!w.value.open.length) return { status: 'ok', rows: [] };
    if (!p.ok) return { status: 'unread', detail: p.reason };
    const prices = await pricesOrNone(opts.prices ?? boardPrices, [room.address!]);
    const now = nowSecs();
    const rows = w.value.open.map((pos): PositionRow => {
      const facts = [
        `${fmtAmount(pos.amountRaw, p.value.decimals)} ${room.symbol}`,
        unlockWords(Number(pos.lockEnd), now),
      ];
      if (pos.amountRaw > 0n) facts.push(boostLabel(Number((pos.weight * 10_000n) / pos.amountRaw)));
      facts.push(`earned ${fmtAmount(earnedNow(pos, p.value, now), p.value.decimals)} ${room.symbol}`);
      return {
        key: `ladder:${pos.address}`, roomId: room.id, chain: 'solana', title: `${room.symbol} lock`, facts,
        usd: usdOf(pos.amountRaw, p.value.decimals, prices[room.address!]), to: `/earn/${room.id}`,
      };
    });
    return { status: 'ok', rows };
  } catch (e) {
    return { status: 'unread', detail: clipReason(e) };
  }
}

/** The wallet's open stakes in one Streamflow pool: amount, unlock and worth. Rewards are on its page. */
export async function readSolanaStakes(owner: string, target: StakeTarget, opts: { prices?: PriceRead } = {}): Promise<Leg<PositionRow>> {
  try {
    const entries = await readEntries(target.pool, owner);
    if (!entries.ok) return { status: 'unread', detail: entries.reason };
    const open = entries.entries.filter((e) => e.closedTs === 0);
    if (!open.length) return { status: 'ok', rows: [] };
    // Decimals as the pool reads them on chain, only for a pool the wallet is in.
    const pool = await readPool(target.pool);
    if (!pool.ok) return { status: 'unread', detail: pool.reason };
    const prices = await pricesOrNone(opts.prices ?? boardPrices, [target.room.address!]);
    const now = nowSecs();
    const rows = open.map((e): PositionRow => ({
      key: `stake:${target.pool}:${e.address}`,
      roomId: target.room.id,
      chain: 'solana',
      title: target.retired ? `${target.room.symbol} stake, old pool` : `${target.room.symbol} stake`,
      facts: [`${fmtAmount(e.amountRaw, pool.pool.decimals)} ${target.room.symbol}`, unlockWords(unlockTs(e), now)],
      usd: usdOf(e.amountRaw, pool.pool.decimals, prices[target.room.address!]),
      to: `/earn/${target.room.id}`,
    }));
    return { status: 'ok', rows };
  } catch (e) {
    return { status: 'unread', detail: clipReason(e) };
  }
}

/** The wallet's shares in the venue's own Solana pools: its share, what it pays out now, and its worth. */
export async function readSolanaPoolShares(owner: string, opts: { prices?: PriceRead } = {}): Promise<Leg<PositionRow>> {
  const readers = browserLpReaders();
  if (!readers) return { status: 'ok', rows: [] };
  try {
    const read = await readers.positions(new PublicKey(owner));
    if (read.kind === 'unread') return { status: 'unread', detail: read.detail };
    if (read.positions.length < read.totalShares) {
      return { status: 'unread', detail: 'some of your pool shares could not be placed yet' };
    }
    // Both sides of every share that paid out a figure, priced in one read.
    const valued = read.positions.flatMap((p) => (p.pool?.kind === 'pool' && !p.tooSmall && p.value ? [p.pool.view] : []));
    const prices = valued.length
      ? await pricesOrNone(opts.prices ?? boardPrices, [...new Set(valued.flatMap((v) => [v.tokenMint, v.quote.mint]))])
      : {};
    const rows = read.positions.map((p): PositionRow => {
      if (p.pool?.kind !== 'pool') {
        return { key: `lp:${p.lpAccount}`, roomId: null, chain: 'solana', title: 'Pool share', facts: ['its pool could not be read just now'], usd: null, to: '/pools' };
      }
      const view = p.pool.view;
      const room = bungalowByAddress('solana', view.tokenMint);
      const symbol = room?.symbol ?? `${view.tokenMint.slice(0, 4)}…`;
      // A coin the island does not list, paired with one it does (a pool quoted in BAYLA): the
      // share belongs to the island coin's room, so that room's dashboard lists it too.
      const home = room ?? bungalowByAddress('solana', view.quote.mint);
      const facts: string[] = [];
      let usd: number | null = null;
      if (p.tooSmall) facts.push('too small to withdraw');
      else if (p.value) {
        const tokenDec = view.quoteIsToken0 ? view.snapshot.pool.mint1Decimals : view.snapshot.pool.mint0Decimals;
        const tokenSide = view.quoteIsToken0 ? p.value.token1 : p.value.token0;
        const quoteSide = view.quoteIsToken0 ? p.value.token0 : p.value.token1;
        facts.push(`${p.value.sharePct < 0.01 ? '<0.01' : p.value.sharePct.toFixed(2)}% of the pool`);
        facts.push(`${fmtAmount(tokenSide, tokenDec)} ${symbol} + ${fmtAmount(quoteSide, view.quote.decimals)} ${view.quote.symbol}`);
        // Both sides priced, or no figure: half a share's worth would read as all of it.
        const tokenUsd = usdOf(tokenSide, tokenDec, prices[view.tokenMint]);
        const quoteUsd = usdOf(quoteSide, view.quote.decimals, prices[view.quote.mint]);
        usd = tokenUsd !== null && quoteUsd !== null ? tokenUsd + quoteUsd : null;
      } else facts.push('its value could not be read just now');
      return { key: `lp:${p.lpAccount}`, roomId: home?.id ?? null, chain: 'solana', title: `${symbol} / ${view.quote.symbol} pool`, facts, usd, to: '/pools' };
    });
    return { status: 'ok', rows };
  } catch (e) {
    return { status: 'unread', detail: clipReason(e) };
  }
}
