import { decimalCommaToPoint } from '../../../lib/launcher/solana/curve/format';
import { Field } from '../curve/ui';
import { TOGGLE_CLS, inputCls, inputStyle } from '../curve/uiFormat';

export type LpSide = 'sol' | 'token';

/**
 * The two amount boxes of a liquidity form: SOL and the token. With `linked`, the box
 * typed in last drives and the other one shows what the pool asks for it (the parent
 * passes that worked-out text as the other side's value); typing in the other box makes
 * it drive. Unlinked (opening a pool later), both sides are typed on their own.
 *
 * Every box is 16px (no zoom on a phone), decimal-keyboard, no spellcheck or autofill.
 * A typed comma becomes the decimal point (some phone keypads have no "."); a pasted
 * "68,066" is left as it is for the parent to refuse (decimalCommaToPoint).
 * Its visible label is its accessible name; the hint and any error are read with it.
 * A side whose balance could not be read gets no Max: an unread balance is never 0.
 */
export function LpAmountPair({
  sol,
  token,
  driving,
  tokenDecimals,
  linked,
  onType,
  onMax,
  disabled,
  hints,
  errors,
  canMax,
  labels = { sol: 'SOL to add', token: 'Tokens to add' },
}: {
  sol: string;
  token: string;
  driving: LpSide | null;
  tokenDecimals: number | null;
  linked: boolean;
  onType: (side: LpSide, text: string) => void;
  onMax: (side: LpSide) => void;
  disabled?: boolean;
  hints: { sol: string; token: string };
  errors?: { sol?: string | null; token?: string | null };
  /** Max is offered only for a side whose balance was read. */
  canMax: { sol: boolean; token: boolean };
  /** The visible labels (and so the boxes' names). Opening a pool says "to put in". */
  labels?: { sol: string; token: string };
}) {
  const box = (side: LpSide) => {
    const label = side === 'sol' ? labels.sol : tokenDecimals === null ? `${labels.token} (base units)` : labels.token;
    const value = side === 'sol' ? sol : token;
    return (
      <Field key={side} label={label} hint={hints[side]} error={errors?.[side] ?? null}>
        {(a11y) => (
          <div className="flex gap-1.5 items-stretch">
            <input
              {...a11y}
              className={`${inputCls} flex-1 min-w-0 disabled:opacity-50`}
              style={inputStyle}
              value={value}
              onChange={(e) => onType(side, decimalCommaToPoint(e.target.value, value))}
              placeholder="0.0"
              inputMode="decimal"
              spellCheck={false}
              autoComplete="off"
              disabled={disabled}
              data-driving={linked ? String(driving === side) : undefined}
            />
            {canMax[side] && (
              <button
                type="button"
                className={`${TOGGLE_CLS} !flex-none min-w-[56px] px-3 disabled:opacity-50`}
                style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.12)' }}
                aria-label={side === 'sol' ? 'Max SOL' : 'Max tokens'}
                onClick={() => onMax(side)}
                disabled={disabled}
              >
                Max
              </button>
            )}
          </div>
        )}
      </Field>
    );
  };
  return (
    <div data-testid="lp-amount-pair">
      {box('sol')}
      {box('token')}
    </div>
  );
}
