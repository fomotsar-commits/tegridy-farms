import { formatEther } from 'viem';
import { m } from 'framer-motion';
import { HowItWorks, RiskBanner, InfoTooltip } from '../ui/InfoTooltip';
import {
  usePooledLendingVaults,
  pooledLendingHistoryGate,
  type PooledVaultState,
} from '../../hooks/usePooledLendingVault';
import { isPooledLendingLive } from '../../hooks/usePooledLendingConfig';

// Pooled NFT lending (#61) — the lender side of the existing P2P desk, pooled.
//
// THE HONEST FRAME THIS SURFACE HAS TO KEEP: NFT lending volume is down roughly
// 97% from its 2022 peak. This is a cheap addition on rails the venue already
// has, and it is small. Nothing here may be drawn at a size that implies a book
// exists, and no card may show a figure the chain has not been asked for.
//
// Every number below is either read live from a deployed pool or absent. There
// is no fallback, no placeholder figure and no "example" pool: a pool with no
// contract renders the reason it has none.

const CARD_BG = 'rgba(6, 12, 26, 0.80)';
const CARD_BORDER = 'rgba(255, 255, 255, 0.18)';
const LABEL_STYLE: React.CSSProperties = { textShadow: '0 1px 6px rgba(0,0,0,0.95)' };
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function eth(wei: bigint | null): string {
  if (wei === null) return 'no data';
  const n = Number(formatEther(wei));
  if (n === 0) return '0 ETH';
  return `${n < 0.001 ? n.toExponential(2) : n.toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH`;
}

function pct(bps: number | null): string {
  return bps === null ? 'no data' : `${(bps / 100).toFixed(2)}%`;
}

function days(seconds: number | null): string {
  return seconds === null ? 'no data' : `${Math.round(seconds / 86400)}d`;
}

/** A figure and its label, or the reason there is no figure. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const missing = value === 'no data';
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-white/55" style={LABEL_STYLE}>
        {label}
        {hint && <InfoTooltip text={hint} />}
      </div>
      <div
        className={`text-[14px] font-semibold ${missing ? 'text-white/40 italic' : 'text-white'}`}
        style={LABEL_STYLE}
      >
        {value}
      </div>
    </div>
  );
}

function PoolCard({ state }: { state: PooledVaultState }) {
  const { pool, status } = state;

  return (
    <div className="rounded-xl p-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-[14px] font-semibold text-white" style={LABEL_STYLE}>
            {pool.label}
          </h3>
          <p className="text-[11px] text-white/50 font-mono">{pool.collection}</p>
        </div>
        <span
          className={`rounded-full text-[9px] font-semibold leading-none px-2 py-1 uppercase tracking-wide border ${
            status === 'live'
              ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
              : status === 'unreadable'
                ? 'bg-red-500/20 text-red-300 border-red-500/30'
                : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
          }`}
        >
          {status === 'live' ? 'Live' : status === 'unreadable' ? 'Unreadable' : 'Not deployed'}
        </span>
      </div>

      {state.detail && (
        <p className="text-[12px] text-white/60 leading-relaxed mb-3" style={LABEL_STYLE}>
          {state.detail}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Stat
          label="Pool size"
          value={eth(state.tvlWei)}
          hint="Idle WETH plus principal the pool still expects back. Interest that has accrued but not been paid is deliberately excluded, and so is any seized NFT that has not been sold."
        />
        <Stat label="Lent out" value={eth(state.outstandingWei)} />
        <Stat
          label="Written down"
          value={eth(state.seizedWei)}
          hint="Principal behind collateral the pool has seized and nobody has sold yet. It is off the balance sheet until real proceeds arrive."
        />
        <Stat label="Max LTV" value={pct(state.ltvBps)} />
        <Stat label="Borrow APR" value={pct(state.aprBps)} />
        <Stat label="Term" value={days(state.loanDurationSeconds)} />
      </div>

      {status === 'live' && (
        <div className="mt-3 space-y-1.5 text-[11px] leading-relaxed" style={LABEL_STYLE}>
          {state.hasFloor === false && (
            <p className="text-amber-300">
              No floor has been published to this pool, so it will not quote a loan. That is the contract closing
              itself, not a valuation of zero.
            </p>
          )}
          {state.hasFloor === true && state.floorFresh === false && (
            <p className="text-amber-300">
              The published floor is {Math.round((state.floorAgeSeconds ?? 0) / 3600)}h old and past the contract&rsquo;s
              freshness window, so borrowing is closed until it is republished. Nothing republishes it automatically.
            </p>
          )}
          {state.hasLiquidationSink === false && (
            <p className="text-white/60">
              No liquidation route is configured, so no collateral can leave this pool except by repayment.
            </p>
          )}
          <p className="text-white/60">
            Fees: {pct(state.originationFeeBps)} origination, {pct(state.interestFeeBps)} of interest.
          </p>
        </div>
      )}
    </div>
  );
}

export function PooledLendingSection() {
  const vaults = usePooledLendingVaults();
  const anyLive = isPooledLendingLive();
  const history = pooledLendingHistoryGate();

  return (
    <m.div
      className="space-y-6"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
    >
      <div className="rounded-xl p-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <h2 className="text-[16px] font-semibold text-white mb-1" style={LABEL_STYLE}>
          Pooled lending
        </h2>
        <p className="text-[12px] text-white/70 leading-relaxed" style={LABEL_STYLE}>
          Deposit WETH into one collection&rsquo;s pool and borrowers draw against it instantly, instead of waiting for a
          peer to write them an offer. One pool per collection: a loss on one collection reaches only the depositors who
          chose it. The peer-to-peer desk on the NFT Lending tab is unchanged and is still where bespoke terms live.
        </p>
      </div>

      <RiskBanner variant="warning">
        <span className="font-semibold">This is a small market and the surface will not pretend otherwise.</span>{' '}
        NFT lending volume across the whole sector is down roughly 97% from its 2022 peak. These pools are cheap to run
        on rails the venue already had; they are not a flagship, and any depth you see here is whatever depositors
        actually put in. Collateral is illiquid: a default is settled by selling an NFT, and what it fetches is what the
        pool recovers.
      </RiskBanner>

      {!anyLive && (
        <div
          className="rounded-xl p-4"
          style={{ background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.2)' }}
        >
          <p className="text-[13px] font-semibold text-amber-300 mb-1" style={LABEL_STYLE}>
            No pool is deployed.
          </p>
          <p className="text-[12px] text-white/70 leading-relaxed" style={LABEL_STYLE}>
            The pool contract is written and tested and has not been deployed to any chain. There is no address to call,
            so there are no balances to show and nothing below is a measurement. Depositing and borrowing become
            available if and when a deploy ceremony runs and an address lands in the app&rsquo;s constants.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {vaults.map((v) => (
          <PoolCard key={v.pool.key} state={v} />
        ))}
      </div>

      {!history.available && (
        <div className="rounded-xl p-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
          <p className="text-[12px] font-semibold text-white/80 mb-1" style={LABEL_STYLE}>
            No realized-yield or liquidation history
          </p>
          <p className="text-[12px] text-white/60 leading-relaxed" style={LABEL_STYLE}>
            {history.detail}
          </p>
        </div>
      )}

      <HowItWorks
        storageKey="tegridy-pooled-lending-how"
        title="How a pooled loan works"
        steps={[
          {
            label: 'Depositors fund one collection',
            description:
              'WETH goes into that collection’s pool and mints ERC-4626 shares. Share accounting is Solady’s, vendored at a pinned commit and unmodified.',
          },
          {
            label: 'A borrower draws against a published floor',
            description:
              'The pool lends a fraction of the floor the operator has published from the venue’s own order book. Nothing republishes that floor on a schedule, and once it goes stale the pool stops lending rather than lending on an old number.',
          },
          {
            label: 'Interest is only counted once it is paid',
            description:
              'Accrued-but-unpaid interest is deliberately kept out of the pool’s asset total, so the share price never moves on money nobody has handed over.',
          },
          {
            label: 'A default is settled by an actual sale',
            description:
              'Overdue collateral can be handed to the configured liquidation route by anyone. Nothing sweeps overdue loans on a timer — this venue runs no keeper. Sale proceeds repay the pool first and anything above the debt goes back to the borrower.',
          },
          {
            label: 'Withdrawals are bounded by cash on hand',
            description:
              'Principal that is out on loan is not withdrawable until it comes back. The pool reports the smaller number rather than letting a withdrawal fail at the last step.',
          },
        ]}
      />
    </m.div>
  );
}
