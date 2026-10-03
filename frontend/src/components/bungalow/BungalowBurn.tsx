import type { Bungalow } from '../../lib/bungalows';
import { useBungalowBurn } from '../../hooks/useBungalowBurn';
import {
  burnProofUrl,
  formatBurnPercent,
  formatCompactTokens,
  formatNotBurnt,
  formatWholeTokens,
  type BurnTally,
} from '../../lib/bungalowBurn';
import { HAIR, LEDGER_BG } from './ledger';

const CHAIN_LABEL: Partial<Record<Bungalow['chain'], string>> = { ethereum: 'Ethereum', base: 'Base', solana: 'Solana' };
const EXPLORER_LABEL: Partial<Record<Bungalow['chain'], string>> = {
  ethereum: 'The burn address on Etherscan',
  base: 'The burn address on Basescan',
  solana: 'The supply on Solscan',
};
const AMBER = '#f0b26b';

/**
 * The burn tracker: how much of this bungalow's token is gone for good, read from its chain.
 * One read on mount and a Refresh the reader controls. A read that failed says so in words;
 * the card never prints a zero, or a dash, for a figure it could not read.
 * Copy is symbol-driven: no other token's name may appear here (the door sweep checks).
 */
export function BungalowBurn({ bungalow }: { bungalow: Bungalow }) {
  const { burn, isReading, refresh } = useBungalowBurn(bungalow);
  if (burn.status === 'idle') return null;

  const { symbol } = bungalow;
  return (
    <section
      className="rounded-2xl p-6"
      style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
      aria-label={`${symbol} burn`}
    >
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>
          The burn
        </p>
        <h2 className="heading-luxury text-xl text-white">{symbol} burnt</h2>
        <span className="text-[11px] text-white/45">{CHAIN_LABEL[bungalow.chain]}</span>
        {/* ml-auto, not a spacer: when the row wraps on a phone the button still sits at the right. */}
        <button
          type="button"
          onClick={refresh}
          disabled={isReading}
          className="ml-auto min-h-[44px] text-[11px] px-3 rounded border border-white/10 bg-white/5 text-white/70 hover:text-white disabled:opacity-50"
        >
          {isReading ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      {burn.status === 'read' ? (
        <BurnLedger bungalow={bungalow} tally={burn.tally} />
      ) : burn.status === 'loading' ? (
        <p className="text-[12px] text-white/55">Reading the {symbol} burn…</p>
      ) : burn.status === 'unread' ? (
        <p role="status" className="text-[12px]" style={{ color: AMBER }}>
          The {symbol} burn could not be read right now. That is an outage, not a zero.
        </p>
      ) : (
        <p role="status" className="text-[12px]" style={{ color: AMBER }}>
          The {symbol} supply on chain does not match the record this card works from, so no burn figure is shown.
        </p>
      )}
    </section>
  );
}

function BurnLedger({ bungalow, tally }: { bungalow: Bungalow; tally: Extract<BurnTally, { ok: true }> }) {
  const { symbol } = bungalow;
  const { decimals, uncountedFallRaw } = tally;
  const whole = (raw: bigint) => formatWholeTokens(raw, decimals);
  // Each way this token's burn is counted, in ledger order. A row per way only when there are several.
  const ways: { label: string; phrase: string; raw: bigint }[] = [];
  if (tally.atBurnAddressRaw !== undefined) {
    ways.push({ label: 'Sent to the burn address', phrase: 'sent to the burn address', raw: tally.atBurnAddressRaw });
  }
  if (tally.inOwnContractRaw !== undefined) {
    ways.push({ label: 'Stuck in the token contract', phrase: "stuck for good in the token's own contract", raw: tally.inOwnContractRaw });
  }
  if (tally.destroyedRaw !== undefined) {
    ways.push({ label: 'Destroyed outright', phrase: 'destroyed outright, which lowers the supply', raw: tally.destroyedRaw });
  }
  const hasBurnAddress = tally.atBurnAddressRaw !== undefined;
  const notBurnt = formatNotBurnt(tally);
  const proofUrl = burnProofUrl(bungalow);
  const proofLabel = EXPLORER_LABEL[bungalow.chain];
  // The bar is a picture of the percent beside it; a real burn too small to draw still shows a sliver.
  const meterWidth = Math.min(100, tally.burntPpm / 10_000);

  return (
    <>
      <div className="overflow-hidden rounded-[14px]" style={{ background: LEDGER_BG, border: `1px solid ${HAIR}` }}>
        <div className="px-4 py-4 sm:px-5">
          <p className="m-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="text-white font-semibold tabular-nums leading-none text-[30px] sm:text-[36px]">
              {formatBurnPercent(tally)}
            </span>
            <span className="text-[11px] uppercase tracking-[0.12em] text-white/60">burnt</span>
          </p>
          <p className="m-0 mt-2 text-[13px] text-white/85 tabular-nums">
            {formatCompactTokens(tally.burntRaw, decimals)} of the {formatCompactTokens(tally.mintedRaw, decimals)} {symbol} ever minted
          </p>
          <div
            aria-hidden="true"
            className="mt-3 h-2 overflow-hidden rounded-full"
            style={{ background: 'rgba(255,255,255,0.08)' }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${meterWidth}%`,
                minWidth: tally.burntRaw > 0n ? 4 : 0,
                background: 'linear-gradient(90deg, #ff7a18, #ffb347)',
              }}
            />
          </div>
        </div>
        <dl className="m-0">
          <Row label="Burnt" value={whole(tally.burntRaw)} unit={symbol} />
          {ways.length > 1 && ways.map((w) => <Row key={w.label} label={w.label} value={whole(w.raw)} unit={symbol} />)}
          <Row label="Ever minted" value={whole(tally.mintedRaw)} unit={symbol} />
          {uncountedFallRaw !== undefined && uncountedFallRaw > 0n && (
            <Row label="Supply fall, not counted" value={whole(uncountedFallRaw)} unit={symbol} />
          )}
          {notBurnt !== null && <Row label="Not burnt" value={notBurnt} unit={symbol} />}
        </dl>
      </div>

      <p className="text-[11px] text-white/60 mt-3">
        {hasBurnAddress ? (
          <>
            Burnt counts {symbol} {listPhrases(ways.map((w) => w.phrase))}.{' '}
            {uncountedFallRaw !== undefined && (
              <>
                This token has a bridge path that could lower its supply without a burn, so a fall in supply is not
                counted as burnt.{' '}
              </>
            )}
          </>
        ) : (
          <>Burnt is the {symbol} destroyed outright: everything ever minted, less the supply on chain now. </>
        )}
        Read from {CHAIN_LABEL[bungalow.chain]}. The burn is rounded down to whole tokens. Nothing here refreshes on
        its own.
        {proofUrl && proofLabel && (
          <>
            {' '}
            <a
              href={proofUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${proofLabel} (opens in new tab)`}
              className="underline underline-offset-2 text-white/80 hover:text-white"
            >
              {proofLabel} ↗
            </a>
          </>
        )}
      </p>
    </>
  );
}

/** "a", "a and b", "a, b and c". */
function listPhrases(items: string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** One ledger line. A wrapping flex row: on a narrow phone a long figure drops under its label. */
function Row({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div
      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5"
      style={{ borderTop: `1px solid ${HAIR}` }}
    >
      <dt className="min-w-0 text-[11px] uppercase tracking-[0.12em] text-white/60">{label}</dt>
      <dd className="m-0 ml-auto min-w-0 text-right text-[13px] text-white tabular-nums">
        {value} <span className="text-[11px] text-white/55">{unit}</span>
      </dd>
    </div>
  );
}
