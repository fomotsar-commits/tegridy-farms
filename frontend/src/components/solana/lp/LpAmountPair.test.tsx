// The two amount boxes of a liquidity form, and what a comma typed or pasted into one
// is read as. The parse is the panels' own (parseDecimalToBaseUnits), so each assertion
// is about the number a panel would work from.

import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { parseDecimalToBaseUnits } from '../../../lib/launcher/solana/curve/format';
import { LpAmountPair } from './LpAmountPair';

const SOL = 10n ** 9n;
const TOKEN_DECIMALS = 6;

/** The boxes as a panel holds them: each shows the text it was last handed. */
function Boxes() {
  const [boxes, setBoxes] = useState({ sol: '', token: '' });
  return (
    <LpAmountPair
      sol={boxes.sol}
      token={boxes.token}
      driving={null}
      tokenDecimals={TOKEN_DECIMALS}
      linked={false}
      onType={(side, text) => setBoxes((b) => ({ ...b, [side]: text }))}
      onMax={() => {}}
      hints={{ sol: '', token: '' }}
      canMax={{ sol: false, token: false }}
    />
  );
}

const box = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
/** One input event per key, as a keypad sends them. */
const type = (el: HTMLInputElement, keys: string) => {
  for (const k of keys) fireEvent.change(el, { target: { value: el.value + k } });
};
/** The whole text in one input event. */
const paste = (el: HTMLInputElement, text: string) => fireEvent.change(el, { target: { value: text } });
const lamports = (el: HTMLInputElement) => parseDecimalToBaseUnits(el.value, 9);

describe('LpAmountPair: a comma in an amount box', () => {
  it('reads a typed comma as the decimal point, in both boxes', () => {
    // A phone set to a comma-decimal region has "," and no "." on this keypad.
    render(<Boxes />);
    type(box('SOL to add'), '0,5');
    expect(lamports(box('SOL to add'))).toBe(SOL / 2n);
    type(box('Tokens to add'), '12,25');
    expect(parseDecimalToBaseUnits(box('Tokens to add').value, TOKEN_DECIMALS)).toBe(12_250_000n);
  });

  it('reads three decimals typed after a comma as a fraction', () => {
    render(<Boxes />);
    type(box('SOL to add'), '68,066');
    expect(lamports(box('SOL to add'))).toBe(68_066_000_000n);
  });

  it('never reads a pasted thousands separator as a decimal point', () => {
    // The page prints "68,066.397104" and "1,393,591". A paste of one means what it
    // says or is refused: "68,066" is never 68.066 and "1,234.5" is never 1.2345.
    render(<Boxes />);
    const means: Record<string, bigint> = {
      '68,066': 68_066n * SOL,
      '68,066.397104': 68_066_397_104_000n,
      '1,393,591': 1_393_591n * SOL,
      '1,234.5': 1_234_500_000_000n,
    };
    for (const [text, exact] of Object.entries(means)) {
      paste(box('SOL to add'), '');
      paste(box('SOL to add'), text);
      expect([null, exact], text).toContain(lamports(box('SOL to add')));
    }
  });

  it('keeps a refused paste refused while it is edited, until its commas are gone', () => {
    render(<Boxes />);
    const sol = box('SOL to add');
    paste(sol, '1,393,591');
    paste(sol, '1,393591');
    expect(lamports(sol)).toBeNull();
    paste(sol, '1393591');
    expect(lamports(sol)).toBe(1_393_591n * SOL);
  });
});
