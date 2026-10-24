// "Other %" on the price tolerance picker (Add, Remove, curve trade, pool swap), and
// what a comma typed or pasted into it is read as.

import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SlippagePicker } from './ui';
import { DEFAULT_SLIPPAGE_BPS } from './uiFormat';

/** The picker as a panel holds it; `told` gets what the panel is told. */
function Picker({ told }: { told: (bps: bigint | null) => void }) {
  const [bps, setBps] = useState<bigint | null>(DEFAULT_SLIPPAGE_BPS);
  return (
    <SlippagePicker
      valueBps={bps}
      onChange={(v) => {
        told(v);
        setBps(v);
      }}
    />
  );
}

function setup() {
  const told = vi.fn<(bps: bigint | null) => void>();
  render(<Picker told={told} />);
  return { told, other: screen.getByLabelText('Other slippage percent') as HTMLInputElement };
}
/** One input event per key, as a keypad sends them. */
const type = (el: HTMLInputElement, keys: string) => {
  for (const k of keys) fireEvent.change(el, { target: { value: el.value + k } });
};

describe('SlippagePicker: a comma in "Other %"', () => {
  it('reads a typed comma as the decimal point, and the box shows the point', () => {
    // A phone set to a comma-decimal region has "," and no "." on this keypad.
    const { told, other } = setup();
    type(other, '0,3');
    expect(told).toHaveBeenLastCalledWith(30n);
    expect(other).toHaveValue('0.3');
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('never re-reads a comma already in the box, so editing a refused paste cannot make it a tolerance', () => {
    // "1,234" pasted is refused. With its last digit deleted it is still not 1.23%.
    const { told, other } = setup();
    fireEvent.change(other, { target: { value: '1,234' } });
    expect(told).toHaveBeenLastCalledWith(null);
    fireEvent.change(other, { target: { value: '1,23' } });
    expect(told).toHaveBeenCalledTimes(2);
    expect(told).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a tolerance above 0% and at most 5%.');
  });
});
