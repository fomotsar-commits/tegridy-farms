// THE MOUNT, PROVEN AT THE ROUTE.
//
// What this file used to pin was a page that could not be used: with no wallet the
// builder was greyed out under "connect and sign in", and with a wallet every call
// answered 503 because `016_alert_rules.sql` had not been applied by hand. Both
// states were honestly disclosed and neither could be left, because the venue has
// no sign-in control at all.
//
// The store now lives in this browser, so the state a visitor lands in is the
// WORKING one, and that is what is pinned here: the form accepts a rule with no
// wallet, the SIWE-gated store is never called, and the copy no longer promises a
// wallet-bound store nobody can reach.
//
// The panel is rendered REAL — only wagmi, the art backdrop and framer-motion are
// stubbed — because a test that mocked useAlerts would prove the page renders a mock.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false, address: undefined }),
  useChainId: () => 1,
  useReadContract: () => ({ data: undefined }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn(), isLoading: false, isError: false, error: null }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, reset: vi.fn(), error: null }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false, isError: false }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));

import AlertsPage from './AlertsPage';

const renderPage = () =>
  render(<AlertsPage />, { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> });

const inRules = () => within(screen.getByRole('region', { name: 'Alert rules' }));
const EVM = '0x420698cfdeddea6bc78d59bc17798113ad278f9d';

beforeEach(() => {
  localStorage.clear();
  // The store is local and the loop is parked until a rule exists, so NOTHING on
  // this page may reach the network in the state a visitor lands in. A call
  // arriving here is the claim failing, not the stub.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no request should be made in this state');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('the route renders the whole alerts surface', () => {
  it('mounts the page and all three panels without throwing', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Alerts' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Alert rules' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Notification inbox' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Alert delivery' })).toBeInTheDocument();
  });

  it('keeps a heading level between the page h1 and the panels’ h3s', () => {
    const { container } = renderPage();
    const levels = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(1);
    let previous = 0;
    for (const level of levels) {
      if (previous !== 0) expect(level, `h${level} follows h${previous}`).toBeLessThanOrEqual(previous + 1);
      previous = level;
    }
  });
});

describe('a visitor with no wallet can actually use it', () => {
  it('offers an enabled form and a store that says where it lives', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeEnabled();
    expect(inRules().getByText(/Saved in this browser/)).toBeInTheDocument();
  });

  it('accepts a rule with no wallet, and never asks a server to store it', async () => {
    renderPage();
    fireEvent.change(inRules().getByRole('combobox'), { target: { value: 'heat-tier' } });
    fireEvent.change(inRules().getByPlaceholderText(/address/i), { target: { value: EVM } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() => expect(inRules().getByText(/Saved in this browser — 1 of 10/)).toBeInTheDocument());
    expect(localStorage.getItem('tegridy-alert-rules-v1')).toContain('heat-tier');
    // The rule now EXISTS, so the evaluation loop un-parks and reads its source —
    // that traffic is the surface working. What must never happen is a call to
    // the SIWE-gated rule store, which is the request that used to answer 401
    // and then 503 and left the page dead.
    const urls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('resource=alerts'))).toBe(false);
  });

  it('a rule whose source is dark becomes a gap row, not silence', async () => {
    renderPage();
    fireEvent.change(inRules().getByRole('combobox'), { target: { value: 'whale-move' } });
    fireEvent.change(inRules().getByPlaceholderText(/address/i), { target: { value: EVM } });
    fireEvent.change(inRules().getByPlaceholderText(/USD threshold/i), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    const inbox = within(screen.getByRole('region', { name: 'Notification inbox' }));
    // The indexer is unhosted, so this rule cannot be evaluated — and that must
    // arrive as a visible row saying so, never as an empty, calm-looking inbox.
    await waitFor(() => expect(inbox.getByText(/Could not evaluate/)).toBeInTheDocument());
    expect(document.body.textContent).not.toMatch(/none of them matched/i);
  });
});

describe('the copy promises only what this build can keep', () => {
  it('never says the rules are stored against a wallet', () => {
    renderPage();
    // TelegramLinkPanel owns its OWN signed-out sentence, and that one is true:
    // binding a chat really does need a session. Scoping keeps this assertion
    // about the rule store.
    const telegram = screen.getByRole('region', { name: 'Telegram' });
    const outside = [...document.querySelectorAll('p, li, span')].filter((el) => !telegram.contains(el));
    for (const el of outside) {
      expect(el.textContent ?? '').not.toMatch(/stored against your wallet/i);
    }
  });

  it('says rules need no sign-in — and does NOT say the page needs none', () => {
    renderPage();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/saved in this browser and need no sign-in/i);
    // Wallet sync and Telegram binding still do need one. A blanket "no sign-in
    // needed" would be a promise the Telegram panel immediately contradicts.
    expect(text).toMatch(/does not offer a sign-in yet/i);
  });

  it('the empty inbox says nothing is being watched, and never reports calm', () => {
    renderPage();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/nothing is being watched/i);
    expect(text).not.toMatch(/none of them matched/i);
  });

  it('the meta description names no rule kind this build cannot read', () => {
    renderPage();
    const description = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
    expect(description.length).toBeGreaterThan(0);
    // Whale moves and LP unlocks are dark: naming them in the page's own
    // description advertises coverage the engine does not have.
    expect(description).not.toMatch(/whale/i);
    expect(description).not.toMatch(/LP unlock/i);
  });

  it('every control in the three alert regions is a 44px target', () => {
    renderPage();
    for (const name of ['Alert rules', 'Notification inbox', 'Alert delivery']) {
      const region = screen.getByRole('region', { name });
      for (const control of region.querySelectorAll('button, input, select')) {
        expect(control.className, `${name}: ${control.textContent || control.tagName}`).toContain('min-h-11');
      }
    }
  });
});
