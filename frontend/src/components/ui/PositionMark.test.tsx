import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PositionMark, positionHost } from './PositionMark';

describe('PositionMark', () => {
  it('says "You’re in" only once a read found a position', () => {
    const { rerender } = render(<PositionMark inPosition={false} />);
    expect(screen.queryByTestId('position-mark')).toBeNull();
    rerender(<PositionMark inPosition />);
    expect(screen.getByTestId('position-mark')).toHaveTextContent('You’re in');
  });

  it('positionHost adds the ring class only for a position', () => {
    expect(positionHost('card', false)).toBe('card');
    expect(positionHost('card', true)).toBe('card position-glow');
    expect(positionHost('', true).trim()).toBe('position-glow');
  });
});
