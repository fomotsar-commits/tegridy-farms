import { useEffect, useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import type { Holder, HoldersRead } from '../../../lib/solana/lp/holders';
import { LARGEST_ACCOUNTS } from '../../../lib/solana/lp/holders';
import { quoteText, tokenText } from '../../../lib/solana/lp/format';
import { pairLabel, siteNamed, tokenTicker } from '../../../lib/solana/lp/identity';
import { Card, Notice } from '../curve/ui';
import { CardArt } from '../../ui/CardArt';
import { FinePrint } from '../../ui/FinePrint';
import type { LpReaders } from './readers';
import { usePoolList } from './usePoolList';

/**
 * Every position in every one of our pools, whoever holds it (owner, 2026-10-23: "I want all
 * the LP positions to show"). "Your positions" lists only the connected wallet's shares;
 * this lists every holder of each pool's shares, read from the chain (holders.ts), with the
 * connected wallet's own rows marked. The pools are the All pools list's, in its order. A
 * pool whose holders could not be read says that, never "nobody". A reader without
 * `holders` or `listPools` (every older test fake) renders nothing.
 */
export function EveryPosition({ readers, owner, reloadKey = 0 }: { readers: LpReaders; owner: PublicKey | null; reloadKey?: number }) {
  const list = usePoolList(readers, reloadKey);
  const pools = list?.kind === 'ok' ? list.list.pools : null;
  const holders = useHolders(readers, pools, reloadKey);
  if (!readers.listPools || !readers.holders) return null;
  const me = owner?.toBase58() ?? null;
  return (
    <section data-testid="lp-every-position" aria-label="Every position">
      <Card title="Every position" art={<CardArt pageId="solana-lp" idx={14} />}>
        <p className="text-white/80 text-[13px] mb-3">Who holds a share of each pool, and what it pays out now.</p>
        {list === null ? (
          <p className="text-white/70 text-[13px]">Reading the pools from the chain…</p>
        ) : list.kind === 'unread' ? (
          <Notice tone="warn">The pools could not be read just now, so neither could their holders. That does not mean there are none.</Notice>
        ) : list.list.pools.length === 0 ? (
          <p className="text-white/70 text-[13px]">No pools yet.</p>
        ) : (
          <ul className="space-y-2.5" aria-label="Every pool's holders">
            {list.list.pools.map((view) => (
              <PoolHolders key={view.address} view={view} safety={list.list.safety.get(view.tokenMint) ?? null} read={holders.get(view.address) ?? null} me={me} />
            ))}
          </ul>
        )}
        <FinePrint summary="How this list works">
          <p>
            Each pool’s holders are read from the chain: the largest accounts holding that pool’s share coin, then each account, to see whose
            it is. A wallet with more than one such account is one row. The chain names at most {LARGEST_ACCOUNTS} accounts per pool, so past
            them smaller holders are not listed.
          </p>
          <p>
            A share pays out its part of both coins when it is taken out. The liquidity providers’ part of each swap fee stays in the pool and
            grows every share: there is nothing to claim. The venue’s and the island’s parts of the fee are kept apart and are in no share.
          </p>
        </FinePrint>
      </Card>
    </section>
  );
}

/** Holders shown per pool before Show all: the card stays short with 8 pools on a phone. */
export const HOLDERS_SHOWN = 5;

function PoolHolders({ view, safety, read, me }: { view: PoolView; safety: TokenSafety | null; read: HoldersRead | null; me: string | null }) {
  const label = pairLabel(view, safety);
  const [all, setAll] = useState(false);
  const holders = read?.kind === 'ok' ? read.holders : [];
  // The largest first; the connected wallet's own row is always in view, wherever it ranks.
  const shown = all ? holders : holders.filter((h, i) => i < HOLDERS_SHOWN || h.owner === me);
  return (
    <li
      data-testid="lp-every-position-pool"
      className="rounded-lg px-3 py-2.5"
      style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)' }}
    >
      <p className="text-white font-semibold text-[14px]">{label}</p>
      {/* Any other coin's ticker is its own claim: its whole address is said too, as on All pools. */}
      {!siteNamed(view.tokenMint) && <p className="font-mono text-white/55 text-[11px] break-all">{view.tokenMint}</p>}
      {read === null ? (
        <p className="text-white/70 text-[12.5px] mt-1">Reading its holders…</p>
      ) : read.kind === 'unread' ? (
        <p className="text-amber-300/90 text-[12.5px] mt-1">Its holders could not be read just now. That does not mean nobody holds a share.</p>
      ) : read.holders.length === 0 ? (
        <p className="text-white/70 text-[12.5px] mt-1">Nobody holds a share yet.</p>
      ) : (
        <ul className="mt-2 space-y-2" aria-label={`${label}: holders, largest first`}>
          {shown.map((h) => (
            <HolderRow key={h.owner} holder={h} view={view} safety={safety} mine={h.owner === me} />
          ))}
        </ul>
      )}
      {holders.length > HOLDERS_SHOWN && (
        <button type="button" className="btn-secondary min-h-[44px] px-4 mt-2 text-[13px]" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${holders.length} holders`}
        </button>
      )}
      {read?.kind === 'ok' && read.capped && (all || holders.length <= HOLDERS_SHOWN) && (
        <p className="text-white/60 text-[12px] mt-1.5">The {LARGEST_ACCOUNTS} largest holders. Smaller ones are not listed.</p>
      )}
    </li>
  );
}

function HolderRow({ holder, view, safety, mine }: { holder: Holder; view: PoolView; safety: TokenSafety | null; mine: boolean }) {
  const { pool } = view.snapshot;
  const tokenDecimals = view.quoteIsToken0 ? pool.mint1Decimals : pool.mint0Decimals;
  const symbol = tokenTicker(view.tokenMint, safety) ?? 'tokens';
  let payout: string;
  if (holder.value) {
    const quoteSide = view.quoteIsToken0 ? holder.value.token0 : holder.value.token1;
    const tokenSide = view.quoteIsToken0 ? holder.value.token1 : holder.value.token0;
    const pct = holder.value.sharePct < 0.01 ? 'Under 0.01%' : `${holder.value.sharePct.toFixed(2)}%`;
    payout = `${pct} of the pool. Pays out ${quoteText(quoteSide, view.quote)} and ${tokenText(tokenSide, tokenDecimals, symbol)} now.`;
  } else {
    payout = holder.tooSmall ? 'Too small to take out.' : 'What it pays out could not be worked out.';
  }
  return (
    <li data-testid="lp-every-position-holder" data-mine={mine ? '' : undefined} className="space-y-0.5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {mine && <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">You</span>}
        <span className="font-mono text-white/80 text-[11.5px] break-all">{holder.owner}</span>
      </p>
      <p className="text-white/75 text-[12.5px] [overflow-wrap:anywhere]">{payout}</p>
    </li>
  );
}

/**
 * Each listed pool's holders, read one pool at a time (two chain calls each) so a page of
 * pools never bursts the read budget, and shown as each answer lands. Read again whenever
 * the list or `reloadKey` moves (a liquidity flow finished).
 */
function useHolders(readers: LpReaders, pools: PoolView[] | null, reloadKey: number): Map<string, HoldersRead> {
  const [reads, setReads] = useState<Map<string, HoldersRead>>(new Map());
  useEffect(() => {
    if (!pools || !readers.holders) return;
    const read = readers.holders;
    let live = true;
    (async () => {
      for (const view of pools) {
        const r = await read(view).catch((e: unknown): HoldersRead => ({ kind: 'unread', detail: e instanceof Error ? e.message : String(e) }));
        if (!live) return;
        setReads((prev) => new Map(prev).set(view.address, r));
      }
    })();
    return () => {
      live = false;
    };
  }, [readers, pools, reloadKey]);
  return reads;
}
