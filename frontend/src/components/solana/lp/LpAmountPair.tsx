import type { ReactNode } from 'react';
import { decimalCommaToPoint } from '../../../lib/launcher/solana/curve/format';
import type { QuoteCoin } from '../../../lib/solana/lp/quotes';
import { Field } from '../curve/ui';
import { TOGGLE_CLS, inputCls, inputStyle } from '../curve/uiFormat';

/** The pairing coin's box (SOL, USDC or BAYLA: quotes.ts) and the token's. */
export type LpSide = 'quote' | 'token';

/**
 * The two amount boxes of a liquidity form: the pool's pairing coin (`coin`) and the
 * token. With `linked`, the box typed in last drives and the other one shows what the
 * pool asks for it (the parent passes that worked-out text as the other side's value);
 * typing in the other box makes it drive. Unlinked (opening a pool later), both sides are
 * typed on their own.
 *
 * The coin's box and its Max button are named after the coin ("SOL to add", "Max SOL";
 * "USDC to add", "Max USDC"), so a person always reads which coin a number is in.
 *
 * Every box is 16px (no zoom on a phone), decimal-keyboard, no spellcheck or autofill.
 * A typed comma becomes the decimal point (some phone keypads have no "."); a pasted
 * "68,066" is left as it is for the parent to refuse (decimalCommaToPoint).
 * Its visible label is its accessible name; the hint and any error are read with it.
 * A side whose balance could not be read gets no Max: an unread balance is never 0.
 */
export function LpAmountPair({
  coin,
  quote,
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
  labels = { quote: `${coin.symbol} to add`, token: 'Tokens to add' },
  extra,
}: {
  /** The pool's pairing coin: it names the coin's box and its Max button. */
  coin: QuoteCoin;
  /** The coin box's text. */
  quote: string;
  token: string;
  driving: LpSide | null;
  tokenDecimals: number | null;
  linked: boolean;
  onType: (side: LpSide, text: string) => void;
  onMax: (side: LpSide) => void;
  disabled?: boolean;
  hints: { quote: string; token: string };
  errors?: { quote?: string | null; token?: string | null };
  /** Max is offered only for a side whose balance was read. */
  canMax: { quote: boolean; token: boolean };
  /** The visible labels (and so the boxes' names). Opening a pool says "to put in". */
  labels?: { quote: string; token: string };
  /** What goes with a box, outside its label: under it on a phone, beside it on a wider screen (Add: the parts of what that side can put in). */
  extra?: { quote?: ReactNode; token?: ReactNode };
}) {
  const box = (side: LpSide) => {
    const label = side === 'quote' ? labels.quote : tokenDecimals === null ? `${labels.token} (base units)` : labels.token;
    const value = side === 'quote' ? quote : token;
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
                aria-label={side === 'quote' ? `Max ${coin.symbol}` : 'Max tokens'}
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
  // Beside its box where there is room, so it adds no height there; under it on a phone.
  // In the row the box's bottom margin is taken back and given to the row itself: kept
  // inside, it could not fold into the gap below and the form grew 12px (measured).
  const row = (side: LpSide) =>
    extra?.[side] ? (
      <div key={side} className="sm:flex sm:items-start sm:gap-3 sm:mb-3">
        <div className="sm:flex-1 sm:min-w-0 sm:-mb-3">{box(side)}</div>
        {extra[side]}
      </div>
    ) : (
      box(side)
    );
  return (
    <div data-testid="lp-amount-pair">
      {row('quote')}
      {row('token')}
    </div>
  );
}
