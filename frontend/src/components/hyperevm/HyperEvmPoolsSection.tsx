import { useEffect, useMemo, useState } from 'react';
import { encodeFunctionData, erc20Abi } from 'viem';
import { WHYPE, hyperEvmAddressUrl, hyperEvmVenue, type HyperEvmToken, type HyperEvmVenue } from '../../lib/chains/hyperEvm';
import { amountText, bpsText, parseAmount, withDeadline } from '../../lib/hyperevm/format';
import { feeSplitText, feeTierText, type V3Pool } from '../../lib/hyperevm/pools';
import {
  PRESET_PCT, addTx, collectTx, pairedAmount, poolPriceText, rangeTicks, readPositions, removeTx, tickPriceText,
  type PositionsRead, type RangePreset, type V3PositionView,
} from '../../lib/hyperevm/positions';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';
import { asReader, useBalance, useHyperEvmClient, useHyperEvmSend, usePools } from './useHyperEvm';
import { CoinLine, Line, SendStatus } from './parts';
import { PRIMARY_BTN, PRIMARY_STYLE, QUIET_BTN, deadlineIn } from './styles';

const SLIPPAGE_BPS = 50;
const isWhype = (t: HyperEvmToken) => t.address.toLowerCase() === WHYPE.toLowerCase();
const pairName = (p: V3Pool) => `${p.token0.symbol} / ${p.token1.symbol}`;

/**
 * Our HyperEVM pools: each pool with its price, holdings and how its fee is split, your
 * positions (collect fees, take out), and add. No "open a pool": opening one needs ~4.6M gas,
 * more than a fast block holds, so only the venue opens pools, from an account on big blocks.
 */
export default function HyperEvmPoolsSection() {
  const venue = hyperEvmVenue();
  if (!venue) return null;
  return <Pools venue={venue} />;
}

function Pools({ venue }: { venue: HyperEvmVenue }) {
  const client = useHyperEvmClient();
  const { state, reload } = usePools(venue);
  const send = useHyperEvmSend();
  const [adding, setAdding] = useState<{ pool: V3Pool; position?: V3PositionView } | null>(null);
  const [positions, setPositions] = useState<PositionsRead | null>(null);
  const [refresh, setRefresh] = useState(0);
  const pools = state.status === 'ready' ? state.pools : null;

  useEffect(() => {
    if (!client || !pools || !send.address) {
      setPositions(null);
      return;
    }
    let live = true;
    void withDeadline(readPositions(asReader(client), venue, send.address, pools), { ok: false as const }).then((r) => live && setPositions(r));
    return () => {
      live = false;
    };
  }, [client, pools, venue, send.address, refresh]);

  const after = () => {
    reload();
    setRefresh((n) => n + 1);
  };

  return (
    <div className="space-y-4" data-testid="hyperevm-pools">
      <section className="relative isolate overflow-hidden rounded-2xl p-5" style={{ border: '1px solid rgba(255,255,255,0.12)' }} data-ui-card="">
        <CardArt pageId="liquidity" idx={1} />
        <div className="relative z-10 space-y-3">
          <h2 className="text-white font-semibold text-[15px]">Our pools on HyperEVM</h2>
          <p className="text-white/75 text-[12px]">LPs earn each pool's fee on every trade while the price is in their range. The venue keeps a fixed share of it, read from each pool below.</p>
          {state.status === 'loading' && <p role="status" className="text-white/70 text-[12px]">Reading our pools…</p>}
          {state.status === 'unread' && <p role="status" className="text-amber-300/90 text-[12px]">Our pools could not be read just now.</p>}
          {pools && pools.length === 0 && <p className="text-white/75 text-[12px]">No pools are open yet. Only the venue opens pools on HyperEVM.</p>}
          {pools?.map((p) => <PoolRow key={p.address} pool={p} onAdd={() => setAdding({ pool: p })} />)}
          <FinePrint summary="Why only the venue opens pools">
            <p>Opening a Uniswap V3 pool costs about 4.6 million gas. HyperEVM's fast blocks hold 3 million, so an opening only fits in a big block, which an account gets only after a Hyperliquid setting is switched on. The venue opens each pool from such an account and switches its cut on in the same run.</p>
            <p>A pool shows here only when both its coins are on the site's list, read from our factory, so a pool of a copy-coin never does.</p>
          </FinePrint>
        </div>
      </section>

      {adding && <AddCard key={`${adding.pool.address}:${adding.position?.tokenId ?? 'new'}`} venue={venue} pool={adding.pool} position={adding.position} send={send} onClose={() => setAdding(null)} onDone={after} />}

      <PositionsCard venue={venue} read={state.status === 'unread' ? { ok: false } : positions} connected={send.isConnected} send={send} onAdd={(position) => setAdding({ pool: position.pool, position })} onDone={after} />
    </div>
  );
}

function PoolRow({ pool, onAdd }: { pool: V3Pool; onAdd: () => void }) {
  const split = feeSplitText(pool.fee, pool.venueShare0);
  return (
    <div className="rounded-xl bg-black/50 p-3 space-y-1.5 text-[12px]" data-testid="hyperevm-pool">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-white font-semibold text-[14px]">{pairName(pool)} <span className="text-white/70 font-normal">{feeTierText(pool.fee)}</span></span>
        <button type="button" className={QUIET_BTN} onClick={onAdd} data-testid="hyperevm-pool-add">Add</button>
      </div>
      <Line label="Price" value={`1 ${pool.token0.symbol} = ${poolPriceText(pool)} ${pool.token1.symbol}`} />
      <Line label="Holds" value={`${amountText(pool.reserve0, pool.token0.decimals)} ${pool.token0.symbol} + ${amountText(pool.reserve1, pool.token1.decimals)} ${pool.token1.symbol}`} />
      <Line label="Fee split" value={split.venue ? `${split.lps} to LPs, ${split.venue} to the venue` : `${split.lps} to LPs (the venue's cut is not on yet)`} />
      <Line label="Pool" value={<a className="underline" href={hyperEvmAddressUrl(pool.address)} target="_blank" rel="noopener noreferrer">{pool.address}</a>} mono />
      <FinePrint summary="The two coins">
        <CoinLine token={pool.token0} />
        <CoinLine token={pool.token1} />
      </FinePrint>
    </div>
  );
}

function PositionsCard(p: {
  venue: HyperEvmVenue; read: PositionsRead | null; connected: boolean; send: ReturnType<typeof useHyperEvmSend>;
  onAdd: (position: V3PositionView) => void; onDone: () => void;
}) {
  return (
    <section className="relative isolate overflow-hidden rounded-2xl p-5" style={{ border: '1px solid rgba(255,255,255,0.12)' }} data-testid="hyperevm-positions" data-ui-card="">
      <CardArt pageId="liquidity" idx={0} />
      <div className="relative z-10 space-y-3">
        <h2 className="text-white font-semibold text-[15px]">Your positions</h2>
        {!p.connected && <p className="text-white/75 text-[12px]">Connect a wallet to see your positions.</p>}
        {p.connected && p.read === null && <p role="status" className="text-white/70 text-[12px]">Reading your positions…</p>}
        {p.read && !p.read.ok && <p role="status" className="text-amber-300/90 text-[12px]">Your positions could not be read just now.</p>}
        {p.read?.ok && p.read.positions.length === 0 && <p className="text-white/75 text-[12px]">No open positions in our pools.</p>}
        {p.read?.ok && p.read.positions.map((pos) => <PositionRow key={pos.tokenId.toString()} venue={p.venue} position={pos} send={p.send} onAdd={() => p.onAdd(pos)} onDone={p.onDone} />)}
        {p.read?.ok && (p.read.unlisted > 0 || p.read.closed > 0 || p.read.more > 0) && (
          <p className="text-white/70 text-[11px]">
            {p.read.closed > 0 && `${p.read.closed} emptied, not shown. `}
            {p.read.unlisted > 0 && `${p.read.unlisted} more in pools of coins this site does not list. `}
            {p.read.more > 0 && `${p.read.more} more not shown.`}
          </p>
        )}
      </div>
    </section>
  );
}

type RowAction = { kind: 'collect' } | { kind: 'remove'; pct: number } | null;

function PositionRow({ venue, position: pos, send, onAdd, onDone }: { venue: HyperEvmVenue; position: V3PositionView; send: ReturnType<typeof useHyperEvmSend>; onAdd: () => void; onDone: () => void }) {
  const [action, setAction] = useState<RowAction>(null);
  const [hype, setHype] = useState(true);
  const hasWhype = isWhype(pos.pool.token0) || isWhype(pos.pool.token1);
  const { token0: t0, token1: t1 } = pos.pool;
  const owedKnown = pos.owed0 !== null && pos.owed1 !== null;
  const hasFees = owedKnown && (pos.owed0! > 0n || pos.owed1! > 0n);
  const working = send.state.kind === 'wallet' || send.state.kind === 'mining';
  const out = (t: HyperEvmToken) => (hype && isWhype(t) ? 'HYPE' : t.symbol);

  const go = async () => {
    if (!action || !send.address) return;
    const recipient = send.address;
    const ok = await send.run([{
      label: action.kind === 'collect' ? 'Collect fees' : `Take out ${action.pct}%`,
      tx: async () => (action.kind === 'collect'
        ? collectTx({ venue, position: pos, recipient, hype: hype && hasWhype })
        : removeTx({ venue, position: pos, pct: action.pct, recipient, slippageBps: SLIPPAGE_BPS, deadline: deadlineIn(20), hype: hype && hasWhype })),
    }]);
    if (ok) {
      setAction(null);
      onDone();
    }
  };

  return (
    <div className="rounded-xl bg-black/50 p-3 space-y-1.5 text-[12px]" data-testid="hyperevm-position">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-white font-semibold text-[14px]">{pairName(pos.pool)} <span className="text-white/70 font-normal">{feeTierText(pos.pool.fee)} · #{pos.tokenId.toString()}</span></span>
        <span className={pos.inRange ? 'text-emerald-300' : 'text-amber-300/90'}>{pos.liquidity === 0n ? 'Emptied: fees left to collect' : pos.inRange ? 'In range: earning' : 'Out of range: not earning'}</span>
      </div>
      <Line label="Range" value={`${tickPriceText(pos.pool, pos.tickLower)} to ${tickPriceText(pos.pool, pos.tickUpper)} ${t1.symbol} per ${t0.symbol}`} />
      <Line label="Holds" value={`${amountText(pos.amount0, t0.decimals)} ${t0.symbol} + ${amountText(pos.amount1, t1.decimals)} ${t1.symbol}`} />
      <Line label="Fees earned" value={owedKnown ? `${amountText(pos.owed0!, t0.decimals)} ${t0.symbol} + ${amountText(pos.owed1!, t1.decimals)} ${t1.symbol}` : 'Could not be read just now'} />
      {send.onChain ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" className={QUIET_BTN} disabled={!hasFees || working} onClick={() => setAction({ kind: 'collect' })}>Collect fees</button>
          {pos.liquidity > 0n && [25, 50, 100].map((pct) => (
            <button key={pct} type="button" className={QUIET_BTN} disabled={working} onClick={() => setAction({ kind: 'remove', pct })}>Take out {pct}%</button>
          ))}
          <button type="button" className={QUIET_BTN} disabled={working} onClick={onAdd}>Add more</button>
        </div>
      ) : (
        <button type="button" className={QUIET_BTN} onClick={() => void send.switchToHyperEvm()}>Switch wallet to HyperEVM</button>
      )}
      {action && (
        <div className="rounded-lg bg-black/55 p-3 space-y-1.5" data-testid="hyperevm-position-review">
          <div className="text-white font-semibold text-[13px]">Review</div>
          {action.kind === 'collect' ? (
            <Line label="You collect" value={`${amountText(pos.owed0 ?? 0n, t0.decimals)} ${out(t0)} + ${amountText(pos.owed1 ?? 0n, t1.decimals)} ${out(t1)}`} />
          ) : (
            <>
              <Line label="You take out" value={`${action.pct}% of the position, about ${amountText((pos.amount0 * BigInt(action.pct)) / 100n, t0.decimals)} ${out(t0)} + ${amountText((pos.amount1 * BigInt(action.pct)) / 100n, t1.decimals)} ${out(t1)}`} />
              <Line label="And its fees" value={owedKnown ? `${amountText(pos.owed0!, t0.decimals)} ${out(t0)} + ${amountText(pos.owed1!, t1.decimals)} ${out(t1)}` : 'Not read; whatever is owed comes too'} />
              <Line label="Price may move" value={`${bpsText(SLIPPAGE_BPS)} before it is refused`} />
            </>
          )}
          {hasWhype && (
            <label className="flex items-center gap-2 text-white/80 min-h-[36px]">
              <input type="checkbox" checked={hype} onChange={(e) => setHype(e.target.checked)} /> Receive HYPE, not WHYPE
            </label>
          )}
          <Line label="Position manager" value={venue.positionManager} mono />
          <div className="flex gap-2">
            <button type="button" className={QUIET_BTN} onClick={() => setAction(null)} disabled={working}>Back</button>
            <button type="button" className={PRIMARY_BTN} style={PRIMARY_STYLE} onClick={() => void go()} disabled={working}>{action.kind === 'collect' ? 'Collect' : 'Take out'}</button>
          </div>
          <SendStatus state={send.state} />
        </div>
      )}
    </div>
  );
}

type RangeChoice = RangePreset | 'custom';

function AddCard({ venue, pool, position, send, onClose, onDone }: { venue: HyperEvmVenue; pool: V3Pool; position?: V3PositionView; send: ReturnType<typeof useHyperEvmSend>; onClose: () => void; onDone: () => void }) {
  const client = useHyperEvmClient();
  const [choice, setChoice] = useState<RangeChoice>('wide');
  const [lower, setLower] = useState('');
  const [upper, setUpper] = useState('');
  const [side, setSide] = useState<0 | 1>(0);
  const [text, setText] = useState('');
  const [useHype, setUseHype] = useState(true);
  const [review, setReview] = useState(false);
  const { token0: t0, token1: t1 } = pool;
  const hasWhype = isWhype(t0) || isWhype(t1);
  const hypeNative = useHype && hasWhype;
  // The WHYPE side paid in HYPE is held to the wallet's HYPE.
  const pay0 = useMemo<HyperEvmToken>(() => (hypeNative && isWhype(t0) ? { ...t0, isNative: true } : t0), [hypeNative, t0]);
  const pay1 = useMemo<HyperEvmToken>(() => (hypeNative && isWhype(t1) ? { ...t1, isNative: true } : t1), [hypeNative, t1]);
  const bal0 = useBalance(pay0, send.address, 0);
  const bal1 = useBalance(pay1, send.address, 0);

  const ticks = useMemo(() => {
    if (position) return { tickLower: position.tickLower, tickUpper: position.tickUpper };
    return choice === 'custom' ? rangeTicks(pool, { lower, upper }) : rangeTicks(pool, choice);
  }, [position, choice, lower, upper, pool]);
  const typed = parseAmount(text, side === 0 ? t0.decimals : t1.decimals);
  const amounts = useMemo(() => (ticks && typed !== null ? pairedAmount(pool, ticks, side, typed) : null), [ticks, typed, pool, side]);
  const short = amounts && ((bal0 !== null && amounts.amount0 > bal0) || (bal1 !== null && amounts.amount1 > bal1));
  const working = send.state.kind === 'wallet' || send.state.kind === 'mining';
  const symbolOf = (t: HyperEvmToken) => (hypeNative && isWhype(t) ? 'HYPE' : t.symbol);

  const go = async () => {
    if (!ticks || !amounts || !send.address || !client) return;
    const owner = send.address;
    const approve = (t: HyperEvmToken, amount: bigint) => ({
      label: `Allow the position manager to take ${t.symbol}`,
      tx: async () => {
        if (amount === 0n || (hypeNative && isWhype(t))) return null;
        const allowed = await client.readContract({ address: t.address, abi: erc20Abi, functionName: 'allowance', args: [owner, venue.positionManager] });
        if (allowed >= amount) return null;
        return { to: t.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [venue.positionManager, amount] }) };
      },
    });
    const ok = await send.run([
      approve(t0, amounts.amount0),
      approve(t1, amounts.amount1),
      {
        label: position ? 'Add to the position' : 'Open the position',
        tx: async () => addTx({ venue, pool, ...ticks, amount0: amounts.amount0, amount1: amounts.amount1, recipient: owner, slippageBps: SLIPPAGE_BPS, deadline: deadlineIn(20), tokenId: position?.tokenId, useHype: hypeNative }),
      },
    ]);
    if (ok) {
      setText('');
      setReview(false);
      onDone();
    }
  };

  const chip = (c: RangeChoice, label: string) => (
    <button key={c} type="button" aria-pressed={choice === c} onClick={() => { setChoice(c); setReview(false); }} className="min-h-[36px] px-3 rounded-full text-[12px]" style={choice === c ? { background: 'rgba(139,92,246,0.35)', color: '#fff' } : { background: 'rgba(0,0,0,0.45)', color: 'rgba(255,255,255,0.8)' }}>
      {label}
    </button>
  );

  return (
    <section className="relative isolate overflow-hidden rounded-2xl p-5" style={{ border: '1px solid rgba(139,92,246,0.45)' }} data-testid="hyperevm-add" data-ui-card="">
      <CardArt pageId="liquidity" idx={1} />
      <div className="relative z-10 space-y-3 text-[12px]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-white font-semibold text-[15px]">{position ? `Add to #${position.tokenId.toString()}` : 'Add'}: {pairName(pool)} {feeTierText(pool.fee)}</h2>
          <button type="button" className={QUIET_BTN} onClick={onClose}>Close</button>
        </div>
        <Line label="Price now" value={`1 ${t0.symbol} = ${poolPriceText(pool)} ${t1.symbol}`} />
        {!position && (
          <div className="space-y-2">
            <div className="text-white/80">Your range</div>
            <div className="flex flex-wrap gap-2">
              {chip('full', 'Every price')}
              {chip('wide', `±${PRESET_PCT.wide}%`)}
              {chip('narrow', `±${PRESET_PCT.narrow}%`)}
              {chip('custom', 'Set prices')}
            </div>
            {choice === 'custom' && (
              <div className="grid grid-cols-2 gap-2">
                <input inputMode="decimal" placeholder="Low price" aria-label={`Low price, ${t1.symbol} per ${t0.symbol}`} value={lower} onChange={(e) => setLower(e.target.value)} className="min-w-0 rounded-lg bg-black/55 px-3 py-2 text-white text-[16px] outline-none" />
                <input inputMode="decimal" placeholder="High price" aria-label={`High price, ${t1.symbol} per ${t0.symbol}`} value={upper} onChange={(e) => setUpper(e.target.value)} className="min-w-0 rounded-lg bg-black/55 px-3 py-2 text-white text-[16px] outline-none" />
              </div>
            )}
          </div>
        )}
        {ticks && <Line label="Range" value={`${tickPriceText(pool, ticks.tickLower)} to ${tickPriceText(pool, ticks.tickUpper)} ${t1.symbol} per ${t0.symbol}`} />}
        {!ticks && choice === 'custom' && <p className="text-white/70">Type a low and a high price.</p>}

        <div className="flex items-center gap-2">
          <input inputMode="decimal" placeholder="0.0" aria-label={`Amount of ${symbolOf(side === 0 ? t0 : t1)} to add`} value={text} onChange={(e) => { setText(e.target.value); setReview(false); }} className="min-w-0 flex-1 rounded-lg bg-black/55 px-3 py-2 text-white text-[16px] outline-none" data-testid="hyperevm-add-amount" />
          <select aria-label="Coin you type an amount of" value={side} onChange={(e) => { setSide(Number(e.target.value) as 0 | 1); setText(''); }} className="min-h-[44px] rounded-full bg-black/60 px-3 text-white text-[14px] font-semibold outline-none" style={{ border: '1px solid rgba(255,255,255,0.18)' }}>
            <option value={0}>{symbolOf(t0)}</option>
            <option value={1}>{symbolOf(t1)}</option>
          </select>
        </div>
        {typed !== null && ticks && !amounts && <p className="text-white/75">The price is past this edge of your range, so it takes only the other coin. Type an amount of {symbolOf(side === 0 ? t1 : t0)}.</p>}
        {amounts && <Line label="You put in" value={`${amountText(amounts.amount0, t0.decimals)} ${symbolOf(t0)} + ${amountText(amounts.amount1, t1.decimals)} ${symbolOf(t1)}`} />}
        {short && <p className="text-amber-300/90">More than this wallet holds.</p>}
        {hasWhype && (
          <label className="flex items-center gap-2 text-white/80 min-h-[36px]">
            <input type="checkbox" checked={useHype} onChange={(e) => setUseHype(e.target.checked)} /> Pay the WHYPE side in HYPE
          </label>
        )}

        {!send.isConnected ? (
          <p className="text-white/75">Connect a wallet to add.</p>
        ) : !send.onChain ? (
          <button type="button" className={PRIMARY_BTN} style={PRIMARY_STYLE} onClick={() => void send.switchToHyperEvm()}>Switch wallet to HyperEVM</button>
        ) : !review ? (
          <button type="button" className={PRIMARY_BTN} style={PRIMARY_STYLE} disabled={!amounts || !!short || working} onClick={() => setReview(true)} data-testid="hyperevm-add-review-button">Review</button>
        ) : (
          <div className="rounded-lg bg-black/55 p-3 space-y-1.5" data-testid="hyperevm-add-review">
            <div className="text-white font-semibold text-[13px]">Review</div>
            {amounts && <Line label="You put in, at most" value={`${amountText(amounts.amount0, t0.decimals)} ${symbolOf(t0)} + ${amountText(amounts.amount1, t1.decimals)} ${symbolOf(t1)}`} />}
            {ticks && <Line label="Range" value={`${tickPriceText(pool, ticks.tickLower)} to ${tickPriceText(pool, ticks.tickUpper)} ${t1.symbol} per ${t0.symbol}`} />}
            <Line label="Price may move" value={`${bpsText(SLIPPAGE_BPS)} before it is refused`} />
            <Line label="You earn" value={`${feeTierText(pool.fee)} of each trade in your range, shared with the pool's other LPs, less the venue's share`} />
            <Line label="Position manager" value={venue.positionManager} mono />
            <div className="flex gap-2">
              <button type="button" className={QUIET_BTN} onClick={() => setReview(false)} disabled={working}>Back</button>
              <button type="button" className={PRIMARY_BTN} style={PRIMARY_STYLE} onClick={() => void go()} disabled={working} data-testid="hyperevm-add-send">{position ? 'Add' : 'Open position'}</button>
            </div>
          </div>
        )}
        <SendStatus state={send.state} />
        <FinePrint summary="How adding works">
          <p>Your position is an NFT from our position manager (Uniswap's NonfungiblePositionManager, unchanged), and the amounts are worked out by Uniswap's own SDK. Each coin you put in from your wallet is first approved for exactly that amount. Any HYPE not used is sent back in the same transaction.</p>
          <p>A position earns only while the price is inside its range. Outside it, it holds one coin only, and earns nothing until the price comes back. A narrow range earns more per trade and leaves the range sooner.</p>
        </FinePrint>
      </div>
    </section>
  );
}
