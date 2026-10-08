// Shared presentation for the /curve-launch pages. No I/O, no Solana imports
// beyond types and one pure text helper (decimalCommaToPoint), so every panel and
// both pages draw the same cards and rows.

import { useId, useState, type ReactNode, type Ref } from 'react';
import { decimalCommaToPoint } from '../../../lib/launcher/solana/curve/format';
import {
  CARD,
  CARD_STYLE,
  DEFAULT_SLIPPAGE_BPS,
  SHADOW,
  SLIPPAGE_PRESETS_BPS,
  TOGGLE_CLS,
  WARN_SLIPPAGE_BPS,
  impactText,
  impactWarning,
  inputCls,
  inputStyle,
  parseSlippagePercent,
} from './uiFormat';

export function Card({
  title,
  children,
  testId,
  headingRef,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
  /** Set when focus may be sent to the heading (a flow ending with no button to return to). */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <section className={CARD} style={CARD_STYLE} data-testid={testId}>
      <h2
        ref={headingRef}
        tabIndex={headingRef ? -1 : undefined}
        className="text-white font-semibold text-[13px] mb-2.5 outline-none"
        style={SHADOW}
      >
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
 *
 * Only a mono value (an address, a signature) may break between any two
 * characters. Words in a sentence break only at spaces, or mid-word only when
 * one word alone is wider than the card, so a phone never reads "Blocked unt/il".
 */
/**
 * `words`: a mono value that is an address FOLLOWED BY a sentence ("<address> (opened for
 * you; its deposit of 0.00203928 SOL stays in that account)"). It breaks between words
 * first and inside one only when it cannot fit, so the address still wraps and the amount
 * is never split in the middle of a number (review of the phone fixes, 2026-10-04).
 */
export function Row({ label, value, mono = true, words = false }: { label: string; value: string; mono?: boolean; words?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-white/75">
      <span className="break-words">{label}</span>
      <span className={`text-right min-w-0 ${mono ? (words ? 'font-mono [overflow-wrap:anywhere]' : 'font-mono break-all') : '[overflow-wrap:anywhere]'}`}>{value}</span>
    </div>
  );
}

/** What a field's control needs so a screen reader hears its name, its hint and its error. */
export interface FieldA11y {
  'aria-labelledby': string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

/**
 * A labelled control with an optional hint and error. Pass `children` as a function
 * to get the ids to spread on the control. Its name is then EXACTLY the visible label
 * (aria-labelledby), so voice control reaches it by saying what is on screen (WCAG
 * 2.5.3), and the hint and error are read out with it (aria-describedby), not as
 * part of its name. Do not give such a control an aria-label of its own: the visible
 * label is its name.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  /** Shown under the control, and read out with it. */
  error?: string | null;
  children: ReactNode | ((a11y: FieldA11y) => ReactNode);
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ');
  const a11y: FieldA11y = {
    'aria-labelledby': labelId,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(error ? { 'aria-invalid': true as const } : {}),
  };
  return (
    <label className="block mb-3">
      <span id={labelId} className="text-white text-[11px] block mb-1.5" style={SHADOW}>
        {label}
      </span>
      {typeof children === 'function' ? children(a11y) : children}
      {error && (
        <span id={errorId} className="text-rose-300/90 text-[10px] block mt-1">
          {error}
        </span>
      )}
      {hint && (
        <span id={hintId} className="text-white/40 text-[10px] block mt-1">
          {hint}
        </span>
      )}
    </label>
  );
}

/**
 * The link to a transaction on the explorer, under its signature. It is one 17.875px line
 * of small text with a finger-sized press area around it: 14px of padding above and below
 * (46px in all), taken back by the same negative margin, so nothing around it moves. The
 * button under it is drawn later, so where the two overlap a press is the button's.
 * The keyboard's ring goes round the words (`ring-on-words`, index.css): round the area
 * its bottom edge was hidden behind that button and its top edge struck through the row above.
 */
export function ExplorerLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-block py-3.5 -my-3.5 underline text-white/80 ring-on-words">
      <span className="ring-words">View on the explorer</span>
    </a>
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
  // A 44-character address has no place to break: without this it ran off the right edge
  // of a phone and lost its last characters (phone walk, 2026-10-03).
  return <p className={`${cls} [overflow-wrap:anywhere]`}>{children}</p>;
}

/** The price impact row, and its warning when it is large or could not be computed. Form and review alike. */
export function ImpactRows({ bps, label = 'Price impact' }: { bps: bigint | null; label?: string }) {
  const w = impactWarning(bps);
  return (
    <>
      <Row label={label} value={impactText(bps)} mono={bps !== null} />
      {w && <Notice tone={w.tone}>{w.text}</Notice>}
    </>
  );
}

/** The picker's hint unless a caller says what a refusal means for its own transaction. */
const SLIPPAGE_HINT =
  'If the price moves more than this before your trade lands, the trade is refused and only the fees are spent (the network fee and any priority fee).';

export function SlippagePicker({
  valueBps,
  onChange,
  disabled,
  hint = SLIPPAGE_HINT,
}: {
  valueBps: bigint | null;
  onChange: (bps: bigint | null) => void;
  disabled?: boolean;
  /** What a refusal costs for this kind of transaction. Defaults to the trade's own words. */
  hint?: string;
}) {
  // The typed value is local so a preset click can clear it; the parent only ever
  // sees bps, or null for a value the picker will not honour.
  const [other, setOther] = useState('');
  // The hint, the error and the warning are tied to the typed input like any Field's,
  // and the error and warning are read out when they appear.
  const id = useId();
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;
  const bad = valueBps === null;
  const risky = valueBps !== null && valueBps > WARN_SLIPPAGE_BPS;
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
            className={`${TOGGLE_CLS} min-w-[56px] disabled:opacity-50`}
            style={{
              background: other === '' && valueBps === bps ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
              border: other === '' && valueBps === bps ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
            }}
          >
            {(Number(bps) / 100).toString()}%
          </button>
        ))}
        <input
          className={`${inputCls} flex-1 min-w-[96px] !w-auto disabled:opacity-50`}
          style={inputStyle}
          inputMode="decimal"
          placeholder="Other %"
          aria-label="Other slippage percent"
          aria-describedby={`${problemId} ${hintId}`}
          aria-invalid={bad || undefined}
          disabled={disabled}
          value={other}
          onChange={(e) => {
            // A comma typed on a phone keypad with no "." is the decimal point.
            const v = decimalCommaToPoint(e.target.value, other);
            setOther(v);
            onChange(v.trim() === '' ? DEFAULT_SLIPPAGE_BPS : parseSlippagePercent(v));
          }}
        />
      </div>
      <span id={hintId} className="text-white/40 text-[10px] block mt-1">
        {hint}
      </span>
      {/* Always there (empty when there is nothing to say), so what appears in them is read out. */}
      <span id={problemId}>
        <span role="alert" className="text-rose-300/90 text-[10px] block mt-1 empty:mt-0">
          {bad ? 'Enter a tolerance above 0% and at most 5%.' : ''}
        </span>
        <span role="status" className="text-amber-300/90 text-[10px] block mt-1 empty:mt-0">
          {risky
            ? 'A tolerance above 3% lets a bot trade in front of you and keep the difference. Use it only if smaller ones keep being refused.'
            : ''}
        </span>
      </span>
    </fieldset>
  );
}
