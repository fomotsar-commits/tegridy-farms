import type { ReactNode } from 'react';

/**
 * The renderer for "we did not get an answer".
 *
 * It exists so that no surface on these rails has to reach for `?? 0`. A zero drawn
 * where a read failed is indistinguishable from a real zero, and on a lock or vesting
 * panel that mistake reads as a claim about the token: "nothing is locked" instead of
 * "we could not check". `LaunchLockView` goes to the trouble of returning explicit
 * availability flags for exactly this reason; throwing them away at the render layer
 * would waste the contract's care.
 */

/** Inline replacement for a value that was not read. Never styled to look like data. */
export function NoData({ label }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-white/5 text-white/45 border border-white/10"
      title={label ?? 'This value was not read — it is unknown, not zero.'}
    >
      No data
    </span>
  );
}

/**
 * A value, or `NoData` when it is absent.
 *
 * `value` is nullable on purpose and the null branch is not overridable: a caller
 * cannot pass a fallback number through this component.
 */
export function Value({ value, suffix }: { value: ReactNode | null | undefined; suffix?: string }) {
  if (value === null || value === undefined) return <NoData />;
  return (
    <span className="text-white/85 tabular-nums">
      {value}
      {suffix ? <span className="text-white/45 ml-1">{suffix}</span> : null}
    </span>
  );
}

/** Panel-level banner for a rail that answered nothing at all. */
export function UnavailableNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
      <p className="text-amber-200/90 text-[13px] font-semibold">{title}</p>
      <p className="text-white/55 text-[12px] mt-1 leading-relaxed">{detail}</p>
    </div>
  );
}
