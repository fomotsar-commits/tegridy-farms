/**
 * A11Y-R09 — the "More" dropdown keeps only the promises it implements.
 *
 * It declared role="menu" / role="menuitem" / aria-haspopup="true", which tells
 * assistive technology to expect arrow-key roving focus, Home/End, Escape and
 * focus moved into the popup. None of that existed: it closed on an outside
 * mousedown or a route change, so a keyboard user who opened it was stuck with
 * it until they navigated away. The roles are gone and Escape is real. Both
 * assertions fail on the pre-change file — the first because the menu roles are
 * still there, the second because nothing listens for Escape.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// TopNav renders <ConnectButton.Custom>, so the stub needs that member, not
// just a component.
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: Object.assign(() => null, { Custom: () => null }),
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
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

import { TopNav } from './TopNav';
import { ThemeProvider } from '../../contexts/ThemeContext';

function renderNav() {
  render(
    <MemoryRouter>
      <ThemeProvider>
        <TopNav />
      </ThemeProvider>
    </MemoryRouter>,
  );
  return screen.getByRole('button', { name: 'More navigation' });
}

describe('TopNav — the "More" dropdown', () => {
  it('does not claim menu semantics it has not implemented', () => {
    const trigger = renderNav();
    expect(trigger.getAttribute('aria-haspopup')).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
    // It is still announced as what it is — a small nav of links.
    expect(screen.getByRole('navigation', { name: 'More destinations' })).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const trigger = renderNav();
    fireEvent.click(trigger);
    expect(screen.getByRole('navigation', { name: 'More destinations' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('navigation', { name: 'More destinations' })).not.toBeInTheDocument();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('never leaves aria-controls pointing at an unmounted popup', () => {
    // The popup is conditionally rendered, and a dangling idref is itself an
    // a11y violation the route sweep asserts on (aria-valid-attr-value).
    const trigger = renderNav();
    expect(trigger.getAttribute('aria-controls')).toBeNull();
    fireEvent.click(trigger);
    const id = trigger.getAttribute('aria-controls')!;
    expect(document.getElementById(id)).not.toBeNull();
  });
});
