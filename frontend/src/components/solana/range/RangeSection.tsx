// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../../../lib/solanaPolyfill';
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { SolanaProviders } from '../SolanaProviders';
import { browserRpc, type SolanaRpc } from '../../../lib/launcher/solana/curve/rpc';
import { lpWriteMode, type LpWriteMode } from '../../../lib/launcher/solana/lpWriteFlag';
import { lpFetch } from '../../../lib/solana/lp/readFetch';
import { readOutsidePrice, type OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { noteResponse } from '../../../lib/solana/lp/rpcBudget';
import { parseMintInput } from '../../../lib/solana/lp/mintInput';
import { QUOTE_COINS, quoteCoin } from '../../../lib/solana/lp/quotes';
import { BAYLA_MINT } from '../../../lib/solana/lp/tokenSafety';
import { RANGE_PROGRAM_ID } from '../../../lib/solana/clmm/program';
import { readFeeTiers, readPairPools, readWalletPositions, type Read, type RangePool, type WalletPositionsRead } from '../../../lib/solana/clmm/read';
import type { AmmConfigView } from '../../../lib/solana/clmm/program';
import { feePaidIn, feeSplit } from '../../../lib/solana/clmm/feeText';
import { rangeVenueEarns } from '../../../lib/solana/clmm/venueEarns';
import { pairOf, priceAtSqrt, type Pair } from '../../../lib/solana/clmm/rangeMath';
import { CardArt } from '../../ui/CardArt';
import { FinePrint } from '../../ui/FinePrint';
import { withReadCommitment } from '../curve/confirmedRpc';
import { RANGE_PENDING_SCOPE } from '../curve/pendingTrade';
import { PendingTradeCard } from '../curve/PendingTradeCard';
import { Card, Notice, Row } from '../curve/ui';
import { useCurveSigner } from '../curve/useCurveSigner';
import { usePendingTrades, type CheckSignature } from '../curve/usePendingTrades';
import type { RangeWriteApi, WriteRpc } from '../curve/ports';
import { RangeOpenCard } from './RangeOpenCard';
import { RangePositionsCard } from './RangePositionsCard';
import { loadRangeWriteApi } from './rangeWriteApi';
import { priceText, tokenWord } from './rangeText';
import { useChainRead, useRangeWrites } from './useRangeData';

/**
 * The Range tab's section: how a range position pays, the pools of one pair (one per fee
 * tier), the range picker and deposit, and the wallet's positions. Everything is read from
 * the range program at the address `clmm/programId.ts` names, over `/api/solrpc`. Writes
 * follow LP's own switch: 'on' opens positions and takes out, 'withdraw-only' only takes
 * out, 'off' fetches no write code at all. `?mint=` picks the token; nothing else is read
 * from the address.
 */
export default function RangeSection() {
  const readers = useMemo(() => browserRangeReaders(withReadCommitment(browserRpc(lpFetch({ what: 'the chain', onResponse: noteResponse })), 'confirmed'), RANGE_PROGRAM_ID), []);
  return (
    <SolanaProviders>
      <RangeInner readers={readers} load={loadRangeWriteApi} mode={lpWriteMode()} />
    </SolanaProviders>
  );
}

/** What the section reads, as one object so a test can answer in its place. */
export interface RangeReaders {
  programId: PublicKey;
  feeTiers(): Promise<Read<AmmConfigView[]>>;
  pairPools(mintA: string, mintB: string, tiers: AmmConfigView[]): Promise<Read<RangePool[]>>;
  walletPositions(owner: string): Promise<Read<WalletPositionsRead>>;
  /** Jupiter's price, refused when it comes through a range pool: the opening's market check. */
  outsidePrice(mint: string, decimals: number, opts?: { fresh?: boolean }): Promise<OutsidePrice>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function browserRangeReaders(rpc: SolanaRpc, programId: PublicKey): RangeReaders {
  return {
    programId,
    feeTiers: () => readFeeTiers(rpc, programId),
    pairPools: (a, b, tiers) => readPairPools(rpc, programId, a, b, tiers),
    walletPositions: (owner) => readWalletPositions(rpc, programId, new PublicKey(owner)),
    outsidePrice: (mint, decimals, o) => readOutsidePrice(mint, decimals, { rpc, programId: programId.toBase58() }, lpFetch({ what: 'Jupiter' }), undefined, o),
  };
}

export function RangeInner({ readers, load, mode }: { readers: RangeReaders; load: () => Promise<RangeWriteApi>; mode: LpWriteMode }) {
  const programId = readers.programId;
  const { connection } = useConnection();
  const writeRpc = connection as unknown as WriteRpc;
  const signerState = useCurveSigner();
  const writes = useRangeWrites(mode !== 'off', load);
  const readyApi = writes.status === 'ready' ? writes.api : null;
  const readyCfg = writes.status === 'ready' ? writes.cfg : null;
  const write = useMemo(() => (readyApi && readyCfg ? { api: readyApi, cfg: readyCfg } : null), [readyApi, readyCfg]);

  const [params, setParams] = useSearchParams();
  const raw = params.get('mint');
  const parsed = raw ? parseMintInput(raw) : null;
  const tokenMint = parsed?.ok ? parsed.mint : BAYLA_MINT;
  const coins = QUOTE_COINS.filter((q) => q.mint !== tokenMint);
  const [coinMint, setCoinMint] = useState(coins[0]!.mint);
  const coin = coins.find((q) => q.mint === coinMint) ?? coins[0]!;

  const [nonce, setNonce] = useState(0);
  // One range transaction at a time: each card says when its own is under way.
  const [busyBy, setBusyBy] = useState({ open: false, positions: false });
  const busy = busyBy.open || busyBy.positions;
  const openBusy = useCallback((b: boolean) => setBusyBy((m) => (m.open === b ? m : { ...m, open: b })), []);
  const positionsBusy = useCallback((b: boolean) => setBusyBy((m) => (m.positions === b ? m : { ...m, positions: b })), []);
  const finished = useCallback(() => setNonce((n) => n + 1), []);

  const tiers = useChainRead(`tiers:${programId.toBase58()}`, nonce, () => readers.feeTiers());
  const tierList = tiers.read?.kind === 'ok' ? tiers.read.value : null;
  const pools = useChainRead(tierList ? `pools:${tokenMint}:${coin.mint}:${tierList.length}` : null, nonce, () => readers.pairPools(tokenMint, coin.mint, tierList ?? []));
  const poolList = pools.read?.kind === 'ok' ? pools.read.value : null;
  const [chosen, setChosen] = useState<string | null>(null);
  const pool: RangePool | null = poolList?.find((x) => x.pool.address === chosen) ?? poolList?.[0] ?? null;
  const pair: Pair | null = pool ? pairOf(pool.pool) : null;

  const owner = signerState.kind === 'disconnected' ? null : signerState.address;
  const positions = useChainRead(owner ? `positions:${owner}` : null, nonce, () => readers.walletPositions(owner!));

  const check = useMemo<CheckSignature | null>(
    () => (write ? (sig, lvbh) => write.api.recheckOutcome(writeRpc, sig, { lastValidBlockHeight: lvbh ?? undefined }) : null),
    [write, writeRpc],
  );
  const pending = usePendingTrades(RANGE_PENDING_SCOPE, check, finished, { live: true });
  const held = pending.notes.length > 0;

  const canOpen = mode === 'on' && write !== null;
  const why =
    mode === 'off'
      ? null
      : writes.status === 'loading'
        ? null
        : writes.status === 'failed'
          ? 'The deposit code did not load. Check your connection and reload the page.'
          : writes.status === 'ready' && !writes.cfg
            ? 'This copy of the site cannot send transactions.'
            : null;

  const pickCoin = (mint: string) => {
    setCoinMint(mint);
    setChosen(null);
  };
  const clearToken = () =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('mint');
      return next;
    });

  return (
    <div className="space-y-4">
      <HowItPays pool={pool} pair={pair} />

      {held && write && (
        <PendingTradeCard
          state={pending}
          explorerUrl={(sig) => write.api.explorerTxUrl(sig, write.cfg.cluster)}
          title="Your last range transaction may still be landing"
          testId="range-pending"
          lead={
            <>
              <p>Sent, not confirmed yet. Every range form stays off until it is checked.</p>
              <p className="text-white/70">It may still go through. Sending it again could make you pay twice. Another browser tab does not know about it.</p>
            </>
          }
          describe={(n) => <Row label="What" value={NOTE_WHAT[n.kind as keyof typeof NOTE_WHAT] ?? 'a range transaction'} mono={false} />}
        />
      )}

      <Card title="Pick a pool" testId="range-pools" art={<CardArt pageId="range-pools" idx={1} />}>
        <Row label="Token" value={quoteCoin(tokenMint)?.symbol ?? tokenMint} mono={!quoteCoin(tokenMint)} />
        {raw && parsed && !parsed.ok && <Notice tone="warn">{`The token in the link is not one this page can read (${parsed.reason}). Showing BAYLA.`}</Notice>}
        {parsed?.ok && tokenMint !== BAYLA_MINT && (
          <button type="button" className="underline text-white/70 min-h-[44px]" onClick={clearToken}>
            Back to BAYLA
          </button>
        )}
        <div className="flex flex-wrap gap-2" role="group" aria-label="Paired with">
          {coins.map((q) => (
            <button
              key={q.mint}
              type="button"
              aria-pressed={q.mint === coin.mint}
              disabled={busy}
              className={`min-h-[44px] px-3 rounded-lg border text-[12px] ${q.mint === coin.mint ? 'border-emerald-300/70 bg-emerald-400/15 text-white' : 'border-white/15 bg-white/5 text-white/80'}`}
              onClick={() => pickCoin(q.mint)}
            >
              With {q.symbol}
            </button>
          ))}
        </div>
        {tiers.read?.kind === 'unread' || pools.read?.kind === 'unread' ? (
          <div className="space-y-2">
            <Notice tone="warn">The range pools could not be read just now. This does not mean there are none.</Notice>
            <button type="button" className="btn-secondary min-h-[44px] px-4 text-[12px]" onClick={finished}>
              Read again
            </button>
          </div>
        ) : !tierList || !poolList ? (
          <p className="text-white/70">Reading the range pools…</p>
        ) : tierList.length === 0 ? (
          <Notice>The range program has no fee tiers on this network yet, so there is no pool to put liquidity in.</Notice>
        ) : poolList.length === 0 ? (
          <Notice>{`No range pool for ${quoteCoin(tokenMint)?.symbol ?? 'this token'} with ${coin.symbol} yet.`}</Notice>
        ) : (
          <div className="space-y-2" role="group" aria-label="Pools by fee">
            {poolList.map((x) => {
              const s = feeSplit(x.config);
              const pr = pairOf(x.pool);
              const on = x.pool.address === pool?.pool.address;
              return (
                <button
                  key={x.pool.address}
                  type="button"
                  aria-pressed={on}
                  disabled={busy}
                  className={`w-full text-left min-h-[44px] rounded-lg border px-3 py-2 ${on ? 'border-emerald-300/70 bg-emerald-400/10' : 'border-white/15 bg-white/5'}`}
                  onClick={() => setChosen(x.pool.address)}
                >
                  <span className="block text-white text-[12px]">{`${s.fee} fee per swap`}</span>
                  <span className="block text-white/60 text-[11px]">{pr ? `Price now ${priceText(pr, priceAtSqrt(pr, x.pool.sqrtPriceX64))}` : 'A pair this site does not read'}</span>
                </button>
              );
            })}
          </div>
        )}
        {pools.reading && poolList && <p className="text-white/45 text-[10px]">Reading again…</p>}
        {pool && <Row label="Pool" value={pool.pool.address} />}
      </Card>

      {pool && pair && (
        <RangeOpenCard
          key={pool.pool.address}
          pool={pool}
          pair={pair}
          canOpen={canOpen}
          why={why}
          write={write}
          rpc={writeRpc}
          programId={programId}
          reads={readers}
          signerState={signerState}
          pending={pending}
          held={held || busyBy.positions}
          onBusy={openBusy}
          onFinished={finished}
        />
      )}

      <RangePositionsCard
        read={positions.read}
        reading={positions.reading}
        onReadAgain={finished}
        signerState={signerState}
        canTake={mode !== 'off' && write !== null}
        write={write}
        rpc={writeRpc}
        programId={programId}
        pending={pending}
        held={held}
        othersBusy={busyBy.open}
        onBusy={positionsBusy}
        onFinished={finished}
      />
    </div>
  );
}

const NOTE_WHAT = {
  'range-open': 'opening a range position',
  'range-remove': 'taking liquidity or fees out of a range position',
  'range-close': 'closing a range position',
} as const;

/**
 * How a range position pays, said where the deposit is (never folded away): what LPs earn
 * and what the venue keeps, both read from the chosen pool's fee tier, and that a position
 * out of range earns nothing. Where the venue's cut goes is said as the /solana-lp Rates
 * card says it: the agreed split in the fine print, any other wallet in bold in plain sight.
 */
function HowItPays({ pool, pair }: { pool: RangePool | null; pair: Pair | null }) {
  const s = pool ? feeSplit(pool.config) : null;
  const venue = pool ? rangeVenueEarns(pool.config) : null;
  const wallets = venue && (
    <div className="space-y-1">
      {venue.wallets.map((w) => (
        <Row key={w.address} label={w.label} value={w.address} />
      ))}
    </div>
  );
  return (
    <Card title="How a range position earns" testId="range-earns" art={<CardArt pageId="range-pools" idx={0} />}>
      {s ? (
        <p className="text-white/85">
          {`Each swap through your range pays a ${s.fee} fee. Positions whose range the price is in share ${s.lpOfFee} of it (${s.lpOfSwap} of the swap), split by how much liquidity each has there. The venue keeps ${s.venueOfFee} (${s.venueOfSwap} of the swap). Both shares are read from this pool’s fee tier on the chain.`}
        </p>
      ) : (
        <p className="text-white/85">
          Each swap through your range pays the pool’s fee. Positions whose range the price is in share most of it, and the venue keeps a part; pick a pool to see both, read from its fee tier on the chain.
        </p>
      )}
      {/* Venue money going anywhere but the agreed split is said in plain sight, in bold (owner, 2026-10-10). */}
      {venue?.elsewhere && (
        <div data-testid="range-venue-elsewhere" className="space-y-1">
          <p className="text-amber-200 text-[12px]">
            <strong>{venue.where}</strong>
          </p>
          {wallets}
        </div>
      )}
      <Notice tone="warn">Out of range, a position earns nothing. Once the price leaves your range, the position is all one coin until the price comes back.</Notice>
      <FinePrint summary="How it works">
        <div className="space-y-2 text-white/70 text-[11px]">
          {venue && !venue.elsewhere && (
            <>
              <p>{venue.where}</p>
              {wallets}
            </>
          )}
          <p>You pick a lowest and a highest price. Your coins work only while the pool’s price is between them, so a narrow range earns more of each fee while it lasts and stops earning sooner.</p>
          <p>As the price moves through your range, the pool swaps your coins for you: rising, it sells the token for the other coin; falling, it buys the token. At either end you hold one coin only.</p>
          {pair && pool && (
            <p>{`Fees in this pool are paid ${feePaidIn(pool.pool.feeOn, pair.tokenIsToken0 ? tokenWord(pair) : pair.quote.symbol, pair.tokenIsToken0 ? pair.quote.symbol : tokenWord(pair))}, and stay with your position until you claim them.`}</p>
          )}
          <p>Your position is an NFT in your wallet. Whoever holds the NFT can take the position out, so keep it as you would the coins.</p>
          <p>Opening a position pays refundable deposits for its record and its NFT, and for a band of prices nobody has used yet. Closing the position gives its own deposits back.</p>
          <p>The range program is the venue’s own. Your coins sit in the pool’s vaults, which only the program moves.</p>
        </div>
      </FinePrint>
    </Card>
  );
}
