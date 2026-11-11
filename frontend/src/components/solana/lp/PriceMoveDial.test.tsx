import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PriceMoveDial } from './PriceMoveDial';
import { priceMovePoint } from '../../../lib/solana/lp/priceMove';
import { FORECAST_WORDS } from '../../../lib/solana/lp/format';

const slider = () => screen.getByRole('slider') as HTMLInputElement;
const text = (id: string) => screen.getByTestId(id).textContent ?? '';
const drag = (stop: number) => fireEvent.change(slider(), { target: { value: String(stop) } });

describe('priceMovePoint: one price on the dial', () => {
  it('at the same price nothing has changed', () => {
    expect(priceMovePoint(1)).toEqual({ vs: 0, price: 'the same', position: 'the same', tokens: 'the same', quote: 'the same' });
  });

  it('at double: about 5.7% less than holding, 29% fewer tokens, 41% more of the pairing coin', () => {
    expect(priceMovePoint(2)).toMatchObject({ price: '2 times', position: 'about 5.7% less', tokens: '29% fewer', quote: '41% more' });
  });

  it('at half the loss is the same as at double, with the sides swapped', () => {
    expect(priceMovePoint(0.5)).toMatchObject({ price: 'half', position: 'about 5.7% less', tokens: '41% more', quote: '29% less' });
  });

  it('at 4 times it is exactly 20% less, and the position holds half the tokens', () => {
    expect(priceMovePoint(4)).toMatchObject({ price: '4 times', position: '20% less', tokens: '50% fewer', quote: '100% more' });
  });

  it('refuses a price that is not a positive number', () => {
    for (const r of [0, -1, NaN, Infinity]) expect(priceMovePoint(r)).toBeNull();
  });
});

describe('the dial on the Add form', () => {
  it('opens at double, the table\'s middle row', () => {
    render(<PriceMoveDial quoteSymbol="SOL" />);
    expect(text('lp-price-dial-headline')).toBe('About 5.7% less than holding');
    expect(text('lp-price-dial-price')).toBe('price: 2 times');
    expect(text('lp-price-dial-mix')).toBe('Your position would hold 29% fewer of this token and 41% more SOL.');
  });

  it('dragged to the same price it says so, in green terms', () => {
    render(<PriceMoveDial quoteSymbol="SOL" />);
    drag(0);
    expect(text('lp-price-dial-headline')).toBe('The same as holding');
    expect(text('lp-price-dial-mix')).toBe('Your position holds what you put in. Drag to move the price.');
  });

  it('dragged to a quarter it names the pool\'s own pairing coin', () => {
    render(<PriceMoveDial quoteSymbol="USDC" />);
    drag(-200);
    expect(text('lp-price-dial-headline')).toBe('20% less than holding');
    expect(text('lp-price-dial-price')).toBe('price: a quarter');
    expect(text('lp-price-dial-mix')).toBe('Your position would hold 100% more of this token and 50% less USDC.');
    expect(slider().getAttribute('aria-valuetext')).toBe('Price a quarter: 20% less than holding');
  });

  it('reaches an eighth and 8 times, and no further', () => {
    render(<PriceMoveDial quoteSymbol="SOL" />);
    expect(slider().min).toBe('-300');
    expect(slider().max).toBe('300');
    drag(300);
    expect(text('lp-price-dial-price')).toBe('price: 8 times');
    expect(text('lp-price-dial-headline')).toBe('About 37.1% less than holding');
  });

  it('never uses a forecast word, at any stop', () => {
    render(<PriceMoveDial quoteSymbol="SOL" />);
    for (let stop = -300; stop <= 300; stop += 25) {
      drag(stop);
      const all = [text('lp-price-dial-headline'), text('lp-price-dial-price'), text('lp-price-dial-mix')].join(' ');
      expect(all).not.toMatch(FORECAST_WORDS);
    }
  });
});
