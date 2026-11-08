// Island answer twenty-four, §4: every coin's name is a press that copies its whole address,
// with the head and tail beside it, "Copied" for one second, and the phone's tick.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CoinName, headTail } from './CoinName';

const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';

describe('CoinName', () => {
  const writeText = vi.fn(async () => {});
  const vibrate = vi.fn(() => true);
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    writeText.mockClear();
    vibrate.mockClear();
  });

  it('prints the name with the address head and tail, never the whole address', () => {
    render(<CoinName name="$BAYLA" address={BAYLA} />);
    const press = screen.getByTestId('coin-name');
    expect(press).toHaveTextContent('$BAYLA');
    expect(press).toHaveTextContent('7hmV … pump');
    expect(press.textContent).not.toContain(BAYLA);
    expect(headTail('So11111111111111111111111111111111111111112')).toBe('So11 … 1112');
  });

  it('a press copies the WHOLE address, ticks the phone, and says Copied for one second', async () => {
    render(<CoinName name="$BAYLA" address={BAYLA} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('coin-name'));
    });
    expect(writeText).toHaveBeenCalledWith(BAYLA);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Copied')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByText('Copied')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('the press is 44px tall and names what it copies for a screen reader', () => {
    render(<CoinName name="SOL" address="So11111111111111111111111111111111111111112" />);
    const press = screen.getByRole('button', { name: /SOL: copy its address So1111/ });
    expect(press.className).toContain('min-h-[44px]');
  });
});
