// Island answer twenty-four, §4: a room's header names its coin as a press that copies the
// whole address, with the head and tail beside the name, "Copied" for one second and a tick.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BUNGALOWS } from '../../lib/bungalows';
import { BungalowHero } from './BungalowHero';

const bayla = BUNGALOWS.find((b) => b.id === 'bayla') as Parameters<typeof BungalowHero>[0]['bungalow'];

describe('the room header’s coin', () => {
  const writeText = vi.fn(async () => {});
  const vibrate = vi.fn(() => true);
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the room’s ticker with the address’s head and tail, and one press copies the whole address', async () => {
    vi.useFakeTimers();
    render(
      <MemoryRouter>
        <BungalowHero bungalow={bayla} />
      </MemoryRouter>,
    );
    const name = screen.getByTestId('coin-name');
    expect(name).toHaveTextContent('BAYLA');
    expect(name).toHaveTextContent(`${bayla.address!.slice(0, 4)} … ${bayla.address!.slice(-4)}`);
    expect(name).toHaveAccessibleName(`BAYLA: copy its address ${bayla.address}`);
    await act(async () => {
      fireEvent.click(name);
    });
    expect(writeText).toHaveBeenCalledWith(bayla.address);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Copied')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1_001);
    });
    expect(screen.queryByText('Copied')).toBeNull();
  });
});
