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
import { ownPoolPrograms } from '../../../lib/solana/lp/ownPools';
import { readFeeTiers, readFreezeAuthority, readPairPools, readWalletPositions, type MintFreeze, type Read, type RangePool, type WalletPositionsRead } from '../../../lib/solana/clmm/read';
import { freezeWarning } from '../../../lib/solana/lp/tokenSafety';
import type { AmmConfigView } from '../../../lib/solana/clmm/program';
import { feePaidIn, feeSplit, poolFeeCeiling } from '../../../lib/solana/clmm/feeText';
import { rangeVenueEarns } from '../../../lib/solana/clmm/venueEarns';
import { pairOf, priceAtSqrt, type Pair } from '../../../lib/solana/clmm/rangeMath';
import { CardArt } from '../../ui/CardArt';
import { FinePrint } from '../../ui/FinePrint';
import { CoinRiskNotice } from '../lp/LpDisclosures';
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
import { chipCls } from './editorialUi';
import { EDITORIAL_INK, HEADING_FONT, pad2 } from '../../../lib/editorial';

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
  /** The token's freeze authority, or that the address is not a mint: said where the token is picked. */
  freezeAuthority(mint: string): Promise<Read<MintFreeze>>;
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
    freezeAuthority: (mint) => readFreezeAuthority(rpc, mint),
    outsidePrice: (mint, decimals, o) => readOutsidePrice(mint, decimals, { rpc, programId: ownPoolPrograms([programId.toBase58()]) }, lpFetch({ what: 'Jupiter' }), undefined, o),
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
  const freeze = useChainRead(`freeze:${tokenMint}`, nonce, () => readers.freezeAuthority(tokenMint));
  const tierList = tiers.read?.kind === 'ok' ? tiers.read.value : null;
  const pools = useChainRead(tierList ? `pools:${tokenMint}:${coin.mint}:${tierList.length}` : null, nonce, () => readers.pairPools(tokenMint, coin.mint, tierList ?? []));
  const poolList = pools.read?.kind === 'ok' ? pools.read.value : null;
  const [chosen, setChosen] = useState<string | null>(null);
  const pool: RangePool | null = poolList?.find((x) => x.pool.address === chosen) ?? poolList?.[0] ?? null;
  // One object per pool read, so the opening card asks the market price once per pool, not per render.
  const pair: Pair | null = useMemo(() => (pool ? pairOf(pool.pool) : null), [pool]);

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
      <HowItPays pool={pool} pair={pair} tiers={tierList} />

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

      <Card title="Pick a pool" testId="range-pools" index={2} art={<CardArt pageId="range-pools" idx={1} />}>
        <Row label="Token" value={quoteCoin(tokenMint)?.symbol ?? tokenMint} mono={!quoteCoin(tokenMint)} />
        <TokenFreezeNotice mint={tokenMint} read={freeze.read} />
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
              className={chipCls(q.mint === coin.mint)}
              onClick={() => pickCoin(q.mint)}
            >
              With {q.symbol}
            </button>
          ))}
        </div>
        {/* What the pairing coin adds to the risks (Circle can freeze a pool's USDC), where it is chosen; the review says it again. */}
        <CoinRiskNotice coin={coin} />
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
              const s = feeSplit(x.config, poolFeeCeiling(x.pool, x.config.tradeFeeRate));
              const pr = pairOf(x.pool);
              const on = x.pool.address === pool?.pool.address;
              return (
                <button
                  key={x.pool.address}
                  type="button"
                  aria-pressed={on}
                  disabled={busy}
                  className={`w-full text-left min-h-[44px] border px-3.5 py-2.5 grid grid-cols-[5.25rem_minmax(0,1fr)] gap-x-3 items-baseline transition-colors ${on ? 'border-[#22c55e] bg-[#22c55e]/10' : 'border-white/20 bg-black/20 hover:border-white/40'}`}
                  onClick={() => setChosen(x.pool.address)}
                >
                  <span aria-hidden="true" className="font-black text-[22px] leading-none tracking-[-0.035em] tabular-nums" style={{ ...HEADING_FONT, color: on ? '#22c55e' : EDITORIAL_INK }}>{s.fee}</span>
                  <span className="min-w-0">
                    <span className="block text-white text-[12px]">{`${s.fee} fee per swap`}</span>
                    <span className="block font-mono text-[10.5px] tracking-[0.04em] text-[#f5e4b8]/65">{pr ? `Pool price now ${priceText(pr, priceAtSqrt(pr, x.pool.sqrtPriceX64))}` : 'A pair this site does not read'}</span>
                  </span>
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
 * Whether the token's holder can freeze accounts, the pool's vault included, said where the
 * token is picked, as the LP deposit says it: a known coin's own line (USDC: Circle), or the
 * chain's freeze authority. A read that failed is said as that, never as "cannot be frozen".
 */
function TokenFreezeNotice({ mint, read }: { mint: string; read: Read<MintFreeze> | null }) {
  const known = quoteCoin(mint);
  if (known?.risk) return <CoinRiskNotice coin={known} />;
  if (read?.kind === 'ok' && read.value.kind === 'mint' && read.value.freezeAuthority) {
    return (
      <div data-testid="range-token-freeze">
        <Notice tone="warn">{freezeWarning(mint, read.value.freezeAuthority).text}</Notice>
      </div>
    );
  }
  if (read?.kind === 'ok' && read.value.kind === 'not-a-mint') {
    return (
      <div data-testid="range-token-freeze">
        <Notice tone="warn">{`This address is not a token mint (${read.value.detail}), so there is nothing here to put in a pool.`}</Notice>
      </div>
    );
  }
  if (read?.kind === 'unread') {
    return (
      <div data-testid="range-token-freeze">
        <Notice tone="warn">{`Whether this token’s creator can freeze accounts could not be read just now (${read.detail}). Review checks it again.`}</Notice>
      </div>
    );
  }
  return null;
}

/**
 * The program's fee tiers as the chain has them, one numbered row each: the fee, and what
 * of it the positions in range share and the venue keeps, said before any pool is picked.
 * A tier whose venue cut goes anywhere but the agreed split says so in bold, in its row.
 */
function TierIndex({ tiers, picked }: { tiers: AmmConfigView[]; picked: string | null }) {
  return (
    <ol data-testid="range-tiers" aria-label="Fee tiers on the chain" className="!mt-4 border-t border-white/[0.14]">
      {tiers.map((t, i) => {
        const s = feeSplit(t);
        const venue = rangeVenueEarns(t);
        const on = t.address === picked;
        return (
          <li key={t.address} className="grid grid-cols-[1.75rem_minmax(0,1fr)] sm:grid-cols-[1.75rem_7.25rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-3 border-b border-white/[0.14] items-baseline">
            <span aria-hidden="true" className={`font-mono text-[11px] tracking-[0.12em] tabular-nums ${on ? 'text-[#22c55e]' : 'text-[#f5e4b8]/45'}`}>{pad2(i + 1)}</span>
            <span className="font-black text-[30px] sm:text-[34px] leading-none tracking-[-0.045em] tabular-nums" style={{ ...HEADING_FONT, color: on ? '#22c55e' : EDITORIAL_INK }}>{s.fee}</span>
            <span className="col-start-2 sm:col-start-auto text-[12px] leading-relaxed text-[#f5e4b8]/85">
              {`of each swap. ${s.lpOfFee} of that fee (${s.lpOfSwap} of the swap) goes to the positions in range, by their liquidity; the venue keeps ${s.venueOfFee} (${s.venueOfSwap}).`}
              {/* The picked pool's tier says it above, with the wallets named. */}
              {venue.elsewhere && !on && <strong className="block mt-1 text-amber-200">{venue.where}</strong>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * How a range position pays, said where the deposit is (never folded away): what LPs earn
 * and what the venue keeps, both read from the chosen pool's fee tier, and that a position
 * out of range earns nothing. Where the venue's cut goes is said as the /solana-lp Rates
 * card says it: the agreed split in the fine print, any other wallet in bold in plain sight.
 */
function HowItPays({ pool, pair, tiers }: { pool: RangePool | null; pair: Pair | null; tiers: AmmConfigView[] | null }) {
  const ceiling = pool ? poolFeeCeiling(pool.pool, pool.config.tradeFeeRate) : null;
  const s = pool ? feeSplit(pool.config, ceiling) : null;
  const venue = pool ? rangeVenueEarns(pool.config, ceiling) : null;
  const wallets = venue && (
    <div className="space-y-1">
      {venue.wallets.map((w) => (
        <Row key={w.address} label={w.label} value={w.address} />
      ))}
    </div>
  );
  return (
    <Card title="How a range position earns" testId="range-earns" index={1} art={<CardArt pageId="range-pools" idx={0} />}>
      {s ? (
        <p className="text-white/85">
          {`Each swap through your range pays a ${s.fee} fee. Positions whose range the price is in share ${s.lpOfFee} of it (${s.lpOfSwap} of the swap), split by how much liquidity each has there. The venue keeps ${s.venueOfFee} (${s.venueOfSwap} of the swap). Both shares are read from this pool’s fee tier on the chain.`}
        </p>
      ) : (
        <p className="text-white/85">
          Each swap through your range pays the pool’s fee. Positions whose range the price is in share most of it, and the venue keeps a part; pick a pool to see both, read from its fee tier on the chain.
        </p>
      )}
      {tiers && tiers.length > 0 && <TierIndex tiers={tiers} picked={pool?.config.address ?? null} />}
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
          <p>Opening a position pays deposits for its record and its NFT, which come back when you close it. A band of prices nobody has used yet also takes a deposit that never comes back, about 0.072 SOL each at today’s rent.</p>
          <p>Your coins sit in the pool’s vaults, which only the range program moves. The team’s vault can switch that program’s pools off or replace it: see Risks beside the deposit.</p>
        </div>
      </FinePrint>
    </Card>
  );
}
