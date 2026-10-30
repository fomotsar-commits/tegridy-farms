import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { FinePrint } from '../components/ui/FinePrint';
import { CopyButton } from '../components/ui/CopyButton';
import { CardanoWalletModal } from '../components/cardano/CardanoWalletModal';
import { loadCsl, type Csl } from '../lib/cardano/csl';
import { ADA, feePercentText, lpAsset, type CardanoAsset, type PoolState } from '../lib/cardano/minswapV2';
import { readTokenInfo, type Read, type TokenInfo } from '../lib/cardano/chain';
import { cardanoscanToken, cardanoscanTx, formatAda, formatAmount, LOVELACE_DECIMALS, parseAmount, parseTokenId } from '../lib/cardano/format';
import { parseWalletUtxos } from '../lib/cardano/orderTx';
import type { CoinLabel } from '../lib/cardano/orderWatch';
import { restoreCardanoWallet, subscribeCardanoWalletList, takeCardanoWalletListRequest, useCardanoWallet } from '../lib/cardano/walletStore';
import { shortCardanoAddress } from '../lib/cardano/address';
import { OWN_POOLS, type OwnPools } from '../lib/cardano/ownPools/deployment';
import { findOwnPool } from '../lib/cardano/ownPools/chainReads';
import { balancedB, MIN_POOL_ADA, quoteDeposit, quoteOpen, quoteWithdraw, type DepositQuote, type WithdrawQuote } from '../lib/cardano/ownPools/lpMath';
import { prepareDeposit, prepareLpCancel, prepareOpen, prepareWithdraw, signAndSendLp, signAndSendLpCancel, type LpPrepared, type LpPreparedCancel } from '../lib/cardano/ownPools/lpFlow';
import { lpHoldings, poolOfLp, positionView, type PositionView } from '../lib/cardano/ownPools/positions';
import {
  dropLpNote,
  lastSentAt,
  lpCancelInFlight,
  markLpSettled,
  readLpEntries,
  readLpNotes,
  readLpOrderStatus,
  settledLpStatus,
  type LpOrderNote,
  type LpOrderStatus,
} from '../lib/cardano/ownPools/lpWatch';
import { MAX_OPEN_NETWORK_FEE } from '../lib/cardano/ownPools/openPoolTx';
import { pollDelayMs } from '../lib/cardano/orderWatch';

/**
 * The venue's OWN Cardano pools (owner, 2026-10-24: "LP: our own pools", never Minswap's):
 * your positions, add, remove, and open a pool. Behind CARDANO_OWN_POOLS_OPEN
 * (lib/cardano/flags.ts); every chain address comes from the one deployment record
 * (api/_lib/cardano-own-pools.js), and while it is null this page says the pools are not open
 * and builds nothing. How each step works and is checked: lib/cardano/ownPools/.
 */

type Tab = 'positions' | 'add' | 'remove' | 'open';

/** One order's cancel, from the press of Cancel order to the wallet's answer. One at a time. */
type CancelFlow = { orderTx: string } & (
  | { kind: 'preparing' }
  | { kind: 'review'; prepared: Extract<LpPreparedCancel, { kind: 'review' }> }
  | { kind: 'signing' }
  | { kind: 'stopped'; message: string; problems?: string[] }
  | { kind: 'done'; message: string }
);
const TABS: { id: Tab; label: string }[] = [
  { id: 'positions', label: 'Your positions' },
  { id: 'add', label: 'Add' },
  { id: 'remove', label: 'Remove' },
  { id: 'open', label: 'Open a pool' },
];

/** The owner's ruling (2026-10-25), shown before the record exists; once it does, the record's (held to the chain's at build). */
const PLANNED_OPENING_FEE = 73_000_000n;
const SLIPPAGES = [50, 100, 300] as const;
const EXPIRED_POLLS = 2;

const CARD = { border: '1px solid rgba(255,255,255,0.12)' } as const;
const FIELD = { background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' } as const;
const PRIMARY = { background: 'var(--color-stan)', border: '1px solid var(--color-stan)' } as const;
const QUIET = { background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.12)' } as const;
const NETWORK_FEE_NOTE = 'set by the transaction’s size; goes to Cardano’s fee pot, paid out to stake pools, stakers and the treasury';

function Line({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[12px]">
      <span className="text-white/65 shrink-0 max-w-[45%]">{label}</span>
      <span className="text-right text-white min-w-0">
        {value}
        {note && <span className="block text-[11px] text-white/55">{note}</span>}
      </span>
    </div>
  );
}

function pct(ppm: bigint): string {
  return `${(Number(ppm) / 10_000).toFixed(4).replace(/\.?0+$/, '')}%`;
}

function coinText(n: bigint, label: CoinLabel): string {
  return `${formatAmount(n, label.decimals)} ${label.ticker ?? 'units'}`;
}

/** A coin's whole id, as the chain knows it: every coin on this page shows it beside its ticker. */
function CoinId({ coin, ticker }: { coin: CardanoAsset; ticker: string | null }) {
  return (
    <p className="font-mono text-[10px] text-white/60 break-all">
      {ticker ?? 'Coin'}: {coin.policyId}.{coin.assetName || '(no name)'}
    </p>
  );
}

/** An LP token's whole id: the venue's policy and the pool's LP name. */
function LpId({ lp }: { lp: CardanoAsset }) {
  return <p className="font-mono text-[10px] text-white/60 break-all">LP token: {lp.policyId}.{lp.assetName}</p>;
}

/** THIS pool's rates, read from its datum: its trade fee each way, and the venue's share of it. */
function PoolRates({ pool }: { pool: PoolState }) {
  const fee = pool.feeANumerator === pool.feeBNumerator ? `${feePercentText(pool.feeANumerator)} of each trade` : `${feePercentText(pool.feeANumerator)} selling ADA, ${feePercentText(pool.feeBNumerator)} buying it`;
  const share = pool.feeSharingNumerator;
  const note =
    share === null
      ? 'all of it to the pool’s LPs: the venue’s share is not switched on for this pool'
      : `the venue keeps ${Number(share) / 100}% of that fee, the LPs the rest`;
  return <Line label="This pool’s fee" value={fee} note={pool.allowDynamicFee ? `${note}; its batcher may add a fee to each trade` : note} />;
}

/** The coin a form is about: typed as its id, read for its ticker and decimals. */
function useCoin(text: string) {
  const token = useMemo(() => parseTokenId(text), [text]);
  const key = token ? token.policyId + token.assetName : null;
  const [read, setRead] = useState<{ key: string; value: Read<TokenInfo | null> } | null>(null);
  useEffect(() => {
    if (!token || !key) return;
    const ac = new AbortController();
    void readTokenInfo(token.policyId, token.assetName, ac.signal).then((value) => {
      if (!ac.signal.aborted) setRead({ key, value });
    });
    return () => ac.abort();
  }, [token, key]);
  const info: Read<TokenInfo | null> | 'loading' | null = !key ? null : read?.key === key ? read.value : 'loading';
  const known = info !== null && info !== 'loading' && info.status === 'ok' && info.data !== null ? info.data : null;
  const label = useMemo<CoinLabel>(() => ({ ticker: known?.ticker ?? known?.name ?? null, decimals: known?.decimals ?? 0 }), [known]);
  return { token, key, info, known, label };
}

function CoinField({ id, text, onText, disabled, coin }: { id: string; text: string; onText: (t: string) => void; disabled: boolean; coin: ReturnType<typeof useCoin> }) {
  const { token, info, known } = coin;
  return (
    <div>
      <label htmlFor={id} className="block text-white text-[11px] mb-1.5">
        The coin paired with ADA: its policy id and name, as hex
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="policy id (56 hex) + asset name (hex)"
        value={text}
        disabled={disabled}
        onChange={(e) => onText(e.target.value)}
        className="w-full rounded-xl p-3 bg-transparent text-white text-[12px] font-mono outline-none disabled:opacity-60"
        style={FIELD}
      />
      {text.trim() !== '' && !token && <p className="mt-1 text-[11px] text-danger">That is not a coin id: 56 hex characters of policy id, then the asset name in hex.</p>}
      {token && (
        <div className="mt-2 rounded-xl p-3 space-y-1.5" style={FIELD} data-testid="cardano-pools-coin">
          {info === 'loading' && <p className="text-[12px] text-white/65">Reading the coin…</p>}
          {info !== null && info !== 'loading' && info.status === 'unread' && <p className="text-[12px] text-danger">The coin could not be read just now ({info.reason}).</p>}
          {info !== null && info !== 'loading' && info.status === 'ok' && info.data === null && <p className="text-[12px] text-danger">The chain has no record of this coin yet. Check the id.</p>}
          {known && (
            <>
              <p className="text-[14px] text-white font-semibold">
                {known.ticker ?? known.name ?? 'This coin'}
                {known.name && known.ticker && known.name !== known.ticker && <span className="ml-2 text-[11px] font-normal text-white/60">{known.name}</span>}
              </p>
              <p className="font-mono text-[10.5px] text-white/80 break-all">
                {token.policyId}
                <span className="text-white/45">.</span>
                {token.assetName || '(no name)'}
              </p>
              <div className="flex flex-wrap gap-x-4">
                <CopyButton text={token.policyId + token.assetName} display="Copy the whole id" className="min-h-[44px] text-[11px] underline" />
                <a href={cardanoscanToken(token.policyId, token.assetName)} target="_blank" rel="noopener noreferrer nofollow" className="min-h-[44px] inline-flex items-center text-[11px] underline">
                  Coin on Cardanoscan <span aria-hidden="true">↗</span>
                </a>
              </div>
              <p className="text-[11px] text-white/60">Anyone can mint a coin with any name. The policy id is what makes it this coin.</p>
              {known.decimals === null && <p className="text-[11px] text-white/60">No decimals on record: amounts are whole units.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AmountField({ id, label, value, onValue, disabled, error, extra }: { id: string; label: string; value: string; onValue: (v: string) => void; disabled: boolean; error?: string | null; extra?: ReactNode }) {
  return (
    <div>
      <div className="flex items-end justify-between mb-1.5">
        <label htmlFor={id} className="block text-white text-[11px]">
          {label}
        </label>
        {extra}
      </div>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.0"
        value={value}
        disabled={disabled}
        onChange={(e) => onValue(e.target.value)}
        className="w-full rounded-xl p-3 bg-transparent text-right text-white text-[20px] font-mono outline-none disabled:opacity-50"
        style={FIELD}
      />
      {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

function Slippage({ value, onValue, disabled }: { value: number; onValue: (n: number) => void; disabled: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-white/70" role="group" aria-label="Slippage">
      <span>Slippage</span>
      {SLIPPAGES.map((bps) => (
        <button
          key={bps}
          type="button"
          aria-pressed={value === bps}
          disabled={disabled}
          onClick={() => onValue(bps)}
          className="min-h-[44px] min-w-[44px] px-3 rounded-md text-white disabled:opacity-60"
          style={value === bps ? PRIMARY : QUIET}
        >
          {bps / 100}%
        </button>
      ))}
    </div>
  );
}

/** How money moves here: always on screen, never only in the small print. */
function MoneyLines({ dep }: { dep: OwnPools | null }) {
  return (
    <div className="rounded-xl p-3 space-y-2" style={FIELD} data-testid="cardano-pools-money">
      <Line label="You earn" value="about 0.26% of each trade" note="the 0.3% trade fee less the venue’s share (all of it until that is switched on for a pool), split by share of the pool; it stays in the pool and comes out with your coins" />
      <Line label="The venue earns" value="about 0.04% of each trade" note="1,333 of each 10,000 of the 0.3% fee, paid only to the venue’s treasury, once switched on for a pool" />
      <Line label="Opening a pool" value={formatAda(dep?.openingFee ?? PLANNED_OPENING_FEE)} note="once, to the venue’s treasury, from whoever opens it" />
      <Line
        label="Each add or remove"
        value={dep ? `up to ${formatAda(dep.batcherFee)} batcher fee` : 'a batcher fee'}
        note="to the venue’s own batcher, which fills the order; 2 ADA more is locked with it and comes back"
      />
    </div>
  );
}

type QuoteRead<T> = { kind: 'idle' } | { kind: 'loading' } | { kind: 'no-pool' } | { kind: 'unread'; reason: string } | { kind: 'refused'; reason: string } | { kind: 'quote'; pool: PoolState; quote: T };

/** The venue's pool for ADA and `token`, a moment after the form stops changing. */
/** `key` carries the coin and a read counter: a new counter reads the pool again. */
function usePool(csl: Csl | null, dep: OwnPools | null, token: CardanoAsset | null, key: string | null) {
  const [read, setRead] = useState<{ key: string; value: Read<PoolState | null> } | null>(null);
  useEffect(() => {
    if (!csl || !dep || !token || !key) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      void findOwnPool(csl, dep, token, ac.signal).then((value) => {
        if (!ac.signal.aborted) setRead({ key, value });
      });
    }, 300);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [csl, dep, token, key]);
  return !key ? null : read?.key === key ? read.value : 'loading';
}

function statusText(s: LpOrderStatus | undefined, note: LpOrderNote, expiredPolls: number, now: number): { text: string; final: boolean } {
  if (!s) return { text: 'Reading…', final: false };
  if (s.kind === 'placed' && lpCancelInFlight(note, now)) return { text: 'Cancel sent. Your coins come back to your wallet when it lands.', final: false };
  if (s.kind === 'returned' && note.cancel?.txHash === s.fillTx) return { text: 'Returned: you cancelled it, and all of it came back to your wallet, less the network fee.', final: true };
  switch (s.kind) {
    case 'not-seen':
      return { text: note.submitted ? 'Sent. The chain has not shown it yet.' : 'Not seen on the chain yet; it may not have been sent.', final: false };
    case 'expired':
      return expiredPolls >= EXPIRED_POLLS
        ? { text: 'Never placed: it is well past its expiry, so it can no longer land. Nothing left your wallet. Safe to try again.', final: true }
        : { text: 'Not seen on the chain, and past its expiry. Checking once more before calling it.', final: false };
    case 'placed':
      return { text: `Order placed${s.depth > 0 ? ` (${s.depth} block${s.depth === 1 ? '' : 's'} deep)` : ''}. Waiting for the venue’s batcher to fill it.`, final: false };
    case 'filled':
      return note.kind === 'deposit'
        ? { text: `Filled: ${formatAmount(s.lp, 0)} LP tokens came back, with your 2 ADA deposit.`, final: true }
        : { text: `Filled: ${formatAda(s.ada)} and ${coinText(s.token, note.tokenLabel)} came back, with your 2 ADA deposit.`, final: true };
    case 'returned':
      return { text: 'Returned: your coins came back. If the batcher returned it (the price moved past your minimum), it kept its fee.', final: true };
    case 'opened':
      return { text: 'The pool is open. Your LP tokens are in your wallet.', final: true };
    case 'spent':
      return { text: 'The order was spent, and this page could not tell how. Your wallet shows what arrived.', final: true };
    case 'unknown':
      return { text: `Could not read the chain just now (${s.reason}). It may well have gone through; this page keeps checking.`, final: false };
  }
}

function CardanoPoolsInner({ csl, cslError }: { csl: Csl | null; cslError: string | null }) {
  const dep = OWN_POOLS.kind === 'deployed' ? OWN_POOLS.pools : null;
  const wallet = useCardanoWallet();
  const [walletOpen, setWalletOpen] = useState(() => takeCardanoWalletListRequest());
  const [tab, setTab] = useState<Tab>('positions');
  const [coinInput, setCoinText] = useState('');
  const coin = useCoin(coinInput);
  const [adaInput, setAdaInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [lpInput, setLpInput] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const [flow, setFlow] = useState<{ kind: 'form' } | { kind: 'preparing' } | { kind: 'review'; prepared: Extract<LpPrepared, { kind: 'review' }>; label: CoinLabel; coin: CardanoAsset; lp: CardanoAsset } | { kind: 'signing' } | { kind: 'moved' } | { kind: 'stopped'; message: string; problems?: string[] } | { kind: 'done'; message: string; tone: 'ok' | 'warn' }>({ kind: 'form' });
  const [notesVersion, notesChanged] = useReducer((n: number) => n + 1, 0);
  const [sessionNotes, setSessionNotes] = useState<LpOrderNote[]>([]);
  const [statuses, setStatuses] = useState<Record<string, LpOrderStatus>>({});
  const [expiredPolls, setExpiredPolls] = useState<Record<string, number>>({});
  const [positions, setPositions] = useState<{ key: string; value: Read<PositionView[]> } | null>(null);
  // Bumped when a press finds the pool moved or unread, or on "Read again": every chain read re-runs.
  const [readEpoch, readAgain] = useReducer((n: number) => n + 1, 0);
  const [cancelFlow, setCancelFlow] = useState<CancelFlow | null>(null);

  useEffect(() => {
    void restoreCardanoWallet();
    return subscribeCardanoWalletList(() => {
      if (takeCardanoWalletListRequest()) setWalletOpen(true);
    });
  }, []);

  const traderHex = wallet.status === 'connected' ? wallet.address.hex : null;
  const traderHexRef = useRef(traderHex);
  useEffect(() => {
    traderHexRef.current = traderHex;
  }, [traderHex]);
  const locked = flow.kind === 'preparing' || flow.kind === 'signing';
  const toForm = () => setFlow({ kind: 'form' });
  const token = coin.known ? coin.token : null;

  // The pool for the form's coin (add, remove; open checks it is NOT there).
  const pool = usePool(csl, dep, token, token && coin.key ? `${coin.key}|${readEpoch}|${notesVersion}` : null);
  const poolUnread = pool !== null && pool !== 'loading' && pool.status !== 'ok' ? pool.reason : null;
  const poolState = pool !== null && pool !== 'loading' && pool.status === 'ok' ? pool.data : null;

  const adaAmount = coin.known ? parseAmount(adaInput, LOVELACE_DECIMALS) : null;
  // Add: the coin side follows the pool's own ratio, so the deposit swaps almost nothing.
  const addTokenAmount = poolState && adaAmount !== null && adaAmount > 0n ? balancedB(poolState, adaAmount) : null;
  const openTokenAmount = coin.known ? parseAmount(tokenInput, coin.label.decimals) : null;
  const lpAmount = parseAmount(lpInput, 0);

  const addQuote: QuoteRead<DepositQuote> = useMemo(() => {
    if (!dep || !token || adaAmount === null || adaAmount <= 0n) return { kind: 'idle' };
    if (pool === 'loading' || pool === null) return { kind: 'loading' };
    if (pool.status !== 'ok') return { kind: 'unread', reason: pool.reason };
    if (!pool.data) return { kind: 'no-pool' };
    const q = quoteDeposit(pool.data, adaAmount, addTokenAmount ?? 0n, slippageBps);
    return 'refused' in q ? { kind: 'refused', reason: q.refused } : { kind: 'quote', pool: pool.data, quote: q };
  }, [dep, token, adaAmount, addTokenAmount, pool, slippageBps]);

  const removeQuote: QuoteRead<WithdrawQuote> = useMemo(() => {
    if (!dep || !token || lpAmount === null || lpAmount <= 0n) return { kind: 'idle' };
    if (pool === 'loading' || pool === null) return { kind: 'loading' };
    if (pool.status !== 'ok') return { kind: 'unread', reason: pool.reason };
    if (!pool.data) return { kind: 'no-pool' };
    const q = quoteWithdraw(pool.data, lpAmount, slippageBps);
    return 'refused' in q ? { kind: 'refused', reason: q.refused } : { kind: 'quote', pool: pool.data, quote: q };
  }, [dep, token, lpAmount, pool, slippageBps]);

  const openQuote = useMemo(() => (adaAmount !== null && openTokenAmount !== null ? quoteOpen(adaAmount, openTokenAmount) : null), [adaAmount, openTokenAmount]);

  // The wallet's positions, read from its own coins.
  const positionsKey = csl && dep && wallet.status === 'connected' ? `${wallet.address.hex}|${notesVersion}|${readEpoch}` : null;
  useEffect(() => {
    if (!csl || !dep || wallet.status !== 'connected' || !positionsKey) return;
    let live = true;
    void (async () => {
      let value: Read<PositionView[]>;
      try {
        const utxos = parseWalletUtxos(csl, (await wallet.api.getUtxos()) ?? []);
        if (!utxos) value = { status: 'unread', reason: 'the wallet’s coins were not a list' };
        else {
          const out: PositionView[] = [];
          value = { status: 'ok', data: out };
          for (const h of lpHoldings(csl, dep, utxos)) {
            const p = await poolOfLp(csl, dep, h.lp.assetName);
            if (p.status !== 'ok') {
              value = { status: 'unread', reason: p.reason };
              break;
            }
            if (p.data) out.push(positionView(h, p.data, readLpEntries(), wallet.address.hex));
          }
        }
      } catch {
        value = { status: 'unread', reason: 'the wallet did not share its coins' };
      }
      if (live) setPositions({ key: positionsKey, value });
    })();
    return () => {
      live = false;
    };
  }, [csl, dep, wallet, positionsKey]);
  const positionsRead = !positionsKey ? null : positions?.key === positionsKey ? positions.value : 'loading';

  // This wallet's LP orders and openings, followed until each one ends.
  const notes = useMemo<LpOrderNote[]>(() => {
    if (!traderHex) return [];
    const noted = readLpNotes().filter((n) => n.traderHex === traderHex);
    return [...sessionNotes.filter((o) => o.traderHex === traderHex && !noted.some((n) => n.txHash === o.txHash)), ...noted];
    // notesVersion: a note was cleared or settled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traderHex, sessionNotes, notesVersion]);
  const finals = useRef(new Set<string>());
  // What "a cancel is still on its way" is read against: moved on each round of reads, so render stays pure.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (notes.length === 0) return;
    let stopped = false;
    const ac = new AbortController();
    const tick = async () => {
      for (const n of notes) {
        if (finals.current.has(n.txHash)) continue;
        const saved = settledLpStatus(n);
        if (saved) {
          finals.current.add(n.txHash);
          setStatuses((prev) => ({ ...prev, [n.txHash]: saved }));
          continue;
        }
        const s = await readLpOrderStatus(n, ac.signal);
        if (stopped) return;
        setStatuses((prev) => ({ ...prev, [n.txHash]: s }));
        setExpiredPolls((prev) => {
          const k = s.kind === 'expired' ? (prev[n.txHash] ?? 0) + 1 : 0;
          if (s.kind === 'expired' && k >= EXPIRED_POLLS) finals.current.add(n.txHash);
          return { ...prev, [n.txHash]: k };
        });
        if (s.kind === 'filled' || s.kind === 'returned' || s.kind === 'spent' || s.kind === 'opened') {
          finals.current.add(n.txHash);
          markLpSettled(n, s);
          notesChanged();
        }
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      try {
        await tick();
        if (!stopped) setClock(Date.now());
      } catch {
        /* a round that threw is tried again next round */
      }
      // A cancel sent counts as fresh as an order placed: both are read every 10 s for a while.
      const sent = notes.map((n) => ({ txHash: n.txHash, placedAt: lastSentAt(n) }));
      if (!stopped) timer = setTimeout(() => void loop(), pollDelayMs(sent, (tx) => finals.current.has(tx), Date.now()));
    };
    void loop();
    return () => {
      stopped = true;
      ac.abort();
      clearTimeout(timer);
    };
  }, [notes]);

  // The whole form and the wallet as one key: a review built for any other key is dropped.
  const formKey = [tab, coin.key, adaInput, tokenInput, lpInput, slippageBps, traderHex].join('|');
  const formKeyRef = useRef(formKey);
  useEffect(() => {
    formKeyRef.current = formKey;
  }, [formKey]);

  const onReview = useCallback(async () => {
    if (!csl || !dep || wallet.status !== 'connected' || !token) return;
    const pressedFor = formKeyRef.current;
    setFlow({ kind: 'preparing' });
    let p: LpPrepared;
    if (tab === 'add' && addQuote.kind === 'quote') p = await prepareDeposit(csl, dep, wallet.api, wallet.address, token, addQuote.quote.amountA, addQuote.quote.amountB, slippageBps, addQuote.quote);
    else if (tab === 'remove' && removeQuote.kind === 'quote') p = await prepareWithdraw(csl, dep, wallet.api, wallet.address, token, removeQuote.quote.lp, slippageBps, removeQuote.quote);
    else if (tab === 'open' && adaAmount !== null && openTokenAmount !== null) p = await prepareOpen(csl, dep, wallet.api, wallet.address, token, adaAmount, openTokenAmount);
    else return toForm();
    if (formKeyRef.current !== pressedFor) return toForm();
    if (p.kind === 'review') setFlow({ kind: 'review', prepared: p, label: coin.label, coin: token, lp: p.action === 'open' ? lpAsset(ADA, token, dep) : p.plan.pool.lp });
    else {
      // The figures on screen are what the press was measured against: read the pool again.
      readAgain();
      setFlow(p.kind === 'moved' ? { kind: 'moved' } : { kind: 'stopped', message: p.message, problems: p.problems });
    }
  }, [csl, dep, wallet, token, tab, addQuote, removeQuote, adaAmount, openTokenAmount, slippageBps, coin.label]);

  const onSign = useCallback(async () => {
    if (!csl || !dep || wallet.status !== 'connected' || flow.kind !== 'review') return;
    const { prepared, label } = flow;
    setFlow({ kind: 'signing' });
    const r = await signAndSendLp(csl, dep, wallet.api, prepared, label);
    const notKept = ' This browser will not keep a note of it, so after a reload it is not followed here: find it on Cardanoscan.';
    if (r.kind === 'sent' || r.kind === 'unsure') setSessionNotes((prev) => [r.note, ...prev.filter((n) => n.txHash !== r.note.txHash)]);
    if (r.kind === 'sent') setFlow({ kind: 'done', tone: 'ok', message: `${prepared.action === 'open' ? 'Sent. The pool opens once it lands' : 'Order sent. The venue’s batcher fills it a few blocks after it lands'}; it is followed below.${r.kept ? '' : notKept}` });
    else if (r.kind === 'unsure') setFlow({ kind: 'done', tone: 'warn', message: `${r.message}${r.kept ? '' : notKept}` });
    else if (r.kind === 'declined') setFlow({ kind: 'done', tone: 'warn', message: 'You declined in the wallet. Nothing was sent.' });
    else setFlow({ kind: 'done', tone: 'warn', message: r.message });
  }, [csl, dep, wallet, flow]);

  const onCancel = useCallback(
    async (n: LpOrderNote) => {
      if (!csl || !dep || wallet.status !== 'connected') return;
      const pressedFor = wallet.address.hex;
      setCancelFlow({ orderTx: n.txHash, kind: 'preparing' });
      const p = await prepareLpCancel(csl, dep, wallet.api, wallet.address, n);
      // The wallet changed while this was built: it answers for an account no longer connected.
      if (traderHexRef.current !== pressedFor) return setCancelFlow(null);
      setCancelFlow(p.kind === 'review' ? { orderTx: n.txHash, kind: 'review', prepared: p } : { orderTx: n.txHash, kind: 'stopped', message: p.message, problems: p.problems });
    },
    [csl, dep, wallet],
  );

  const onSignCancel = useCallback(async () => {
    if (!csl || wallet.status !== 'connected' || cancelFlow?.kind !== 'review') return;
    const { orderTx, prepared } = cancelFlow;
    setCancelFlow({ orderTx, kind: 'signing' });
    const r = await signAndSendLpCancel(csl, wallet.api, orderTx, prepared);
    if (r.kind === 'sent' || r.kind === 'unsure') {
      // Held in memory too, for a browser that keeps no notes; the stored note is read again.
      setSessionNotes((prev) => prev.map((x) => (x.txHash === orderTx ? { ...x, cancel: r.cancel } : x)));
      notesChanged();
    }
    // Sent: the order's own line says so from its note (statusText), here and after a reload.
    if (r.kind === 'sent') setCancelFlow(null);
    else if (r.kind === 'unsure') setCancelFlow({ orderTx, kind: 'done', message: r.message });
    else if (r.kind === 'declined') setCancelFlow({ orderTx, kind: 'done', message: 'You declined in the wallet. Nothing was sent; the order is still open.' });
    else setCancelFlow({ orderTx, kind: 'done', message: r.message });
  }, [csl, wallet, cancelFlow]);

  const pick = (t: Tab, c?: CardanoAsset) => {
    setTab(t);
    if (c) setCoinText(c.policyId + c.assetName);
    setAdaInput('');
    setTokenInput('');
    setLpInput('');
    toForm();
  };

  let cta: { label: string; disabled: boolean; action: 'connect' | 'reload' | 'review' | 'reread' | null } | null = null;
  if (tab !== 'positions') {
    if (!dep) cta = { label: 'Pools are not open yet', disabled: true, action: null };
    else if (wallet.status !== 'connected') cta = { label: 'Connect a Cardano wallet', disabled: false, action: 'connect' };
    else if (!csl) cta = { label: cslError ? 'Reload the page to try again' : 'Loading…', disabled: !cslError, action: cslError ? 'reload' : null };
    else if (!token) cta = { label: 'Paste a coin’s policy id and name', disabled: true, action: null };
    else if (pool === 'loading') cta = { label: 'Reading the pool…', disabled: true, action: null };
    else if (poolUnread) cta = { label: 'Read the pool again', disabled: locked, action: 'reread' };
    else if (tab !== 'open' && !poolState) cta = { label: 'No venue pool for this coin yet', disabled: true, action: null };
    else if (tab === 'open' && poolState) cta = { label: 'Already open: add to it instead', disabled: true, action: null };
    else {
      const ready = tab === 'add' ? addQuote.kind === 'quote' : tab === 'remove' ? removeQuote.kind === 'quote' : openQuote !== null && !('refused' in openQuote);
      const verb = tab === 'add' ? 'Review deposit' : tab === 'remove' ? 'Review withdrawal' : 'Review pool opening';
      cta = ready ? { label: flow.kind === 'preparing' ? 'Building and checking…' : verb, disabled: locked, action: 'review' } : { label: 'Enter an amount', disabled: true, action: null };
    }
  }
  const ctaAction = cta?.action ?? null;
  const onCta = () => {
    if (ctaAction === 'connect') setWalletOpen(true);
    else if (ctaAction === 'reload') window.location.reload();
    else if (ctaAction === 'review') void onReview();
    else if (ctaAction === 'reread') readAgain();
  };

  const held = positionsRead !== null && positionsRead !== 'loading' && positionsRead.status === 'ok' && token ? positionsRead.data.find((p) => p.pool.assetB.policyId === token.policyId && p.pool.assetB.assetName === token.assetName) : undefined;

  return (
    <div className="relative">
      <m.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="rounded-2xl p-5 relative overflow-hidden" style={CARD}>
        <div className="absolute inset-0">
          <ArtImg pageId="cardano-pools" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
          <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.87)' }} />
        </div>
        <div className="relative z-10 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="heading-luxury text-[18px] text-white">Cardano Pools</h1>
              <p className="text-white/60 text-[11px]">The venue’s own pools: put in ADA and a coin, earn from every trade.</p>
            </div>
            {wallet.status === 'connected' && (
              <button type="button" onClick={() => setWalletOpen(true)} className="text-white/70 text-[11px] font-mono px-2 min-h-[44px] rounded-md" style={{ background: 'var(--color-purple-15)' }} title={wallet.address.bech32}>
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-success mr-1.5 align-middle" />
                {shortCardanoAddress(wallet.address.bech32)}
              </button>
            )}
          </div>

          {!dep && (
            <div role="status" className="rounded-xl p-3 text-[12px] text-white" style={{ ...FIELD, borderColor: 'var(--color-stan)' }} data-testid="cardano-pools-not-open">
              <p className="font-semibold">Not open yet.</p>
              <p className="text-white/75">
                {OWN_POOLS.kind === 'refused'
                  ? `The pools’ deployment record was refused (${OWN_POOLS.reason}), so nothing here can be signed.`
                  : 'The venue’s Cardano pools are not on chain yet, so nothing here can be signed.'}
              </p>
            </div>
          )}

          <MoneyLines dep={dep} />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1" role="tablist" aria-label="Pool actions">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                disabled={locked}
                onClick={() => pick(t.id)}
                className="min-h-[44px] rounded-lg text-[12px] font-medium text-white disabled:opacity-60"
                style={tab === t.id ? PRIMARY : QUIET}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'positions' && (
            <div className="space-y-3" role="tabpanel" aria-label="Your positions">
              {!dep && <p className="text-[12px] text-white/75">No positions yet: no one can hold a venue Cardano pool token until the pools open.</p>}
              {dep && wallet.status !== 'connected' && (
                <button type="button" onClick={() => setWalletOpen(true)} className="w-full min-h-[48px] rounded-xl text-white text-[14px] font-semibold" style={PRIMARY}>
                  Connect a Cardano wallet
                </button>
              )}
              {dep && positionsRead === 'loading' && <p className="text-[12px] text-white/65">Reading your positions…</p>}
              {positionsRead !== null && positionsRead !== 'loading' && positionsRead.status === 'unread' && (
                <p className="text-[12px] text-danger">Your positions could not be read just now ({positionsRead.reason}). That does not mean you have none.</p>
              )}
              {positionsRead !== null && positionsRead !== 'loading' && (
                <button type="button" onClick={readAgain} className="min-h-[44px] px-2 text-[11px] underline text-white/70">
                  Read again
                </button>
              )}
              {positionsRead !== null && positionsRead !== 'loading' && positionsRead.status === 'ok' && positionsRead.data.length === 0 && <p className="text-[12px] text-white/75">No venue pool tokens in this wallet.</p>}
              {positionsRead !== null && positionsRead !== 'loading' && positionsRead.status === 'ok' && positionsRead.data.map((p) => <PositionRow key={p.holding.lp.assetName} p={p} onAdd={() => pick('add', p.pool.assetB)} onRemove={() => pick('remove', p.pool.assetB)} />)}
            </div>
          )}

          {tab !== 'positions' && (
            <div className="space-y-4" role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
              <CoinField id="cardano-pools-coin" text={coinInput} onText={(t) => { setCoinText(t); toForm(); }} disabled={locked} coin={coin} />

              {tab === 'add' && (
                <>
                  <AmountField id="cardano-pools-ada" label="ADA to add" value={adaInput} onValue={(v) => { setAdaInput(v); toForm(); }} disabled={!coin.known || locked} error={adaInput.trim() !== '' && coin.known && adaAmount === null ? 'Not an ADA amount (at most 6 decimals).' : null} />
                  {addTokenAmount !== null && <Line label={`And ${coin.label.ticker ?? 'the coin'}`} value={coinText(addTokenAmount, coin.label)} note="at the pool’s own price, so almost nothing is swapped" />}
                </>
              )}
              {tab === 'remove' && (
                <AmountField
                  id="cardano-pools-lp"
                  label="LP tokens to take out"
                  value={lpInput}
                  onValue={(v) => { setLpInput(v); toForm(); }}
                  disabled={!coin.known || locked}
                  error={lpInput.trim() !== '' && lpAmount === null ? 'LP tokens are whole units.' : null}
                  extra={held && <button type="button" disabled={locked} className="min-h-[44px] px-2 text-[11px] underline text-white/80 disabled:opacity-50" onClick={() => { setLpInput(held.holding.quantity.toString()); toForm(); }}>All {formatAmount(held.holding.quantity, 0)}</button>}
                />
              )}
              {tab === 'open' && (
                <>
                  <AmountField id="cardano-pools-open-ada" label="ADA to put in" value={adaInput} onValue={(v) => { setAdaInput(v); toForm(); }} disabled={!coin.known || locked} error={adaInput.trim() !== '' && coin.known && adaAmount === null ? 'Not an ADA amount (at most 6 decimals).' : null} />
                  <AmountField id="cardano-pools-open-coin" label={`${coin.label.ticker ?? 'Coin'} to put in`} value={tokenInput} onValue={(v) => { setTokenInput(v); toForm(); }} disabled={!coin.known || locked} error={tokenInput.trim() !== '' && coin.known && openTokenAmount === null ? `Not an amount this coin can hold (at most ${coin.label.decimals} decimals).` : null} />
                  <p className="text-[11px] text-white/60">The two amounts set the pool’s first price: 1 {coin.label.ticker ?? 'coin'} for their ratio in ADA.</p>
                </>
              )}
              {tab !== 'remove' && <p className="text-[11px] text-white/70">Impermanent loss is real: when the two coins’ prices move apart, the pool rebalances against you, and you can take out less value than holding both would have kept.</p>}
              {tab !== 'open' && <Slippage value={slippageBps} onValue={(n) => { setSlippageBps(n); toForm(); }} disabled={locked} />}

              {dep && tab !== 'open' && (addQuote.kind === 'no-pool' || removeQuote.kind === 'no-pool') && <p className="text-[12px] text-white/75">No venue pool holds ADA and this coin yet. Open one on the Open a pool tab.</p>}
              {poolUnread && <p className="text-[12px] text-danger">The pool could not be read just now ({poolUnread}). That does not mean there is none.</p>}
              {tab === 'add' && addQuote.kind === 'refused' && <p className="text-[12px] text-danger">{addQuote.reason}</p>}
              {tab === 'remove' && removeQuote.kind === 'refused' && <p className="text-[12px] text-danger">{removeQuote.reason}</p>}
              {tab === 'open' && openQuote && 'refused' in openQuote && <p className="text-[12px] text-danger">{openQuote.refused}</p>}
              {tab === 'open' && dep && poolState && <p className="text-[12px] text-white/75">A venue pool for ADA and this coin is already open. Add to it instead.</p>}

              {tab === 'add' && addQuote.kind === 'quote' && token && (
                <div className="rounded-xl p-3 space-y-2" style={FIELD} data-testid="cardano-pools-quote">
                  <Line label="You get about" value={`${formatAmount(addQuote.quote.expectedLp, 0)} LP tokens`} note={`at least ${formatAmount(addQuote.quote.minimumLp, 0)}, or your coins come back`} />
                  <Line label="Your share after" value={pct(addQuote.quote.sharePpm)} />
                  <PoolRates pool={addQuote.pool} />
                  <LpId lp={addQuote.pool.lp} />
                </div>
              )}
              {tab === 'remove' && removeQuote.kind === 'quote' && token && (
                <div className="rounded-xl p-3 space-y-2" style={FIELD} data-testid="cardano-pools-quote">
                  <Line label="You get about" value={`${formatAda(removeQuote.quote.expectedA)} and ${coinText(removeQuote.quote.expectedB, coin.label)}`} note={`at least ${formatAda(removeQuote.quote.minimumA)} and ${coinText(removeQuote.quote.minimumB, coin.label)}, or your LP tokens come back`} />
                  <LpId lp={removeQuote.pool.lp} />
                </div>
              )}
              {tab === 'open' && openQuote && !('refused' in openQuote) && dep && !poolState && (
                <div className="rounded-xl p-3 space-y-2" style={FIELD} data-testid="cardano-pools-quote">
                  <Line label="You get" value={`${formatAmount(openQuote.openerLp, 0)} LP tokens`} note="all of the pool to start; 10 more stay in the pool for good" />
                  <Line label="Opening fee" value={formatAda(dep.openingFee)} note="to the venue’s treasury" />
                  <Line label="The pool keeps" value={formatAda(MIN_POOL_ADA)} note="every pool holds it, for good, beyond its coins" />
                  <Line label="Trade fee" value="0.3% of each trade" note="all of it to the pool’s LPs until the venue’s share is switched on for it" />
                  <Line label="Network fee" value={`up to ${formatAda(MAX_OPEN_NETWORK_FEE)}`} note="exact amount on the next step" />
                </div>
              )}

              {flow.kind === 'moved' && <p className="text-[12px] text-danger" role="alert">The pool moved past the minimum you saw. Nothing was built. The new figures are above.</p>}
              {flow.kind === 'stopped' && (
                <div role="alert" className="text-[12px] text-danger space-y-1">
                  <p>{flow.message}</p>
                  {flow.problems && (
                    <ul className="list-disc pl-5">
                      {flow.problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {cta && flow.kind !== 'review' && flow.kind !== 'signing' && (
                <button type="button" disabled={cta.disabled} onClick={onCta} className="w-full min-h-[48px] rounded-xl text-white text-[14px] font-semibold disabled:opacity-50" style={PRIMARY}>
                  {cta.label}
                </button>
              )}
              {flow.kind === 'review' && <ReviewCard prepared={flow.prepared} label={flow.label} coin={flow.coin} lp={flow.lp} onSign={() => void onSign()} onBack={toForm} />}
              {flow.kind === 'signing' && <p role="status" className="text-[12px] text-white/75">Waiting for your wallet…</p>}
              {flow.kind === 'done' && <p role="status" className={`text-[12px] ${flow.tone === 'ok' ? 'text-success' : 'text-white/85'}`}>{flow.message}</p>}
            </div>
          )}

          <FinePrint summary="How the venue’s Cardano pools work">
            <p>
              These are the venue’s own pools: a copy of Minswap V2’s audited contracts under the venue’s keys, with a 48-hour wait and two signatures for any change to who runs them. Minswap’s own pools are never used here, and Minswap earns nothing from these.
            </p>
            <p>
              Adding or removing places an order at the venue’s order contract, saying which pool, how much, the least you accept, and that only you are paid. The venue’s batcher fills it a few blocks later; if the price has moved past your minimum, it must send your coins back instead, keeping its fee. Until then it stays yours, and only your own key can cancel it: Cancel order, under Your pool orders, brings all of it back, less the network fee, and pays no batcher fee. A cancel runs the order contract, so it pledges one plain ADA coin of at least 5 ADA in your wallet, whole; the network keeps it only if the contract fails on chain, which it checks before ever sending the cancel.
            </p>
            <p>
              A new pool starts with the venue’s share off, as the contracts require: its LPs keep the whole 0.3% until the venue switches its share on, which takes the 48-hour wait. Opening runs the pool contracts from your own transaction, so your wallet puts up about 3 ADA of plain ADA as a pledge; the network keeps it only if the contracts fail on chain, which it checks before ever sending the transaction.
            </p>
            <p>
              Fees earned are the growth of your LP tokens’ worth since a deposit this browser saw. Before your wallet is asked to sign, this page reads the transaction back out of its own bytes and refuses it unless it pays only what the review shows. It never changes your stake or your vote.
            </p>
            <p>On a phone, open this page inside your wallet’s own browser (Eternl or VESPR).</p>
          </FinePrint>
        </div>
      </m.div>

      {notes.length > 0 && (
        <section className="mt-4 rounded-2xl p-5 relative overflow-hidden" style={CARD} aria-label="Your Cardano pool orders">
          <div className="absolute inset-0">
            <ArtImg pageId="cardano-pools" idx={2} alt="" loading="lazy" className="w-full h-full object-cover" />
            <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.87)' }} />
          </div>
          <div className="relative z-10 space-y-3">
            <h2 className="text-white text-[14px] font-semibold">Your pool orders</h2>
            {notes.map((n) => {
              const read = statuses[n.txHash];
              const s = statusText(read, n, expiredPolls[n.txHash] ?? 0, clock);
              const what =
                n.kind === 'deposit' ? `Add ${formatAda(BigInt(n.amountAda))} and ${coinText(BigInt(n.amountToken), n.tokenLabel)}`
                : n.kind === 'withdraw' ? `Take out ${formatAmount(BigInt(n.lpAmount), 0)} LP tokens`
                : `Open a pool with ${formatAda(BigInt(n.amountAda))} and ${coinText(BigInt(n.amountToken), n.tokenLabel)}`;
              const cancel = cancelFlow?.orderTx === n.txHash ? cancelFlow : null;
              const cancelBusy = cancelFlow !== null && (cancelFlow.kind === 'preparing' || cancelFlow.kind === 'review' || cancelFlow.kind === 'signing');
              // Only on an add or remove of the connected wallet's that the chain reads as open, with no cancel of it on its way.
              const canCancel =
                n.kind !== 'open' && dep !== null && csl !== null && traderHex === n.traderHex && read?.kind === 'placed' && !lpCancelInFlight(n, clock) && !(cancel && cancelBusy);
              const back =
                n.kind === 'deposit' ? `Your ${formatAda(BigInt(n.amountAda))} and ${coinText(BigInt(n.amountToken), n.tokenLabel)}` : `Your ${formatAmount(BigInt(n.lpAmount), 0)} LP tokens`;
              return (
                <div key={n.txHash} className="text-[12px] text-white/85 space-y-1" data-testid="cardano-pools-order">
                  <p className="text-white">{what}</p>
                  <CoinId coin={n.token} ticker={n.tokenLabel.ticker} />
                  <LpId lp={n.lp} />
                  <p>{s.text}</p>
                  {canCancel && (
                    <div className="space-y-1">
                      <button type="button" disabled={cancelBusy} onClick={() => void onCancel(n)} className="min-h-[44px] px-3 rounded-lg text-white text-[12px] font-medium disabled:opacity-50" style={QUIET}>
                        Cancel order
                      </button>
                      <p className="text-[11px] text-white/60">{back}, the batcher fee and the 2 ADA deposit all come back to your wallet, less the network fee.</p>
                    </div>
                  )}
                  {cancel?.kind === 'preparing' && <p role="status">Building and checking the cancel…</p>}
                  {cancel?.kind === 'review' && <CancelReview note={n} prepared={cancel.prepared} onSign={() => void onSignCancel()} onBack={() => setCancelFlow(null)} />}
                  {cancel?.kind === 'signing' && <p role="status">Waiting for your wallet…</p>}
                  {cancel?.kind === 'stopped' && (
                    <div role="alert" className="text-danger space-y-1">
                      <p>{cancel.message}</p>
                      {cancel.problems && (
                        <ul className="list-disc pl-5">
                          {cancel.problems.map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {cancel?.kind === 'done' && !s.final && <p role="status">{cancel.message}</p>}
                  <div className="flex flex-wrap gap-x-4">
                    <a href={cardanoscanTx(n.txHash)} target="_blank" rel="noopener noreferrer nofollow" className="min-h-[44px] inline-flex items-center underline">
                      On Cardanoscan <span aria-hidden="true">↗</span>
                    </a>
                    {s.final && (
                      <button type="button" className="min-h-[44px] px-2 underline text-white/70" onClick={() => { dropLpNote(n.txHash); setSessionNotes((prev) => prev.filter((x) => x.txHash !== n.txHash)); notesChanged(); }}>
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <CardanoWalletModal open={walletOpen} onClose={() => setWalletOpen(false)} />
    </div>
  );
}

function PositionRow({ p, onAdd, onRemove }: { p: PositionView; onAdd: () => void; onRemove: () => void }) {
  const coin = p.pool.assetB;
  const info = useCoin(coin.policyId + coin.assetName);
  const label = info.label;
  // A coin amount is shown only in its own decimals: until they are read, it is not shown at all.
  const coinPart = (n: bigint) =>
    info.known ? coinText(n, label) : info.info === 'loading' ? '(reading the coin…)' : info.info !== null && info.info.status === 'unread' ? `(the coin could not be read: ${info.info.reason})` : '(the coin has no record)';
  return (
    <div className="rounded-xl p-3 space-y-2" style={FIELD} data-testid="cardano-pools-position">
      <p className="text-[14px] text-white font-semibold">ADA / {label.ticker ?? 'Coin'}</p>
      <CoinId coin={coin} ticker={label.ticker} />
      <Line label="LP tokens" value={formatAmount(p.holding.quantity, 0)} />
      <LpId lp={p.holding.lp} />
      <Line label="Share of pool" value={pct(p.sharePpm)} />
      <Line label="Worth now" value={`${formatAda(p.a)} and ${coinPart(p.b)}`} note="what taking it all out would pay, at the pool’s price now" />
      <PoolRates pool={p.pool} />
      <Line
        label="Fees earned"
        value={p.fees ? `about ${formatAda(p.fees.a)} and ${coinPart(p.fees.b)}` : 'Not known on this browser'}
        note={p.fees ? `${p.fees.coveredLp < p.holding.quantity ? `on the ${formatAmount(p.fees.coveredLp, 0)} LP tokens added from this browser` : 'since you added, from this browser'}; price moves are not counted here` : 'it saw no deposit of yours into this pool'}
      />
      <div className="flex gap-2">
        <button type="button" onClick={onAdd} className="flex-1 min-h-[44px] rounded-lg text-white text-[12px]" style={QUIET}>
          Add
        </button>
        <button type="button" onClick={onRemove} className="flex-1 min-h-[44px] rounded-lg text-white text-[12px]" style={QUIET}>
          Remove
        </button>
      </div>
    </div>
  );
}

function networkFeeNote(excess: bigint): string {
  return excess > 0n ? `${NETWORK_FEE_NOTE}. It includes ${formatAda(excess)} left over: too little to send back as change` : NETWORK_FEE_NOTE;
}

function ReviewCard({ prepared, label, coin, lp, onSign, onBack }: { prepared: Extract<LpPrepared, { kind: 'review' }>; label: CoinLabel; coin: CardanoAsset; lp: CardanoAsset; onSign: () => void; onBack: () => void }) {
  const lines: ReactNode[] = [];
  if (prepared.action === 'deposit') {
    const c = prepared.checked;
    lines.push(
      <Line key="in" label="You put in" value={`${formatAda(prepared.plan.amountA)} and ${coinText(prepared.plan.amountB, label)}`} />,
      <Line key="lp" label="You get at least" value={`${formatAmount(prepared.plan.minimumLp, 0)} LP tokens`} note="or your coins come back" />,
      <Line key="all" label="Leaves your wallet, all in" value={formatAda(c.paidLovelace)} note={`and ${coinText(prepared.plan.amountB, label)}`} />,
      <Line key="order" label="Of that: the order" value={formatAda(c.orderLovelace)} note="your ADA, the batcher fee, and the 2 ADA deposit that comes back" />,
      <Line key="net" label="Network fee" value={formatAda(c.networkFee)} note={networkFeeNote(c.networkFeeExcess)} />,
    );
  } else if (prepared.action === 'withdraw') {
    const c = prepared.checked;
    lines.push(
      <Line key="lp" label="You take out" value={`${formatAmount(prepared.plan.lp, 0)} LP tokens`} />,
      <Line key="min" label="You get at least" value={`${formatAda(prepared.plan.minimumA)} and ${coinText(prepared.plan.minimumB, label)}`} note="or your LP tokens come back" />,
      <Line key="all" label="Leaves your wallet, all in" value={formatAda(c.paidLovelace)} note={`and ${formatAmount(prepared.plan.lp, 0)} LP tokens`} />,
      <Line key="order" label="Of that: the order" value={formatAda(c.orderLovelace)} note="the batcher fee and the 2 ADA deposit that comes back" />,
      <Line key="net" label="Network fee" value={formatAda(c.networkFee)} note={networkFeeNote(c.networkFeeExcess)} />,
    );
  } else {
    const c = prepared.checked;
    lines.push(
      <Line key="in" label="Into the pool" value={`${formatAda(prepared.plan.amountAda)} and ${coinText(prepared.plan.amountToken, label)}`} />,
      <Line key="lp" label="You get" value={`${formatAmount(c.openerLp, 0)} LP tokens`} />,
      <Line key="fee" label="Opening fee" value={formatAda(c.openingFee)} note="to the venue’s treasury" />,
      <Line key="pool" label="The pool keeps" value={formatAda(MIN_POOL_ADA)} note="for good" />,
      <Line key="factory" label="The pool list keeps" value={formatAda(c.factoryLovelace)} note="for good: the entry that keeps one pool per pair" />,
      <Line key="net" label="Network fee" value={formatAda(c.networkFee)} note={networkFeeNote(c.networkFeeExcess)} />,
      <Line key="all" label="Leaves your wallet, all in" value={formatAda(c.paidLovelace)} note={`and ${coinText(c.paidToken, label)}`} />,
      <Line key="pledge" label="Pledged, comes back" value={formatAda(c.collateralPledged)} note="kept only if the pool contracts fail on chain" />,
    );
  }
  const trader = prepared.action === 'open' ? prepared.plan.opener : prepared.plan.trader;
  return (
    <div className="rounded-xl p-3 space-y-2" style={FIELD} data-testid="cardano-pools-review">
      <p className="text-white text-[13px] font-semibold">Check, then sign</p>
      <CoinId coin={coin} ticker={label.ticker} />
      <LpId lp={lp} />
      {lines}
      <Line label="Paid to" value="your own address" note="staking key included:" />
      <p className="font-mono text-[10px] text-white/60 break-all">{trader.bech32}</p>
      <p className="text-[11px] text-white/60">Checked: nothing in this transaction pays anyone else{prepared.action === 'open' ? ' but the pool and the venue’s treasury' : ''}, or touches your stake.</p>
      <div className="flex gap-2">
        <button type="button" onClick={onBack} className="flex-1 min-h-[48px] rounded-xl text-white text-[13px]" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.18)' }}>
          Back
        </button>
        <button type="button" onClick={onSign} className="flex-[2] min-h-[48px] rounded-xl text-white text-[14px] font-semibold" style={PRIMARY}>
          Sign in wallet
        </button>
      </div>
    </div>
  );
}

function CancelReview({ note, prepared, onSign, onBack }: { note: LpOrderNote; prepared: Extract<LpPreparedCancel, { kind: 'review' }>; onSign: () => void; onBack: () => void }) {
  const c = prepared.checked;
  // An order this page placed holds its coin or its LP tokens; anything else is named by its whole id.
  const tokens = c.backTokens.map((t) =>
    t.policyId === note.token.policyId && t.assetName === note.token.assetName ? coinText(t.quantity, note.tokenLabel)
    : t.policyId === note.lp.policyId && t.assetName === note.lp.assetName ? `${formatAmount(t.quantity, 0)} LP tokens`
    : `${t.quantity} units of ${t.policyId}.${t.assetName || '(no name)'}`,
  );
  return (
    <div className="rounded-xl p-3 space-y-2" style={FIELD} data-testid="cardano-pools-cancel-review">
      <p className="text-white text-[13px] font-semibold">Check, then sign the cancel</p>
      <CoinId coin={note.token} ticker={note.tokenLabel.ticker} />
      <LpId lp={note.lp} />
      <Line label="You get back" value={[formatAda(c.backLovelace), ...tokens].join(' and ')} note="everything the order holds, less the network fee" />
      <Line label="Network fee" value={formatAda(c.networkFee)} note={NETWORK_FEE_NOTE} />
      <Line label="Batcher fee" value="None" note="a cancel does not go through the venue’s batcher" />
      <Line label="Pledged, comes back" value={formatAda(c.collateralPledged)} note="one coin of your wallet, kept only if the order contract fails on chain" />
      <Line label="Paid to" value="your own address" note="staking key included:" />
      <p className="font-mono text-[10px] text-white/60 break-all">{prepared.plan.trader.bech32}</p>
      <p className="text-[11px] text-white/60">Checked: it spends only this order, with the order contract’s own cancel, and pays only you. It never changes your stake or your vote.</p>
      <div className="flex gap-2">
        <button type="button" onClick={onBack} className="flex-1 min-h-[48px] rounded-xl text-white text-[13px]" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.18)' }}>
          Keep the order
        </button>
        <button type="button" onClick={onSign} className="flex-[2] min-h-[48px] rounded-xl text-white text-[14px] font-semibold" style={PRIMARY}>
          Sign the cancel
        </button>
      </div>
    </div>
  );
}

export default function CardanoPoolsPage() {
  usePageTitle('Cardano Pools', 'The venue’s own Cardano pools on memetics.finance: add ADA and a coin, earn from every trade.');
  useEffect(() => {
    trackPageView('cardano-pools');
  }, []);
  const [csl, setCsl] = useState<Csl | null>(null);
  const [cslError, setCslError] = useState<string | null>(null);
  useEffect(() => {
    // Nothing to build or read until the pools exist: the library is not fetched before then.
    if (OWN_POOLS.kind !== 'deployed') return;
    let live = true;
    loadCsl().then(
      (c) => live && setCsl(c),
      (err: unknown) => live && setCslError(err instanceof Error ? err.message : 'The Cardano library did not load.'),
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <>
      <PageArtBackdrop pageId="cardano-pools" />
      <div className="relative max-w-md mx-auto px-4 py-8">
        {cslError && (
          <p role="alert" className="mb-3 text-[12px] text-danger">
            {cslError}
          </p>
        )}
        <CardanoPoolsInner csl={csl} cslError={cslError} />
      </div>
    </>
  );
}
