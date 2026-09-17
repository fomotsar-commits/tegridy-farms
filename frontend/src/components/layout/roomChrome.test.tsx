/**
 * WAVE SEVEN, answer eight, ruling 1: THE DOOR DECIDES THE CHROME.
 *
 * "On a toweli route the chrome follows the route, not the last-visited
 * resident: the nav chip and the footer card read TOWELI or the venue, never
 * Bayla."
 *
 * WHY THIS FILE EXISTS, AND IT IS NOT DUPLICATION. Both halves of ruling 1 were
 * pinned only in e2e, and both of those tests skip on every project but
 * chromium. A CI run that excludes the chromium project gates NEITHER fix while
 * reporting green - the exact shape of "a local green is a narrower question".
 * The occlusion half genuinely needs a browser (nothing else can answer
 * elementFromPoint), but the half that decides WHOSE chrome renders is pure
 * route logic, and pure route logic belongs where it runs on every push.
 *
 * THE COUNTER-TEST IS THE POINT. A fix that deleted resident chrome outright
 * would pass every "no Bayla on /tokenomics" assertion ever written, and would
 * take the thirteen doors' own identity with it. So each case here is paired:
 * the same stored resident, one route apart, asserted present on the door and
 * absent in the protocol room.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
const { RouteTabs } = await import('./RouteTabs');
const { ThemeProvider } = await import('../../contexts/ThemeContext');

/** A visitor carrying the last door they walked through. */
function walkedThrough(id: string) {
  try {
    localStorage.setItem('tegridy-bungalow', id);
  } catch {
    /* private mode */
  }
}

function at(path: string, node: React.ReactNode) {
  // TopNav reads the theme context; the Footer does not, and wrapping both in
  // it costs nothing and keeps one mount helper.
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>{node}</ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("the footer's chrome follows the route", () => {
  it('drops the resident card in a TOWELI protocol room, carrying Bayla', () => {
    walkedThrough('bayla');
    const { container } = at('/tokenomics', <Footer />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('Bayla bungalow');
    expect(text).not.toContain('BAYLA contract');
  });

  it('KEEPS the resident card on that resident own door, same storage', () => {
    // The counter-test. Without this, deleting the card entirely would pass the
    // case above and quietly strip every door of its identity.
    walkedThrough('bayla');
    const { container } = at('/bayla', <Footer />);
    expect(container.textContent ?? '').toContain('Bayla');
  });

  it('speaks the resident card without a prose dash on the resident own door', () => {
    // Answer ten, ruling 6: " <NAME> bungalow, Jungle Bay Island." The em dash here
    // rendered in all eleven settled rooms at once, from one line of the footer.
    walkedThrough('bayla');
    const { container } = at('/bayla', <Footer />);
    const text = container.textContent ?? '';
    expect(text).toContain('Bayla bungalow, Jungle Bay Island.');
    expect(text).not.toContain('—');
  });

  it('names no resident beside the room label in a TOWELI room', () => {
    // The label reads "Bungalows · <room>" on a door. In a protocol room it is
    // the bare word, because the room is not theirs. The separator is a middle
    // dot and not an em dash, which is element I's business: an em dash here
    // billed one dash of venue CHROME to all fourteen doors at once.
    walkedThrough('bayla');
    const { container } = at('/tokenomics', <Footer />);
    const label = container.textContent ?? '';
    expect(label).toContain('Bungalows');
    expect(label).not.toContain('Bungalows · Bayla');
    expect(label).not.toContain('—');
  });
});

describe("the nav chip's chrome follows the route", () => {
  const chip = () => screen.getByRole('button', { name: 'Choose your bungalow' });

  it('reads the plain word in a TOWELI protocol room, carrying Bayla', () => {
    walkedThrough('bayla');
    at('/tokenomics', <TopNav />);
    expect(chip().textContent).toContain('Bungalows');
    expect(chip().textContent).not.toContain('Bayla');
  });

  it('reads the resident name on their own door, same storage', () => {
    walkedThrough('bayla');
    at('/bayla', <TopNav />);
    expect(chip().textContent).toContain('Bayla');
  });
});

describe('the tab bar leaves room for the band', () => {
  it('offsets itself by the measured band height, never a bare 56px', () => {
    // The OTHER half of ruling 1, as far as a unit test can honestly reach: the
    // occlusion itself needs a browser, but a tab bar pinned at a hard-coded
    // top is the defect that caused it, and that is visible here. AppLayout
    // measures the band and publishes --room-band-h; the fallback 0px keeps
    // every page without a band exactly where it was.
    const { container } = render(
      <MemoryRouter>
        <RouteTabs
          idPrefix="test"
          ariaLabel="Test sections"
          items={[{ to: '/tokenomics', label: 'Tokenomics' }]}
          active="/tokenomics"
          onSelect={() => {}}
        />
      </MemoryRouter>,
    );
    const fixed = container.querySelector<HTMLElement>('div.fixed');
    expect(fixed).not.toBeNull();
    expect(fixed!.style.top).toBe('calc(56px + var(--room-band-h, 0px))');
  });
});
