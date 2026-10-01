import { useId, useState } from 'react';
import { SHADOW, TOGGLE_CLS, inputCls, inputStyle } from '../curve/uiFormat';

/** "All": exactly the balance read at prepare, never a rounded share of it. */
export const ALL_BPS = 10_000n;

/** The presets, in basis points of the shares held. */
const PERCENT_PRESETS: readonly { bps: bigint; label: string }[] = [
  { bps: 2_500n, label: '25%' },
  { bps: 5_000n, label: '50%' },
  { bps: 7_500n, label: '75%' },
  { bps: ALL_BPS, label: 'All' },
];

/** A typed percent, 0.01 to 100 with at most two decimals, in basis points; null when it is not one. */
// eslint-disable-next-line react-refresh/only-export-components
export function parsePercentBps(text: string): bigint | null {
  const t = text.trim();
  if (!/^(?:\d{1,3}(?:\.\d{0,2})?|\.\d{1,2})$/.test(t)) return null;
  const [w = '0', f = ''] = t.split('.');
  const bps = BigInt(w || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return bps >= 1n && bps <= 10_000n ? bps : null;
}

/**
 * "How much to take out": 25%, 50%, 75%, All, or another percent. Nothing is chosen
 * at first, so nothing can be reviewed until the person picks. `onChange` gets the
 * basis points, or null with `bad` when the typed percent is not one this accepts.
 * A fieldset, not a label: a label wrapping buttons forwards a click on its text to the
 * first button, which would silently choose 25%.
 */
export function PercentPicker({
  valueBps,
  onChange,
  disabled,
}: {
  valueBps: bigint | null;
  onChange: (v: { bps: bigint | null; bad: boolean }) => void;
  disabled?: boolean;
}) {
  const [other, setOther] = useState('');
  const id = useId();
  const otherLabel = `${id}-other`;
  // A preset chosen from outside (the dust line's "Take out all of it") clears the box.
  const [seen, setSeen] = useState(valueBps);
  if (seen !== valueBps) {
    setSeen(valueBps);
    if (other !== '' && parsePercentBps(other) !== valueBps) setOther('');
  }
  return (
    <fieldset className="block mb-3 min-w-0">
      <legend className="text-white text-[11px] block mb-1.5" style={SHADOW}>
        How much to take out
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {PERCENT_PRESETS.map((p) => {
          const on = other === '' && valueBps === p.bps;
          return (
            <button
              key={p.label}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => {
                setOther('');
                onChange({ bps: p.bps, bad: false });
              }}
              className={`${TOGGLE_CLS} min-w-[56px] disabled:opacity-50`}
              style={{
                background: on ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                border: on ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <label className="block mt-2">
        <span id={otherLabel} className="text-white text-[11px] block mb-1.5" style={SHADOW}>
          Other percent
        </span>
        <input
          aria-labelledby={otherLabel}
          className={`${inputCls} disabled:opacity-50`}
          style={inputStyle}
          inputMode="decimal"
          placeholder="0.01 to 100"
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          value={other}
          onChange={(e) => {
            const v = e.target.value;
            setOther(v);
            if (v.trim() === '') onChange({ bps: null, bad: false });
            else {
              const bps = parsePercentBps(v);
              onChange({ bps, bad: bps === null });
            }
          }}
        />
      </label>
    </fieldset>
  );
}
