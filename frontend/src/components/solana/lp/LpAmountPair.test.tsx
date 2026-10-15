// The two amount boxes of a liquidity form, and what a comma typed or pasted into one
// is read as. The parse is the panels' own (parseDecimalToBaseUnits), so each assertion
// is about the number a panel would work from.
//
// The first box is the pool's pairing coin (SOL, USDC or BAYLA: quotes.ts) and is named
// after it. For SOL every word is what it was before the coin was a prop.

import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { parseDecimalToBaseUnits } from '../../../lib/launcher/solana/curve/format';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import { LpAmountPair, type LpSide } from './LpAmountPair';

const SOL = 10n ** 9n;
const TOKEN_DECIMALS = 6;

/** The boxes as a panel holds them: each shows the text it was last handed. */
function Boxes({ coin = SOL_QUOTE }: { coin?: QuoteCoin }) {
  const [boxes, setBoxes] = useState({ quote: '', token: '' });
  return (
    <LpAmountPair
      coin={coin}
      quote={boxes.quote}
      token={boxes.token}
      driving={null}
      tokenDecimals={TOKEN_DECIMALS}
      linked={false}
      onType={(side, text) => setBoxes((b) => ({ ...b, [side]: text }))}
      onMax={() => {}}
      hints={{ quote: '', token: '' }}
      canMax={{ quote: false, token: false }}
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

  it('reads a typed comma as the decimal point in a USDC box too', () => {
    render(<Boxes coin={USDC_QUOTE} />);
    type(box('USDC to add'), '12,5');
    expect(parseDecimalToBaseUnits(box('USDC to add').value, USDC_QUOTE.decimals)).toBe(12_500_000n);
  });
});

// ── the pairing coin names its box and its Max button ───────────────────────────

/** Both Max buttons shown, and every callback recorded. */
function mountPair(coin: QuoteCoin, over: Partial<Parameters<typeof LpAmountPair>[0]> = {}) {
  const onType = vi.fn<(side: LpSide, text: string) => void>();
  const onMax = vi.fn<(side: LpSide) => void>();
  render(
    <LpAmountPair
      coin={coin}
      quote="1"
      token="2"
      driving="quote"
      tokenDecimals={TOKEN_DECIMALS}
      linked
      onType={onType}
      onMax={onMax}
      hints={{ quote: 'the coin hint', token: 'the token hint' }}
      errors={{ quote: 'the coin error', token: null }}
      canMax={{ quote: true, token: true }}
      {...over}
    />,
  );
  const pair = screen.getByTestId('lp-amount-pair');
  const inputs = within(pair).getAllByRole('textbox') as HTMLInputElement[];
  const buttons = within(pair).getAllByRole('button');
  return { onType, onMax, pair, inputs, buttons };
}

describe('LpAmountPair: the coin’s box is named after the pool’s pairing coin', () => {
  it.each([['USDC', USDC_QUOTE], ['BAYLA', BAYLA_QUOTE]] as const)('%s: its box, its Max button, and nothing says SOL', (symbol, coin) => {
    const { pair, inputs, buttons } = mountPair(coin);
    // The coin first, then the token.
    expect(inputs).toEqual([box(`${symbol} to add`), box('Tokens to add')]);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([`Max ${symbol}`, 'Max tokens']);
    expect(pair.textContent).not.toMatch(/SOL/);
    expect(screen.queryByLabelText('SOL to add')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Max SOL' })).toBeNull();
  });

  it('SOL: the labels and the Max names are the ones the forms have always had', () => {
    const { inputs, buttons } = mountPair(SOL_QUOTE);
    expect(inputs).toEqual([box('SOL to add'), box('Tokens to add')]);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Max SOL', 'Max tokens']);
    expect(buttons.map((b) => b.textContent)).toEqual(['Max', 'Max']);
  });

  it('labels given by the form win over the default, and a token with unread decimals says "base units"', () => {
    mountPair(USDC_QUOTE, { labels: { quote: 'USDC to put in', token: 'Tokens to put in' }, tokenDecimals: null });
    expect(box('USDC to put in').value).toBe('1');
    expect(box('Tokens to put in (base units)').value).toBe('2');
    // The Max button is still named after the coin, whatever the box is labelled.
    expect(screen.getByRole('button', { name: 'Max USDC' })).toBeInTheDocument();
  });

  it.each([['SOL', SOL_QUOTE], ['USDC', USDC_QUOTE]] as const)('%s: typing and Max report the side as "quote" or "token", each box carries its own hint and error', (symbol, coin) => {
    const { onType, onMax, inputs } = mountPair(coin);
    fireEvent.change(box(`${symbol} to add`), { target: { value: '15' } });
    fireEvent.change(box('Tokens to add'), { target: { value: '25' } });
    expect(onType.mock.calls).toEqual([['quote', '15'], ['token', '25']]);
    fireEvent.click(screen.getByRole('button', { name: `Max ${symbol}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Max tokens' }));
    expect(onMax.mock.calls).toEqual([['quote'], ['token']]);
    // `quote` is the coin's box: its text, its hint, its error and the driving mark.
    const [coinBox, tokenBox] = inputs;
    expect([coinBox!.value, tokenBox!.value]).toEqual(['1', '2']);
    expect(coinBox).toHaveAccessibleDescription('the coin error the coin hint');
    expect(tokenBox).toHaveAccessibleDescription('the token hint');
    expect(coinBox).toHaveAttribute('aria-invalid', 'true');
    expect(tokenBox).not.toHaveAttribute('aria-invalid');
    expect([coinBox!.dataset.driving, tokenBox!.dataset.driving]).toEqual(['true', 'false']);
  });

  it('a side whose balance was not read gets no Max', () => {
    const { buttons } = mountPair(USDC_QUOTE, { canMax: { quote: false, token: true } });
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Max tokens']);
  });
});
