import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useBalance, useReadContracts } from 'wagmi';
import { ERC20_ABI, LIGHTHOUSE_LADDER_ABI } from '../lib/contracts';
import { useSolanaSurface } from '../lib/solanaSurface';
import { useUserPosition } from './useUserPosition';
import { useMarketFeed } from './useMarketFeed';
import { islandPoolsOn } from '../lib/terminal/islandPools';
import { useTOWELIPriceOptional } from '../contexts/PriceContext';
import { BUNGALOWS } from '../lib/bungalows';
import {
  OTHER_COIN_MIN_USD,
  evmLadderRooms,
  fmtAmount,
  islandCoinsOn,
  solanaStakePools,
  unlockWords,
  usdOf,
  type HoldingRow,
  type Leg,
  type NamedLeg,
  type PositionRow,
  type WalletChain,
} from '../lib/wallet/walletRows';
import { isHoldingRow, isPositionRow, recallWallet, rememberLegs } from '../lib/wallet/boardMemory';
import { evmTicker, fetchWalletCoins, type EvmWalletChain, type WalletCoinsRead } from '../lib/wallet/walletCoins';

/**
 * The dashboard's reads for the connected wallets (owner, 2026-10-22: "positions on the website
 * and what the wallet holds"): the Solana wallet the site is connected to (the page's or the top
 * bar's connection, lib/solanaSurface.ts) and the Ethereum account (wagmi), each read on its own.
 *
 * Every leg is loading, read, or not read, never a zero for a read that failed
 * (lib/wallet/walletRows.ts). The Solana code loads only once a Solana wallet is connected.
 * While a leg is first read, its last read in this browser is drawn, marked with when it was
 * read (lib/wallet/boardMemory.ts), so a wallet seen before draws at once.
 */
export interface WalletBoard {
  solanaAddress: string | null;
  evmAddress: string | null;
  holdings: NamedLeg<HoldingRow>[];
  positions: NamedLeg<PositionRow>[];
  refresh: () => void;
}

const CHAIN_IDS: Record<Exclude<WalletChain, 'solana'>, number> = { ethereum: 1, base: 8453 };
const nowSecs = () => Math.floor(Date.now() / 1000);
/** A Solana part that failed is asked again after each of these waits before it says so. */
const RETRY_WAITS_MS = [1_500, 4_000];
/** A part that could not be read is read again this often while the page is in view. */
export const HEAL_MS = 20_000;

// ── Solana: one dynamic import, then each leg on its own ──────────────────────────────────────

type SolanaJob = { key: string; what: string; kind: 'holdings' | 'positions'; run: (owner: string) => Promise<Leg<HoldingRow> | Leg<PositionRow>> };

function solanaJobs(): SolanaJob[] {
  const load = () => import('../lib/wallet/readSolanaWallet');
  const ladderRoom = BUNGALOWS.find((b) => b.live && b.chain === 'solana' && b.ladderPool);
  return [
    { key: 'sol-holdings', what: 'your Solana coins', kind: 'holdings', run: async (o) => (await load()).readSolanaHoldings(o) },
    { key: 'sol-other', what: 'your other Solana coins', kind: 'holdings', run: async (o) => (await load()).readSolanaOtherCoins(o) },
    ...(ladderRoom
      ? [{ key: 'sol-ladder', what: `your ${ladderRoom.symbol} locks`, kind: 'positions' as const, run: async (o: string) => (await load()).readSolanaLadder(o) }]
      : []),
    { key: 'sol-lp', what: 'your pool shares on Solana', kind: 'positions', run: async (o) => (await load()).readSolanaPoolShares(o) },
    ...solanaStakePools().map((t) => ({
      key: `sol-stake:${t.pool}`,
      what: t.retired ? `your ${t.room.symbol} stakes in its old pool` : `your ${t.room.symbol} stakes`,
      kind: 'positions' as const,
      run: async (o: string) => (await load()).readSolanaStakes(o, t),
    })),
  ];
}

function useSolanaLegs(owner: string | null, nonce: number) {
  const jobs = useMemo(() => solanaJobs(), []);
  // Each leg's answer is kept with the wallet it was read for, so a switch of wallet never shows
  // the last wallet's rows under the new address while the new reads are in flight.
  const [legs, setLegs] = useState<Record<string, { owner: string; leg: Leg<HoldingRow> | Leg<PositionRow> }>>({});
  const gen = useRef(0);

  // A read lands in state only when its answer arrives, and only if no newer round started. A
  // read that fails is asked again, twice, before it lands as unread (owner, 2026-11-01: the
  // dashboard "sometimes has troubles showing the positions and tokens ... so it never does
  // that"): most failures are a busy relay or a slow node, gone a few seconds later.
  const launch = useCallback((job: SolanaJob, o: string) => {
    const g = gen.current;
    const live = () => gen.current === g;
    const once = () => job.run(o).catch((e: unknown): Leg<HoldingRow> => ({ status: 'unread', detail: e instanceof Error ? e.message : 'the Solana code could not load' }));
    void (async () => {
      let leg = await once();
      for (const ms of RETRY_WAITS_MS) {
        if (leg.status !== 'unread' || !live()) break;
        await new Promise((r) => setTimeout(r, ms));
        if (!live()) return;
        leg = await once();
      }
      if (live()) setLegs((m) => ({ ...m, [job.key]: { owner: o, leg } }));
    })();
  }, []);

  useEffect(() => {
    gen.current += 1;
    if (!owner) return;
    // A new wallet reads as "reading" by the owner check below; a Refresh keeps what is on
    // screen until the new answers land.
    for (const job of jobs) launch(job, owner);
  }, [owner, nonce, jobs, launch]);

  // Try again is a press, so it may show "reading" at once.
  const retry = useCallback((key: string) => {
    const job = jobs.find((j) => j.key === key);
    if (!job || !owner) return;
    setLegs((m) => ({ ...m, [job.key]: { owner, leg: { status: 'loading' } } }));
    launch(job, owner);
  }, [jobs, owner, launch]);

  const named = (kind: SolanaJob['kind']) =>
    owner
      ? jobs
          .filter((j) => j.kind === kind)
          .map((j) => {
            const held = legs[j.key];
            return {
              key: j.key,
              what: j.what,
              leg: held && held.owner === owner ? held.leg : { status: 'loading' as const },
              retry: () => retry(j.key),
            };
          })
      : [];
  return {
    holdings: named('holdings') as NamedLeg<HoldingRow>[],
    positions: named('positions') as NamedLeg<PositionRow>[],
  };
}

// ── Ethereum and Base: wagmi reads, each entry pinned to its chain ────────────────────────────

/** A token's price on GeckoTerminal's island pools, by lower-cased token address. */
function useEvmPrices(enabled: boolean): Map<string, number> {
  const eth = useMarketFeed(enabled ? { view: 'multi', network: 'eth', pools: islandPoolsOn('eth') } : null);
  const base = useMarketFeed(enabled ? { view: 'multi', network: 'base', pools: islandPoolsOn('base') } : null);
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const s of [eth.state, base.state]) {
      if (s.status !== 'ready') continue;
      for (const r of s.rows) if (r.priceUsd !== null && !r.withheld) m.set(r.token.toLowerCase(), r.priceUsd);
    }
    return m;
  }, [eth.state, base.state]);
}

function useEvmLegs(user: `0x${string}` | undefined, nonce: number) {
  const enabled = Boolean(user);
  const coins = useMemo(() => [...islandCoinsOn('ethereum'), ...islandCoinsOn('base')], []);
  const ladders = useMemo(() => evmLadderRooms(), []);
  const addr = user ?? '0x0000000000000000000000000000000000000000';

  const ethNative = useBalance({ address: addr, chainId: CHAIN_IDS.ethereum, query: { enabled } });
  const baseNative = useBalance({ address: addr, chainId: CHAIN_IDS.base, query: { enabled } });
  const tokens = useReadContracts({
    contracts: coins.flatMap((c) => {
      const t = { address: c.address as `0x${string}`, abi: ERC20_ABI, chainId: CHAIN_IDS[c.chain as 'ethereum' | 'base'] } as const;
      return [{ ...t, functionName: 'balanceOf', args: [addr] } as const, { ...t, functionName: 'decimals' } as const];
    }),
    query: { enabled },
  });
  const ladderReads = useReadContracts({
    contracts: ladders.flatMap((b) => {
      const p = { address: b.stakePool as `0x${string}`, abi: LIGHTHOUSE_LADDER_ABI, chainId: CHAIN_IDS[b.chain as 'ethereum' | 'base'] } as const;
      return [{ ...p, functionName: 'earned', args: [addr] } as const, { ...p, functionName: 'positionsOf', args: [addr] } as const];
    }),
    query: { enabled },
  });
  const idsOf = (i: number): readonly bigint[] | null => {
    const r = ladderReads.data?.[i * 2 + 1];
    return r?.status === 'success' ? (r.result as readonly bigint[]) : null;
  };
  const posTargets = ladders.flatMap((b, i) => (idsOf(i) ?? []).map((id) => ({ b, i, id })));
  const posReads = useReadContracts({
    contracts: posTargets.map(({ b, id }) => ({
      address: b.stakePool as `0x${string}`,
      abi: LIGHTHOUSE_LADDER_ABI,
      chainId: CHAIN_IDS[b.chain as 'ethereum' | 'base'],
      functionName: 'positions' as const,
      args: [id] as const,
    })),
    query: { enabled: enabled && posTargets.length > 0 },
  });
  // Every other coin the wallet holds on each chain (lib/wallet/walletCoins.ts): which coins and
  // their prices from the server's list; each balance, decimals and ticker from the coin itself.
  // A new read keeps the last list on screen until it lands.
  const [listTick, setListTick] = useState(0);
  const [lists, setLists] = useState<{ user: string; reads: Record<EvmWalletChain, WalletCoinsRead> } | null>(null);
  useEffect(() => {
    if (!user) return;
    let live = true;
    void Promise.all([fetchWalletCoins('ethereum', user), fetchWalletCoins('base', user)]).then(([ethereum, base]) => {
      if (live) setLists({ user, reads: { ethereum, base } });
    });
    return () => { live = false; };
  }, [user, nonce, listTick]);
  const listOf = (c: EvmWalletChain): WalletCoinsRead => (lists && lists.user === user ? lists.reads[c] : { status: 'loading' });
  const others = (['ethereum', 'base'] as const).flatMap((c) => {
    const r = listOf(c);
    return r.status === 'ok' ? r.coins.map((coin) => ({ chain: c, coin })) : [];
  });
  const otherReads = useReadContracts({
    contracts: others.flatMap(({ chain: c, coin }) => {
      const t = { address: coin.address, abi: ERC20_ABI, chainId: CHAIN_IDS[c] } as const;
      return [{ ...t, functionName: 'balanceOf', args: [addr] } as const, { ...t, functionName: 'decimals' } as const, { ...t, functionName: 'symbol' } as const];
    }),
    query: { enabled: enabled && others.length > 0 },
  });

  const toweli = useUserPosition();
  const prices = useEvmPrices(enabled);
  const priceCtx = useTOWELIPriceOptional();
  const ethUsd = priceCtx && priceCtx.ethUsdForDisplay > 0 ? priceCtx.ethUsdForDisplay : null;

  useEffect(() => {
    if (!enabled || nonce === 0) return;
    void ethNative.refetch();
    void baseNative.refetch();
    void tokens.refetch();
    void ladderReads.refetch();
    void toweli.refetchAll();
    void otherReads.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the refetch handles are stable; this fires once per Refresh
  }, [nonce]);

  // Each coin's decimals as its own contract reports them, by chain and address.
  const decimalsOf = (chain: string, address: string): number | null => {
    const i = coins.findIndex((c) => c.chain === chain && c.address!.toLowerCase() === address.toLowerCase());
    const r = i >= 0 ? tokens.data?.[i * 2 + 1] : undefined;
    return r?.status === 'success' ? Number(r.result) : null;
  };

  const holdingsLeg = (chain: 'ethereum' | 'base'): Leg<HoldingRow> => {
    const native = chain === 'ethereum' ? ethNative : baseNative;
    if (native.isLoading || tokens.isLoading) return { status: 'loading' };
    if (native.isError || !native.data) return { status: 'unread', detail: `the ${chain === 'ethereum' ? 'Ethereum' : 'Base'} balance did not answer` };
    const rows: HoldingRow[] = [];
    if (native.data.value > 0n) {
      rows.push({ key: `${chain}:eth`, symbol: 'ETH', chain, amount: fmtAmount(native.data.value, 18), usd: usdOf(native.data.value, 18, ethUsd), roomId: null, to: null });
    }
    for (const [i, c] of coins.entries()) {
      if (c.chain !== chain) continue;
      const bal = tokens.data?.[i * 2];
      const dec = tokens.data?.[i * 2 + 1];
      if (bal?.status !== 'success' || dec?.status !== 'success') return { status: 'unread', detail: `${c.symbol}'s balance did not answer` };
      const raw = bal.result as bigint;
      if (raw === 0n) continue;
      const d = Number(dec.result);
      rows.push({ key: `${chain}:${c.id}`, symbol: c.symbol, chain, amount: fmtAmount(raw, d), usd: usdOf(raw, d, prices.get(c.address!.toLowerCase())), roomId: c.id, to: `/${c.id}` });
    }
    return { status: 'ok', rows };
  };

  const otherLeg = (chain: EvmWalletChain): Leg<HoldingRow> => {
    const list = listOf(chain);
    if (list.status !== 'ok') return list;
    if (!list.coins.length) return { status: 'ok', rows: [] };
    const data = otherReads.data;
    if (otherReads.isLoading || !data || data.length !== others.length * 3) return { status: 'loading' };
    const rows: HoldingRow[] = [];
    for (const [i, o] of others.entries()) {
      if (o.chain !== chain) continue;
      const bal = data[i * 3];
      const dec = data[i * 3 + 1];
      const sym = data[i * 3 + 2];
      if (bal?.status !== 'success' || dec?.status !== 'success') return { status: 'unread', detail: 'a coin’s balance did not answer' };
      const raw = bal.result as bigint;
      const d = Number(dec.result);
      if (raw === 0n || !Number.isInteger(d) || d < 0 || d > 36) continue;
      const usd = usdOf(raw, d, o.coin.priceUsd);
      if (usd === null || usd < OTHER_COIN_MIN_USD) continue;
      const a = o.coin.address;
      rows.push({
        key: `${chain}:${a}`, chain, amount: fmtAmount(raw, d), usd, roomId: null, mint: a, to: null,
        symbol: evmTicker(sym?.status === 'success' ? sym.result : null, chain, a) ?? `${a.slice(0, 6)}…${a.slice(-4)}`,
      });
    }
    return { status: 'ok', rows: rows.sort((x, y) => y.usd! - x.usd!) };
  };

  const toweliLeg = (): Leg<PositionRow> => {
    if (!toweli.isDeployed) return { status: 'ok', rows: [] };
    if (toweli.isLoading) return { status: 'loading' };
    // useUserPosition reads 0 on a failure and flags it: the flag, never the zero, decides.
    if (toweli.positionUnread) return { status: 'unread', detail: 'the staking contract did not answer' };
    if (!toweli.hasPosition || toweli.stakedAmount === 0n) return { status: 'ok', rows: [] };
    const facts = [`${fmtAmount(toweli.stakedAmount, 18)} TOWELI`];
    if (toweli.lockEnd > 0) facts.push(unlockWords(toweli.lockEnd, nowSecs()));
    if (toweli.boostBps > 0) facts.push(`${(toweli.boostBps / 10_000).toFixed(2)}×`);
    if (!toweli.accrualInputsUnread) facts.push(`earned ${fmtAmount(toweli.pendingReward, 18)} TOWELI`);
    const usd = usdOf(toweli.stakedAmount, 18, priceCtx?.priceInUsd);
    return { status: 'ok', rows: [{ key: 'toweli-stake', roomId: 'toweli', chain: 'ethereum', title: 'TOWELI stake', facts, usd, to: '/earn/toweli' }] };
  };

  const laddersLeg = (): Leg<PositionRow> => {
    if (!ladders.length) return { status: 'ok', rows: [] };
    if (ladderReads.isLoading || posReads.isLoading) return { status: 'loading' };
    const rows: PositionRow[] = [];
    const now = nowSecs();
    for (const [i, b] of ladders.entries()) {
      const earned = ladderReads.data?.[i * 2];
      const ids = idsOf(i);
      if (earned?.status !== 'success' || ids === null) return { status: 'unread', detail: `the ${b.symbol} pool did not answer` };
      if (!ids.length) continue;
      const dec = decimalsOf(b.chain, b.address);
      if (dec === null) return { status: 'unread', detail: `${b.symbol}'s decimals did not answer` };
      const mine = posTargets.map((t, j) => ({ t, r: posReads.data?.[j] })).filter(({ t }) => t.i === i);
      if (mine.some(({ r }) => r?.status !== 'success')) return { status: 'unread', detail: `some of your ${b.symbol} locks did not answer` };
      for (const { t, r } of mine) {
        const tuple = r!.result as readonly [unknown, bigint, bigint, bigint];
        const lockEnd = Number(tuple[1]);
        const amount = tuple[2];
        const boosted = tuple[3];
        const facts = [`${fmtAmount(amount, dec)} ${b.symbol}`, unlockWords(lockEnd, now)];
        if (amount > 0n) facts.push(`${(Number((boosted * 10_000n) / amount) / 10_000).toFixed(2)}×`);
        rows.push({
          key: `evm-ladder:${b.id}:${t.id}`, roomId: b.id, chain: b.chain as 'ethereum' | 'base', title: `${b.symbol} lock`, facts,
          usd: usdOf(amount, dec, prices.get(b.address.toLowerCase())), to: `/earn/${b.id}`,
        });
      }
      // What the pool owes this wallet across all its locks there, as the pool's own earned()
      // reads it: one figure per pool, so it goes on that pool's first lock.
      const pending = earned.result as bigint;
      const first = rows.find((r) => r.roomId === b.id);
      if (first && pending > 0n) first.facts.push(`earned ${fmtAmount(pending, dec)} ${b.symbol}${mine.length > 1 ? ' across these locks' : ''}`);
    }
    return { status: 'ok', rows };
  };

  const retry = () => {
    setListTick((t) => t + 1);
    void otherReads.refetch();
    void ethNative.refetch();
    void baseNative.refetch();
    void tokens.refetch();
    void ladderReads.refetch();
    void posReads.refetch();
    void toweli.refetchAll();
  };

  if (!user) return { holdings: [] as NamedLeg<HoldingRow>[], positions: [] as NamedLeg<PositionRow>[] };
  return {
    holdings: [
      { key: 'eth-holdings', what: 'your Ethereum coins', leg: holdingsLeg('ethereum'), retry },
      { key: 'base-holdings', what: 'your Base coins', leg: holdingsLeg('base'), retry },
      { key: 'eth-other', what: 'your other Ethereum coins', leg: otherLeg('ethereum'), retry },
      { key: 'base-other', what: 'your other Base coins', leg: otherLeg('base'), retry },
    ] as NamedLeg<HoldingRow>[],
    positions: [
      { key: 'toweli-stake', what: 'your TOWELI stake', leg: toweliLeg(), retry },
      { key: 'evm-ladders', what: 'your Ethereum and Base locks', leg: laddersLeg(), retry },
    ] as NamedLeg<PositionRow>[],
  };
}

// ── The last read, drawn while the new one is under way (lib/wallet/boardMemory.ts) ──────────

type Legs = { holdings: NamedLeg<HoldingRow>[]; positions: NamedLeg<PositionRow>[] };

/**
 * Keeps each leg this wallet read, and draws a leg that is loading, or whose new read failed,
 * from its kept rows, with `readAt` (and `failed`, the reason, for a failed one). The board says
 * when they were read and that they are being read again, so a kept row is never passed off as
 * new (owner, 2026-11-01: "so it never does that": a busy relay used to blank a part the wallet
 * had read a minute before). A part with nothing kept still says it could not be read. Both
 * readers key their answers by the wallet (the Solana legs' owner check, wagmi's query keys), so
 * what is kept under an address was read for that address.
 */
function useRemembered(owner: string | null, legs: Legs): Legs {
  const read: Record<string, unknown[]> = {};
  for (const l of [...legs.holdings, ...legs.positions]) if (l.leg.status === 'ok') read[l.key] = l.leg.rows;
  const said = JSON.stringify(read);
  useEffect(() => {
    if (owner && said !== '{}') rememberLegs(owner, JSON.parse(said) as Record<string, unknown[]>);
  }, [owner, said]);

  const waiting = [...legs.holdings, ...legs.positions].some((l) => l.leg.status !== 'ok');
  const kept = owner && waiting ? recallWallet(owner) : null;
  const shown = <T,>(l: NamedLeg<T>, isRow: (r: unknown) => r is T): NamedLeg<T> => {
    const k = kept?.[l.key];
    if (l.leg.status === 'ok' || !k || !k.rows.every(isRow)) return l;
    return { ...l, leg: { status: 'ok', rows: k.rows }, readAt: k.at, ...(l.leg.status === 'unread' ? { failed: l.leg.detail } : {}) };
  };
  return {
    holdings: legs.holdings.map((l) => shown(l, isHoldingRow)),
    positions: legs.positions.map((l) => shown(l, isPositionRow)),
  };
}

/**
 * Reads again, on its own, every part whose last read failed: every HEAL_MS while the page is in
 * view, at once when the page comes back into view, and when the device comes back online. A
 * part that heals draws its new read; nobody has to press Try again.
 */
function useHeal(legs: readonly NamedLeg<unknown>[]) {
  const failing = legs.filter((l) => l.leg.status === 'unread' || l.failed !== undefined);
  const latest = useRef(failing);
  useEffect(() => { latest.current = failing; });
  const any = failing.length > 0;
  useEffect(() => {
    if (!any) return;
    const heal = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      for (const l of latest.current) l.retry();
    };
    const iv = setInterval(heal, HEAL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') heal(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', heal);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', heal);
    };
  }, [any]);
}

export function useWalletBoard(): WalletBoard {
  const { address: evmAddress } = useAccount();
  const solanaAddress = useSolanaSurface().surface?.address ?? null;
  const [nonce, setNonce] = useState(0);
  const sol = useRemembered(solanaAddress, useSolanaLegs(solanaAddress, nonce));
  const evm = useRemembered(evmAddress ?? null, useEvmLegs(evmAddress, nonce));
  const holdings = [...sol.holdings, ...evm.holdings];
  const positions = [...sol.positions, ...evm.positions];
  useHeal([...holdings, ...positions] as NamedLeg<unknown>[]);
  return {
    solanaAddress,
    evmAddress: evmAddress ?? null,
    holdings,
    positions,
    refresh: () => setNonce((n) => n + 1),
  };
}
