import type { PoolEntry, PoolView } from '../../../lib/solana/lp/poolFinder';
import { formatWhen, type PoolHealth } from '../../../lib/solana/lp/poolHealth';
import { feeRateText, formatSolPrice, solText, tokenText } from '../../../lib/solana/lp/format';
import { feeSplit } from '../../../lib/solana/cpswap/venue';
import { Notice, Row } from '../curve/ui';
import { CARD, CARD_STYLE, SHADOW } from '../curve/uiFormat';

const ORIGIN_LABEL: Record<PoolView['origin'], string> = {
  'launch-pool': 'Launch pool: opened by the launch program when the token graduated',
  standard: 'At the standard address for its fee tier (anyone could have opened it)',
  other: 'At its own address (anyone could have opened it)',
};

function swapsText(h: PoolHealth): { text: string; tone: 'good' | 'warn' | 'bad' } {
  switch (h.swaps.state) {
    case 'open':
      return { text: 'Open', tone: 'good' };
    case 'switched-off':
      return { text: 'Switched off by the pool program’s admin', tone: 'bad' };
    case 'unread':
      return { text: `Not checked: ${h.swaps.detail}`, tone: 'warn' };
    case 'not-open-yet':
      return h.swaps.farFuture
        ? { text: `Blocked until ${formatWhen(h.swaps.opensAt)}. A pool set up like this cannot trade.`, tone: 'bad' }
        : { text: `Opens ${formatWhen(h.swaps.opensAt)}`, tone: 'warn' };
  }
}

const DEPOSIT_TITLE = {
  allowed: 'Deposits: the checks pass',
  refused: 'Deposits: refused here',
  unchecked: 'Deposits: not checked',
} as const;

export function PoolCard({ view, health, tokenDecimals }: { view: PoolView; health: PoolHealth; tokenDecimals: number | null }) {
  const { pool } = view.snapshot;
  const swaps = swapsText(health);
  const cfg = view.config;
  const split = cfg ? feeSplit(cfg) : null;
  const solFees = view.solIsToken0 ? [pool.protocolFeesToken0 + pool.fundFeesToken0, pool.creatorFeesToken0] : [pool.protocolFeesToken1 + pool.fundFeesToken1, pool.creatorFeesToken1];
  const tokFees = view.solIsToken0 ? [pool.protocolFeesToken1 + pool.fundFeesToken1, pool.creatorFeesToken1] : [pool.protocolFeesToken0 + pool.fundFeesToken0, pool.creatorFeesToken0];
  const price = health.price;

  return (
    <li
      className={CARD}
      style={CARD_STYLE}
      data-testid="lp-pool"
      data-pool={view.address}
      data-origin={view.origin}
      data-swaps={health.swaps.state}
      data-deposits={health.deposits.verdict}
      data-price={price.state}
    >
      <h3 className="text-white font-semibold text-[13px] mb-1" style={SHADOW}>
        {view.origin === 'launch-pool' ? 'Launch pool' : view.origin === 'standard' ? `Standard address, fee tier ${cfg?.index ?? '?'}` : 'Pool at its own address'}
      </h3>
      <p className="text-white/50 text-[11px] mb-2">{ORIGIN_LABEL[view.origin]}</p>
      <div className="text-white/60 text-[11px] leading-relaxed space-y-2">
        <Row label="Pool address" value={view.address} />
        <Row label="Token" value={view.tokenMint} />

        <Row label="Swaps" value={swaps.text} mono={false} />
        <Row label="Withdrawals" value={health.withdrawals === 'open' ? 'Open' : 'Switched off by the pool program’s admin'} mono={false} />
        <div data-testid="lp-pool-deposits">
          <p className={`text-[12px] font-semibold ${health.deposits.verdict === 'allowed' ? 'text-emerald-300/90' : health.deposits.verdict === 'refused' ? 'text-rose-300/90' : 'text-amber-300/90'}`}>
            {DEPOSIT_TITLE[health.deposits.verdict]}
          </p>
          {health.deposits.reasons.map((r) => (
            <Notice key={r} tone={health.deposits.verdict === 'refused' ? 'bad' : 'warn'}>{r}</Notice>
          ))}
          {health.deposits.verdict === 'allowed' && (
            <Notice>Adding liquidity from this page is not switched on yet. These checks will run again before any deposit.</Notice>
          )}
        </div>

        <Row label="In the pool" value={`${solText(view.solReserve)} and ${tokenText(view.tokenReserve, tokenDecimals)}`} mono={false} />
        {price.state === 'empty-pool' ? (
          <Row label="Price" value="No price: one side is empty" mono={false} />
        ) : price.state === 'unread' ? (
          <>
            <Row label="Price here" value={price.pool === null ? 'not worked out' : `1 token = ${formatSolPrice(price.pool)} SOL`} mono={false} />
            <Row label="Outside price" value={`not read (${price.detail})`} mono={false} />
          </>
        ) : (
          <>
            <Row label="Price here" value={`1 token = ${formatSolPrice(price.pool)} SOL`} mono={false} />
            <Row label="Outside price (Jupiter)" value={`1 token = ${formatSolPrice(price.outside)} SOL`} mono={false} />
            <Row label="Difference" value={`${(price.diff * 100).toFixed(1)}% ${price.diff >= 0 ? 'above' : 'below'}`} mono={false} />
          </>
        )}

        {cfg && split ? (
          <>
            <Row label={`Fee tier ${cfg.index}`} value={`Traders pay ${feeRateText(cfg.tradeFeeRate)} a trade`} mono={false} />
            <Row label="Of that fee" value={`LPs keep ${split.lpKeepsPct.toFixed(3)}% of each trade, the venue ${split.venueTakesPct.toFixed(3)}%`} mono={false} />
            {pool.enableCreatorFee && cfg.creatorFeeRate > 0n && (
              <Row label="Creator fee" value={`${feeRateText(cfg.creatorFeeRate)} a trade, on top`} mono={false} />
            )}
          </>
        ) : (
          <Notice tone="warn">This pool’s fee settings could not be read.</Notice>
        )}
        <Row label="Fees waiting: venue’s share" value={`${solText(solFees[0]!)} and ${tokenText(tokFees[0]!, tokenDecimals)}`} mono={false} />
        {pool.enableCreatorFee && (
          <Row label="Fees waiting: creator’s share" value={`${solText(solFees[1]!)} and ${tokenText(tokFees[1]!, tokenDecimals)}`} mono={false} />
        )}
        <Notice>
          LPs’ share of fees is not paid out separately: it stays in the pool, so each pool share is worth a little more after every trade.
        </Notice>
        <Row label="Pool shares issued" value={tokenText(pool.lpSupply, pool.lpMintDecimals, 'shares')} mono={false} />
        <Row label="Opened by" value={pool.poolCreator} />
      </div>
    </li>
  );
}

export function UnreadPoolCard({ entry }: { entry: Extract<PoolEntry, { kind: 'unread' }> }) {
  return (
    <li className={CARD} style={CARD_STYLE} data-testid="lp-pool" data-pool={entry.address} data-deposits="unchecked" data-swaps="unread">
      <h3 className="text-white font-semibold text-[13px] mb-1" style={SHADOW}>Pool not read</h3>
      <div className="text-white/60 text-[11px] leading-relaxed space-y-2">
        <Row label="Pool address" value={entry.address} />
        <Notice tone="warn">We could not read this pool ({entry.detail}). Nothing about it is checked.</Notice>
      </div>
    </li>
  );
}
