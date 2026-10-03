// "Other percent" on Remove liquidity, and what a comma typed or pasted into it is read as.

import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PercentPicker } from './PercentPicker';

type Picked = { bps: bigint | null; bad: boolean };

/** The picker as the Remove panel holds it; `told` gets what the panel is told. */
function Picker({ told }: { told: (v: Picked) => void }) {
  const [bps, setBps] = useState<bigint | null>(null);
  return (
    <PercentPicker
      valueBps={bps}
      onChange={(v) => {
        told(v);
        setBps(v.bps);
      }}
    />
  );
}

function setup() {
  const told = vi.fn<(v: Picked) => void>();
  render(<Picker told={told} />);
  return { told, other: screen.getByLabelText('Other percent') as HTMLInputElement };
}
/** One input event per key, as a keypad sends them. */
const type = (el: HTMLInputElement, keys: string) => {
  for (const k of keys) fireEvent.change(el, { target: { value: el.value + k } });
};

describe('PercentPicker: a comma in "Other percent"', () => {
  it('reads a typed comma as the decimal point', () => {
    // A phone set to a comma-decimal region has "," and no "." on this keypad.
    const { told, other } = setup();
    type(other, '12,5');
    expect(told).toHaveBeenLastCalledWith({ bps: 1_250n, bad: false });
  });

  it('never re-reads a comma already in the box, so editing a refused paste cannot make it a percent', () => {
    // "1,234" pasted is refused. With its last digit deleted it is still not 1.23%.
    const { told, other } = setup();
    fireEvent.change(other, { target: { value: '1,234' } });
    expect(told).toHaveBeenLastCalledWith({ bps: null, bad: true });
    fireEvent.change(other, { target: { value: '1,23' } });
    expect(told).toHaveBeenCalledTimes(2);
    expect(told).toHaveBeenLastCalledWith({ bps: null, bad: true });
  });
});
