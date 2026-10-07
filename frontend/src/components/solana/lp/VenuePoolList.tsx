import { useEffect, useState } from 'react';
import { formatSolPrice, quoteText, shortAddress } from '../../../lib/solana/lp/format';
import { pairLabel, tierLabel, tokenSymbol } from '../../../lib/solana/lp/identity';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { poolPricePerToken } from '../../../lib/solana/lp/poolHealth';
import type { PoolList, PoolListRead } from '../../../lib/solana/lp/poolList';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { usdOfPool, usdText, type UsdPerCoin } from '../../../lib/solana/lp/usd';
import { Card, Notice } from '../curve/ui';
import { HINT } from '../curve/uiFormat';
import { ReadAt } from './ReadAt';
import type { LpReaders } from './readers';
import { useUsdPrices } from './useUsdPrices';

/**
 * The pools a visitor sees before typing anything: every pool on the venue that pairs a
 * token with SOL, USDC or BAYLA, in the reader's order (poolList.ts: SOL's first, then
 * USDC's, then BAYLA's, deepest side of THAT coin first; never re-ranked here, never across
 * coins, never by dollars). A press on a row shows that pool's card through the finder,
 * where the token check and the price check run on the press. It is a list, not a verdict.
 *
 * The heading of a row is the pair by the site's registry (identity.ts), so a token
 * calling itself BAYLA at another mint is headed by its short address. A token blocked on
 * this site is listed last under its short mint alone. The list reads no outside price:
 * one index fetch, the pools, and one safety read for their mints.
 */

/** Ten seconds between two presses of Read again, said on the button as "Read again in {n} s". */
const PAUSE_MS = 10_000;
const BLOCKED_LINE = 'Token blocked on this site';
const READING = 'Reading the venue’s pools from the chain…';
const ORIGIN_WORD: Record<PoolView['origin'], string> = { standard: 'standard address', 'launch-pool': 'launch pool', other: 'own address' };
const ROW_STYLE = { background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)' } as const;
const AGAIN_CLS = 'btn-secondary min-h-[44px] px-4 text-[13px] aria-disabled:opacity-60';

/** One answer: the list, the safety of its mints, and the device's clock when it landed. */
interface Answer {
  read: PoolListRead;
  safety: Map<string, TokenSafety>;
  readAt: number;
}

const isBlocked = (safety: TokenSafety | undefined): boolean => safety?.kind === 'read' && safety.verdict === 'blocked';

export function VenuePoolList({
  readers,
  reloadKey,
  onPick,
}: {
  readers: LpReaders;
  /** Bumped by the section after a liquidity flow finishes: read the list again, keeping what is shown until the new answer lands. */
  reloadKey: number;
  /** A row was pressed: show that pool's card through the finder (PoolFinderHandle.show). */
  onPick: (mint: string, pool: string) => void;
}) {
  const [nonce, setNonce] = useState(0);
  // The answer is kept with the question it answers, so a late answer to an old one is
  // never shown and a re-read keeps the last answer on the screen until the new one lands.
  const key = `${reloadKey}#${nonce}`;
  const [answer, setAnswer] = useState<{ key: string; value: Answer } | null>(null);
  const [pressedAt, setPressedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const usd = useUsdPrices(reloadKey + nonce);
  useEffect(() => {
    const list = readers.listPools;
    if (!list) return;
    let live = true;
    (async () => {
      const read = await list();
      let safety = new Map<string, TokenSafety>();
      if (read.kind === 'ok' && read.list.pools.length > 0) {
        try {
          safety = await readers.safety([...new Set(read.list.pools.map((p) => p.tokenMint))]);
        } catch {
          // Not read is not blocked and not clear: the rows stay, unpriced, and the finder checks the token on a press.
          safety = new Map();
        }
      }
      if (live) setAnswer({ key, value: { read, safety, readAt: Date.now() } });
    })().catch((e: unknown) => {
      if (live) setAnswer({ key, value: { read: { kind: 'unread', detail: e instanceof Error ? e.message : String(e) }, safety: new Map(), readAt: Date.now() } });
    });
    return () => {
      live = false;
    };
  }, [readers, key]);
  // The pause counts down on the button once a second, and only while it is running.
  const left = pressedAt === null ? 0 : Math.max(0, PAUSE_MS - (now - pressedAt));
  useEffect(() => {
    if (left === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [left]);
  if (!readers.listPools) return null;

  const shown = answer?.value ?? null;
  const busy = answer?.key !== key;
  const pausedFor = Math.ceil(left / 1000);
  const readAgain = () => {
    if (busy || pausedFor > 0) return;
    const t = Date.now();
    setPressedAt(t);
    setNow(t);
    setNonce((n) => n + 1);
  };

  return (
    <Card title="Pools on the venue" testId="lp-venue-pools" pageId="solana-lp" idx={1}>
      {busy && (
        <p role="status" className={shown ? HINT : undefined} data-testid="lp-venue-reading">
          {READING}
        </p>
      )}
      {shown && shown.read.kind === 'unread' && (
        <div data-testid="lp-venue-unread">
          <Notice tone="warn">The venue’s pools could not be listed ({shown.read.detail}). That says nothing about how many there are.</Notice>
        </div>
      )}
      {shown && shown.read.kind === 'ok' && <Listed list={shown.read.list} safety={shown.safety} usd={usd.prices} onPick={onPick} />}
      {shown && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <ReadAt at={shown.readAt} />
          <button type="button" className={AGAIN_CLS} aria-disabled={busy || pausedFor > 0} onClick={readAgain} data-testid="lp-venue-again">
            {pausedFor > 0 ? `Read again in ${pausedFor} s` : 'Read again'}
          </button>
        </div>
      )}
    </Card>
  );
}

function Listed({ list, safety, usd, onPick }: { list: PoolList; safety: Map<string, TokenSafety>; usd: UsdPerCoin; onPick: (mint: string, pool: string) => void }) {
  // The reader's order, with blocked tokens moved to the end in that order.
  const blocked = (v: PoolView) => isBlocked(safety.get(v.tokenMint));
  const ordered = [...list.pools.filter((v) => !blocked(v)), ...list.pools.filter(blocked)];
  // "No pool is open" only when nothing was named: an unread pool or an other-pair pool IS a pool on the venue.
  const nothing = list.pools.length === 0 && list.unread === 0 && list.otherPairs === 0;
  const notes: string[] = [];
  if (list.truncated) notes.push('Our pool index returned its maximum, so there are more pools on the venue than this list. For each coin, the pools holding the most of it are here.');
  if (list.unread > 0) notes.push(`${list.unread} pool(s) the index named could not be read this time and are not listed.`);
  if (list.otherPairs > 0) notes.push(`${list.otherPairs} pool(s) on the venue pair two tokens with none of SOL, USDC or BAYLA. This site does not read those pools.`);
  return (
    <>
      {nothing ? (
        <p data-testid="lp-venue-empty">No pool is open on the venue yet. Create a pool, above, opens the first one.</p>
      ) : (
        ordered.length > 0 && (
          <ul className="space-y-1.5" data-testid="lp-venue-list" aria-label="Pools on the venue: SOL pools first, then USDC, then BAYLA, the deepest of each first">
            {ordered.map((v) => (
              <PoolRow key={v.address} view={v} safety={safety.get(v.tokenMint)} usd={usd} onPick={onPick} />
            ))}
          </ul>
        )
      )}
      {notes.length > 0 && (
        <div className={`${HINT} leading-relaxed space-y-1`} data-text-role="hint" data-testid="lp-venue-notes">
          {notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
      <p className={HINT} data-text-role="hint" data-testid="lp-venue-footnote">
        Listed from our pool index, then each pool read and checked on the chain. The index can leave a pool out; it cannot add one that is not on the
        chain.
      </p>
    </>
  );
}

/**
 * One pool, one press. Two lines on a phone (pair and depth; price and origin), the same
 * four cells as one table row from `sm:`. The heading is by registry; the price is the
 * pool's own, in its coin; a dollar figure, when the switch is on and the coin's price was
 * read, is appended to the second line and never ranks anything.
 */
function PoolRow({ view, safety, usd, onPick }: { view: PoolView; safety: TokenSafety | undefined; usd: UsdPerCoin; onPick: (mint: string, pool: string) => void }) {
  const blocked = isBlocked(safety);
  const decimals = safety?.kind === 'read' ? safety.facts?.decimals ?? null : null;
  const price = decimals === null ? null : poolPricePerToken(view.snapshot, view.tokenMint, decimals);
  const depth = quoteText(view.quoteReserve, view.quote);
  const symbol = tokenSymbol(view.tokenMint);
  const priceLine = blocked ? BLOCKED_LINE : price === null ? 'Price not worked out' : `1 ${symbol} = ${formatSolPrice(price)} ${view.quote.symbol}`;
  const about = usdText(usdOfPool(view.quoteReserve, view.quote, usd));
  return (
    <li data-testid="lp-venue-pool" data-pool={view.address} data-mint={view.tokenMint} data-quote={view.quote.symbol} data-blocked={blocked}>
      <button
        type="button"
        aria-label={`Open the ${symbol} / ${view.quote.symbol} pool, ${tierLabel(view.config)}, ${depth} deep, at ${shortAddress(view.address)}`}
        onClick={() => onPick(view.tokenMint, view.address)}
        className="w-full min-h-[56px] rounded-lg px-3 py-2 text-left grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 sm:min-h-[44px] sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto] sm:gap-x-4 hover:bg-white/5"
        style={ROW_STYLE}
      >
        <span className="text-[13px] font-semibold text-white [overflow-wrap:anywhere]" data-testid="lp-venue-pool-head">
          {blocked ? shortAddress(view.tokenMint) : pairLabel(view)}
        </span>
        <span className="text-[13px] text-white/90 text-right sm:text-left whitespace-nowrap">{depth}</span>
        <span className={`${HINT} [overflow-wrap:anywhere]`}>
          {priceLine}
          {about && `, ${about}`}
        </span>
        <span className={`${HINT} text-right whitespace-nowrap`}>{ORIGIN_WORD[view.origin]}</span>
      </button>
    </li>
  );
}
