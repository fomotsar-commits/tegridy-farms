// Shared presentation for the /curve-launch pages. No I/O, no Solana imports
// beyond types, so every panel and both pages draw the same cards and rows.

import { useState, type ReactNode } from 'react';
import {
  CARD,
  CARD_STYLE,
  DEFAULT_SLIPPAGE_BPS,
  SHADOW,
  SLIPPAGE_PRESETS_BPS,
  WARN_SLIPPAGE_BPS,
  inputCls,
  inputStyle,
  parseSlippagePercent,
} from './uiFormat';

export function Card({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className={CARD} style={CARD_STYLE} data-testid={testId}>
      <h2 className="text-white font-semibold text-[13px] mb-2.5" style={SHADOW}>
        {title}
      </h2>
      <div className="text-white/60 text-[11px] leading-relaxed space-y-2">{children}</div>
    </section>
  );
}

/**
 * Label/value row. Both sides wrap rather than truncate: the cards are
 * `overflow-hidden`, so a clipped value would silently disappear, and a
 * truncated base58 address reads like a different address.
 */
export function Row({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-white/75">
      <span className="break-words">{label}</span>
      <span className={`text-right break-all min-w-0 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block mb-3">
      <span className="text-white text-[11px] block mb-1.5" style={SHADOW}>
        {label}
      </span>
      {children}
      {hint && <span className="text-white/40 text-[10px] block mt-1">{hint}</span>}
    </label>
  );
}

/** A plain notice line. `tone` picks the colour only; the words carry the meaning. */
export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad' | 'good'; children: ReactNode }) {
  const cls =
    tone === 'warn'
      ? 'text-amber-300/90'
      : tone === 'bad'
        ? 'text-rose-300/90'
        : tone === 'good'
          ? 'text-emerald-300/90'
          : 'text-white/55';
  return <p className={cls}>{children}</p>;
}

export function SlippagePicker({
  valueBps,
  onChange,
  disabled,
}: {
  valueBps: bigint | null;
  onChange: (bps: bigint | null) => void;
  disabled?: boolean;
}) {
  // The typed value is local so a preset click can clear it; the parent only ever
  // sees bps, or null for a value the picker will not honour.
  const [other, setOther] = useState('');
  return (
    // A fieldset, not a <label>: a label wrapping buttons forwards a click on its
    // text to the first button, which would silently change the tolerance.
    <fieldset className="block mb-3 min-w-0">
      <legend className="text-white text-[11px] block mb-1.5" style={SHADOW}>
        Price tolerance (slippage)
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {SLIPPAGE_PRESETS_BPS.map((bps) => (
          <button
            key={bps.toString()}
            type="button"
            onClick={() => {
              setOther('');
              onChange(bps);
            }}
            aria-pressed={other === '' && valueBps === bps}
            disabled={disabled}
            className="flex-1 min-w-[56px] py-1.5 rounded-lg text-[12px] text-white transition-colors disabled:opacity-50"
            style={{
              background: other === '' && valueBps === bps ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
              border: other === '' && valueBps === bps ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
            }}
          >
            {(Number(bps) / 100).toString()}%
          </button>
        ))}
        <input
          className={`${inputCls} flex-1 min-w-[72px] !w-auto disabled:opacity-50`}
          style={inputStyle}
          inputMode="decimal"
          placeholder="Other %"
          aria-label="Other slippage percent"
          disabled={disabled}
          value={other}
          onChange={(e) => {
            const v = e.target.value;
            setOther(v);
            onChange(v.trim() === '' ? DEFAULT_SLIPPAGE_BPS : parseSlippagePercent(v));
          }}
        />
      </div>
      <span className="text-white/40 text-[10px] block mt-1">
        If the price moves more than this before your trade lands, the trade is refused and only the network fee is spent.
      </span>
      {valueBps === null && (
        <span className="text-rose-300/90 text-[10px] block mt-1">Enter a tolerance above 0% and at most 5%.</span>
      )}
      {valueBps !== null && valueBps > WARN_SLIPPAGE_BPS && (
        <span className="text-amber-300/90 text-[10px] block mt-1">
          A tolerance above 3% lets a bot trade in front of you and keep the difference. Use it only if smaller ones keep being refused.
        </span>
      )}
    </fieldset>
  );
}
