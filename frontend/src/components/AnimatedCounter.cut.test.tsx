// The counter draws claimable rewards and balances: what it prints is cut at its decimals,
// never rounded up past the amount. A price, rate or multiplier asks for `nearest` instead.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AnimatedCounter } from './AnimatedCounter';

const shown = (value: number, decimals: number) => render(<AnimatedCounter value={value} decimals={decimals} />).container.textContent;

describe('AnimatedCounter cuts at its decimals', () => {
  it('never prints above the value it is given', () => {
    expect(shown(1284.5, 0)).toBe('1,284');
    expect(shown(999.999, 2)).toBe('999.99');
    expect(shown(12.345678, 4)).toBe('12.3456');
    expect(shown(0.009999999, 2)).toBe('0.00999999');
  });

  it('keeps an amount binary cannot hold exactly', () => {
    expect(shown(0.29, 2)).toBe('0.29');
    expect(shown(0.1 + 0.2, 4)).toBe('0.3000');
    expect(shown(1_234_567.891, 2)).toBe('1,234,567.89');
    expect(shown(0, 2)).toBe('0.00');
  });
});

describe('AnimatedCounter with `nearest` rounds to the nearest digit', () => {
  const near = (value: number, decimals: number) =>
    render(<AnimatedCounter value={value} decimals={decimals} nearest />).container.textContent;

  it('as toFixed does, with the whole part grouped', () => {
    expect(near(3.996, 2)).toBe('4.00');
    expect(near(2.554, 2)).toBe('2.55');
    expect(near(1284.5, 0)).toBe('1,285');
    expect(near(1_234_567.896, 2)).toBe('1,234,567.90');
  });
});
