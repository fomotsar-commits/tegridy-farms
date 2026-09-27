import { CurveChart } from '../../launcher/CurveChart';
import {
  curveProgress,
  describeReserveRecipient,
  formatSol,
  formatTokenAmount,
  raiseCeiling,
  spotPriceLabel,
  type BondingCurve,
  type LaunchPhase,
  type TreasuryDescription,
} from '../../../lib/launcher/solana/curve';
import { Card, Row } from './ui';
import { feeSplitLabel } from './uiFormat';

// The curve's state as read from chain: phase, reserves, progress, terms. Moved
// here from CurveLaunchPage so the per-launch page draws the same card. The words
// and the numbers are unchanged.

const PHASE_COPY: Record<LaunchPhase['kind'], { label: string; line: string }> = {
  'not-deployed': { label: 'Not deployed', line: 'The program does not exist on chain.' },
  'not-a-program': {
    label: 'Not a program',
    line: 'Something occupies the program address but is not executable. Nothing has been deployed, so there is nothing to look up.',
  },
  closed: {
    label: 'Program closed',
    line: 'The program that ran at this address has been closed and its bytecode deleted. Any launch it held is unreachable — not empty, unreachable.',
  },
  unreadable: { label: "Couldn't read", line: 'A read failed. This is not a statement about the launch.' },
  'protocol-not-initialized': {
    label: 'Protocol not initialised',
    line: 'The program exists but has not been set up yet. Not a problem with this token.',
  },
  'pre-launch': {
    label: 'No curve for this mint',
    line: 'Nothing has been launched on this mint. That is different from a launch that has raised nothing.',
  },
  trading: { label: 'Bonding', line: 'Buys and sells both run against the curve.' },
  'at-target': {
    label: 'At target, still raising the migration reserve',
    line: 'The graduation target is met but the reserve that pays for migration is not yet full. Buys and sells both still work.',
  },
  'awaiting-migration': {
    label: 'Fully funded — awaiting migration',
    line: 'Buys are finished. Selling still works, and anyone may call migration. It has NOT graduated yet.',
  },
  graduated: { label: 'Graduated', line: 'Liquidity has moved to the AMM pool. The curve is closed; trade the pool instead.' },
};

export function CurveStateCard({
  phase,
  curve,
  decimals,
  paused,
  lookedUp,
  treasury = describeReserveRecipient(null),
}: {
  phase: LaunchPhase;
  /** `null` whenever no `BondingCurve` was established — see `phase` for why. */
  curve: BondingCurve | null;
  decimals: number | null;
  paused: boolean | null;
  /** False means no lookup has been attempted — which is NOT a failed read. */
  lookedUp: boolean;
  /**
   * Who received the reserve, from the launch’s own create transaction
   * (describeReserveRecipient), never today’s config. "Multisig" only for the known vault.
   */
  treasury?: TreasuryDescription;
}) {
  const p = PHASE_COPY[phase.kind];
  return (
    <Card title="Curve state">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-white/90 text-[12px] font-medium">{p.label}</span>
        {paused === true && (
          <span className="inline-block px-2 py-0.5 rounded-full text-[9px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
            BUYS PAUSED · SELLS OPEN
          </span>
        )}
      </div>
      <p>{p.line}</p>
      {phase.kind === 'unreadable' && <p className="text-amber-300/90 break-all">{phase.detail}</p>}

      {curve ? (
        <CurveNumbers curve={curve} decimals={decimals} treasury={treasury} />
      ) : (
        <p className="text-white/40">
          {!lookedUp
            ? // Nothing has been looked up. Saying "the read failed" here would be
              // a claim about a call that was never made.
              'No launch has been looked up yet.'
            : phase.kind === 'pre-launch'
              ? 'No curve account, so there are no reserves to show. Deliberately blank rather than zeroed.'
              : 'Curve reserves are unavailable because the read failed.'}
        </p>
      )}
    </Card>
  );
}

function CurveNumbers({
  curve,
  decimals,
  treasury,
}: {
  curve: BondingCurve;
  decimals: number | null;
  treasury: TreasuryDescription;
}) {
  const ceiling = raiseCeiling(curve);
  // One derivation of progress and spot, from the core. `null` here means the
  // curve's own terms overflow a u64 — an arithmetic refusal, not a zero.
  const p = curveProgress(curve);
  const sold = formatTokenAmount(curve.realTokenReserves, decimals);
  const reserve = formatTokenAmount(curve.platformReserveTokens, decimals);
  // The program pays the reserve inside create_launch and sets this flag there, so a
  // curve it created always reads true. The other branch says what the account says
  // rather than claiming a payment it does not record. "A multisig" only when the
  // launch’s own create transaction names the known Squads vault (describeReserveRecipient).
  const reserveStatus = curve.platformReserveReleased
    ? `paid when this token was created, to ${treasury.name}`
    : 'this curve account does not record it as paid';
  const split = feeSplitLabel(curve.creatorFeeShareBps);
  // Spot is an exact numerator/denominator pair so nothing is rounded on the way
  // out. `spotPriceLabel` decides the UNIT, and refuses to assume 9 decimals.
  const spot =
    p?.spot == null
      ? null
      : spotPriceLabel(Number(p.spot.numerator) / Number(p.spot.denominator), decimals);
  const progress = p?.progressBps == null ? null : p.progressBps / 10_000;

  if (curve.complete) {
    // Graduation empties the curve's real reserves (lib.rs migrate_to_amm), so its
    // progress, "SOL raised", tokens left and spot would all read as a confident 0 or
    // a stale virtual price next to the live pool. Show the terms only.
    return (
      <div className="space-y-2 pt-1" data-testid="curve-closed">
        <p className="text-white/70">
          The curve closed at graduation. Its reserves moved to the pool, so the price is the pool&apos;s, not the
          curve&apos;s.
        </p>
        <Row label="Graduation target" value={`${formatSol(curve.graduationTargetLamports)} SOL`} />
        <Row label="Trade fee (on the curve)" value={`${(Number(curve.tradeFeeBps) / 100).toFixed(2)}%`} />
        <Row label="Fee split (on the curve)" value={split ?? '—'} mono={false} />
        <Row
          label={`Platform reserve${reserve.isBaseUnits ? ' (base units)' : ''}`}
          value={curve.platformReserveTokens === 0n ? 'none' : reserve.text}
        />
        {curve.platformReserveTokens > 0n && (
          <p className="text-white/40 text-[10px]">
            Platform reserve: {reserveStatus}. It was never part of what the curve sells, and it never goes into the
            pool.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2 pt-1">
      {/* The curve is a function of the state we just decoded, so it is shown only here —
          where a real `curve` account is in hand. `source: 'chain'` is a claim the chart
          cannot verify for itself, so it must never be passed for a synthesised snapshot. */}
      <CurveChart
        state={{ status: 'ready', curve, source: { kind: 'chain' } }}
        tokenDecimals={decimals ?? undefined}
        className="mb-3"
      />
      <div>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span className="text-white/60">Raised toward graduation</span>
          <span className="font-mono text-white/80">
            {progress === null ? '—' : `${(progress * 100).toFixed(2)}%`}
          </span>
        </div>
        {progress === null ? (
          <p className="text-amber-300/90 text-[10px]">
            Progress could not be computed from this curve&apos;s own terms, so none is shown. That is a refusal, not
            0%.
          </p>
        ) : (
          <>
            <div
              className="h-1.5 rounded-full overflow-hidden bg-white/10"
              role="progressbar"
              aria-valuenow={Math.round(progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-full bg-[var(--color-stan)]" style={{ width: `${Math.min(100, progress * 100)}%` }} />
            </div>
            <p className="text-white/40 text-[10px] mt-1">
              {formatSol(curve.realSolReserves)} of {ceiling.ok ? formatSol(ceiling.value) : '—'} SOL. Buying stops there:
              the graduation target plus a small amount that pays for opening the pool.
            </p>
          </>
        )}
      </div>

      <Row label="SOL raised (curve reserves)" value={`${formatSol(curve.realSolReserves)} SOL`} />
      <Row label="Graduation target" value={`${formatSol(curve.graduationTargetLamports)} SOL`} />
      <Row label="Migration reserve" value={`${formatSol(curve.migrationReserveLamports)} SOL`} />
      <Row label="Trade fee (this launch)" value={`${(Number(curve.tradeFeeBps) / 100).toFixed(2)}%`} />
      <Row label="Fee split (this launch)" value={split ?? '—'} mono={false} />
      <Row label={`Tokens still on the curve${sold.isBaseUnits ? ' (base units)' : ''}`} value={sold.text} />
      <Row
        label={`Platform reserve${reserve.isBaseUnits ? ' (base units)' : ''}`}
        value={curve.platformReserveTokens === 0n ? 'none' : reserve.text}
      />
      {curve.platformReserveTokens > 0n && (
        <p className="text-white/40 text-[10px]">
          Platform reserve: {reserveStatus}. It was never part of what the curve sells, and it never goes into the
          pool.
        </p>
      )}
      <Row label="Spot price" value={spot === null ? '—' : `${spot.value} ${spot.unit}`} />
      <p className="text-white/35 text-[10px] leading-relaxed">
        This is the price right now. Any trade moves it, so the review shows what you actually get. There is no market
        cap, volume or holder count here: the program does not record them.
      </p>
    </div>
  );
}
