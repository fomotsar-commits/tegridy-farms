// THE MOUNT, PROVEN AT THE ROUTE.
//
// AlertsPanel and its three children were written, unit-tested, and reachable from
// nowhere: no route, no nav entry, no test that rendered them together. So the thing this
// file pins is not the panel's copy (NotificationInbox.test.tsx and
// DeliveryChannelNotice.test.tsx own that) — it is that /alerts composes the real store
// hook, the real evaluation loop and the real inbox, and that the two states this
// deployment can actually be in reach the screen instead of throwing.
//
// Both states are gated states, and neither is hidden:
//
//   signed out     — rules are per-wallet, so there is nothing to read. Said as itself.
//   schema-missing — `016_alert_rules.sql` has not been applied by hand, so every alerts
//                    call answers 503 and the surface prints the server's sentence AND the
//                    operator's next step. This is the state production is in today; a
//                    flag that hid the page to avoid showing it would have been the bug.
//
// The panel is rendered REAL — only wagmi, the art backdrop and framer-motion are stubbed
// — because a test that mocked useAlerts would prove the page renders a mock.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const wallet = vi.hoisted(() => ({ isConnected: false, address: undefined as string | undefined }));

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: wallet.isConnected, address: wallet.address }),
  useChainId: () => 1,
  // usePremiumAccess (read through useAlerts for the rule ceiling) is left REAL, so these
  // are the shapes it destructures. Every read answers "no data", which is what an
  // undeployed PremiumAccess answers, so the free-tier limit is what the builder shows.
  useReadContract: () => ({ data: undefined }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn(), isLoading: false, isError: false, error: null }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, reset: vi.fn(), error: null }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false, isError: false }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));

import AlertsPage from './AlertsPage';

/** The 503 the aggregator answers until migration 016 is applied. */
const SCHEMA_MISSING_DETAIL =
  'The alert-rule table does not exist on this deployment, so no rules could be read or saved.';
const OPERATOR_STEP = 'Apply supabase/migrations/016_alert_rules.sql, then reload.';

function stubSchemaMissing() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({
        code: 'schema-missing',
        error: SCHEMA_MISSING_DETAIL,
        operatorStep: OPERATOR_STEP,
      }),
    })),
  );
}

beforeEach(() => {
  wallet.isConnected = false;
  wallet.address = undefined;
  localStorage.clear();
  // Nothing in either gated state may reach the network: with no wallet the store is
  // never asked, and with no rules the evaluation loop is parked. A call arriving here
  // means one of those two claims stopped being true.
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
  it('mounts the page and all three panels without throwing', async () => {
    render(<AlertsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Alerts' })).toBeInTheDocument();
    // One region per honest state, each owned by the component that holds the fact.
    expect(screen.getByRole('region', { name: 'Alert rules' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Notification inbox' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Alert delivery' })).toBeInTheDocument();
  });

  it('keeps a heading level between the page h1 and the panels’ h3s', () => {
    // The panels ship <h3>; a page whose only other heading is the <h1> would step
    // h1 → h3, which is the `heading-order` finding the route table declares as empty.
    const { container } = render(<AlertsPage />);
    const levels = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(1);
    let previous = 0;
    for (const level of levels) {
      if (previous !== 0) expect(level, `h${level} follows h${previous}`).toBeLessThanOrEqual(previous + 1);
      previous = level;
    }
  });
});

describe('signed out is stated as itself, not as an empty rule list', () => {
  it('says the rules live against the wallet, and asks for a sign-in', () => {
    render(<AlertsPage />);
    // Scoped to the builder: the inbox has its own role="status" for its own kind of
    // empty, and the two must not be read as one message.
    const builder = within(screen.getByRole('region', { name: 'Alert rules' })).getByRole('status');
    expect(builder.textContent).toMatch(/stored against your wallet/i);
    expect(builder.textContent).toMatch(/Connect and sign in/i);
  });

  it('never reports calm — the empty inbox says nothing is being watched', () => {
    render(<AlertsPage />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/nothing is being watched/i);
    expect(text).not.toMatch(/none of them matched/i);
  });

  it('asks the store for nothing while there is no session', () => {
    render(<AlertsPage />);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the 503 the deployment answers today reaches the screen', () => {
  beforeEach(() => {
    wallet.isConnected = true;
    wallet.address = '0x1111111111111111111111111111111111111111';
    stubSchemaMissing();
  });

  it('prints the server’s sentence verbatim, and the operator step with it', async () => {
    render(<AlertsPage />);
    await waitFor(() => expect(screen.getByText(SCHEMA_MISSING_DETAIL)).toBeInTheDocument());
    expect(screen.getByText(new RegExp(OPERATOR_STEP.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')))
      .toBeInTheDocument();
  });

  it('disables the form rather than accepting a rule nothing can store', async () => {
    render(<AlertsPage />);
    await waitFor(() => expect(screen.getByText(SCHEMA_MISSING_DETAIL)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeDisabled();
  });

  it('does not claim the user has no rules, and does not claim the market is quiet', async () => {
    render(<AlertsPage />);
    await waitFor(() => expect(screen.getByText(SCHEMA_MISSING_DETAIL)).toBeInTheDocument());
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/nothing is being watched/i);
    expect(text).not.toMatch(/none of them matched/i);
    expect(text).not.toMatch(/real negative/i);
  });
});
