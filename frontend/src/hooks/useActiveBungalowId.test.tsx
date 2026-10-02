// Surfaces that outlive a door (the nav, the footer, the layout) subscribe to
// the skin with this hook. A door writes during its render and announces after
// commit, so a subscriber that rendered BEFORE the door on the same pass still
// reaches the new room before paint, and one that has nothing new stays put.

import { describe, it, expect, afterEach } from 'vitest';
import { memo } from 'react';
import { act, render, screen } from '@testing-library/react';
import { useActiveBungalowId } from './useActiveBungalowId';
import { BungalowDoor, VENUE_ID } from '../components/bungalow/BungalowDoor';
import { announceActiveBungalow, BUNGALOW_STORAGE_KEY, setActiveBungalow } from '../lib/bungalows';

afterEach(() => {
  localStorage.clear();
});

function probe() {
  const renders: (string | null)[] = [];
  function Probe() {
    const id = useActiveBungalowId();
    renders.push(id);
    return <span data-testid="probe">{id ?? 'venue'}</span>;
  }
  return { Probe, renders };
}

describe('useActiveBungalowId', () => {
  it('re-renders once when an announce follows a write', () => {
    const { Probe, renders } = probe();
    render(<Probe />);
    expect(renders).toEqual([null]);
    act(() => {
      setActiveBungalow('bayla');
      announceActiveBungalow();
    });
    expect(renders).toEqual([null, 'bayla']);
    expect(screen.getByTestId('probe').textContent).toBe('bayla');
  });

  it('does not re-render on an announce that changed nothing', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    const { Probe, renders } = probe();
    render(<Probe />);
    act(() => announceActiveBungalow());
    expect(renders).toEqual(['bayla']);
  });

  it('a subscriber rendered before a door reaches the new room in the same act', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, VENUE_ID);
    const { Probe, renders } = probe();
    render(
      <>
        <Probe />
        <BungalowDoor id="bayla">
          <div />
        </BungalowDoor>
      </>,
    );
    expect(renders[0], 'the probe renders first and reads the old skin').toBeNull();
    expect(screen.getByTestId('probe').textContent).toBe('bayla');
  });

  it('a memoized subscriber that bails out of the render still reaches the new room', () => {
    // TopNav and BottomNav are React.memo: they do not re-render when a door
    // opens on another route, so only the door's announce reaches them.
    localStorage.setItem(BUNGALOW_STORAGE_KEY, VENUE_ID);
    const { Probe, renders } = probe();
    const Memoized = memo(Probe);
    const { rerender } = render(
      <>
        <Memoized />
        <span />
      </>,
    );
    expect(renders).toEqual([null]);
    rerender(
      <>
        <Memoized />
        <BungalowDoor id="bayla">
          <div />
        </BungalowDoor>
      </>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('bayla');
  });

  it('the venue door brings a subscriber back to the venue', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    const { Probe } = probe();
    render(
      <>
        <Probe />
        <BungalowDoor id={VENUE_ID}>
          <div />
        </BungalowDoor>
      </>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('venue');
  });
});
