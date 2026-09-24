// THE SURFACES THAT OUTLIVE A DOOR HAVE TO BE TOLD THE ROOM CHANGED.
//
// A door changes the skin in place and never reloads, so the nav, the footer,
// the layout and the Earn page only re-read the room because they subscribe to
// the skin store through useActiveBungalowId(). TopNav and BottomNav are
// React.memo, so nothing else re-renders them at all: without the subscription
// they keep the previous room's word and the previous room's Swap target.
//
// Each case here announces WITHOUT re-rendering the tree, which is exactly what
// a door on another route does. AppLayout and FarmPage are pinned by the call
// itself: on their own paths a re-render arrives for other reasons, so a
// rendered assertion would pass with the subscription deleted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: Object.assign(() => null, { Custom: () => null }),
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false }),
}));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

const { Footer } = await import('./Footer');
const { TopNav } = await import('./TopNav');
const { BottomNav } = await import('./BottomNav');
const { ThemeProvider } = await import('../../contexts/ThemeContext');
const { announceActiveBungalow, setActiveBungalow } = await import('../../lib/bungalows');

/** Mounted on a path no door owns, so only the store can move what is rendered. */
function mount(node: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <ThemeProvider>{node}</ThemeProvider>
    </MemoryRouter>,
  );
}

/** What a door does: write the choice, then announce it after commit. */
function aDoorOpens(id: string) {
  act(() => {
    setActiveBungalow(id);
    announceActiveBungalow();
  });
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe('a door reaches the surfaces that outlive it', () => {
  it("moves the footer's room label with no re-render of the tree", () => {
    const { container } = mount(<Footer />);
    expect(container.textContent ?? '').not.toContain('Bayla');
    aDoorOpens('bayla');
    expect(container.textContent ?? '', 'the footer still names the room it was mounted in').toContain('Bungalows · Bayla');
  });

  it('moves the memoized top nav chip with no re-render of the tree', () => {
    mount(<TopNav />);
    const chip = () => screen.getByRole('button', { name: 'Choose your bungalow' });
    expect(chip().textContent).toContain('Bungalows');
    expect(chip().textContent).not.toContain('Bayla');
    aDoorOpens('bayla');
    expect(chip().textContent, 'the chip still names the room the document booted in').toContain('Bayla');
  });

  it('moves the memoized bottom nav Swap target with no re-render of the tree', () => {
    mount(<BottomNav />);
    const swap = () => screen.getByRole('link', { name: 'Swap' });
    expect(swap().getAttribute('href')).toBe('/swap');
    aDoorOpens('bayla');
    expect(swap().getAttribute('href'), 'the Swap word still points at the other chain').toBe('/solana');
  });
});

/** src/, from this file. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('every surface that outlives a door subscribes to the skin', () => {
  it.each([
    'components/layout/AppLayout.tsx',
    'components/layout/TopNav.tsx',
    'components/layout/BottomNav.tsx',
    'components/layout/Footer.tsx',
    'pages/FarmPage.tsx',
  ])('%s calls useActiveBungalowId()', (rel) => {
    const source = readFileSync(join(SRC, rel), 'utf8');
    expect(
      source.includes('useActiveBungalowId()'),
      `${rel} outlives a door but no longer subscribes to the skin store, so it renders the previous room until something else re-renders it`,
    ).toBe(true);
  });
});
