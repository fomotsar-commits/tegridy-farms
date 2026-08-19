// The developer page is a set of claims about a product someone may pay for. Two
// ways it could lie, and one test for each:
//
//   1. It could publish a limit the limiter does not enforce. Guarded by deriving
//      every expectation from api/_lib/apiTiers.js — the module the server reads —
//      so copy typed into the JSX cannot satisfy this file.
//   2. It could imply the API is live on a deployment where nothing is configured,
//      or where it never managed to ask. 'unreachable' is not a third spelling of
//      'off': the page must say it does not know, and must offer no button either
//      way.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { ApiTier } from '../../api/_lib/apiTiers';
import {
  API_TIERS,
  API_TIER_ORDER,
  API_BILLING_ENABLED,
  API_ERROR_SEMANTICS,
  API_ROUTES,
} from '../../api/_lib/apiTiers.js';
import DeveloperPage from './DeveloperPage';

const TIERS: ApiTier[] = API_TIER_ORDER.map((id: string) => API_TIERS[id]).filter(
  (t: ApiTier | undefined): t is ApiTier => t !== undefined,
);

function statusBody(overrides: Record<string, unknown> = {}) {
  return {
    platform: {
      keyVerification: 'not_configured',
      keyIssuance: 'not_configured',
      metering: 'not_configured',
      billing: 'not_configured',
    },
    pricingState: 'proposed',
    billingEnabled: false,
    tiers: TIERS,
    routes: API_ROUTES,
    roadmap: [],
    ...overrides,
  };
}

/** Serve /api/v1?route=status with a given body, or fail the fetch outright. */
function serveStatus(body: unknown | null, { ok = true, throws = false } = {}) {
  globalThis.fetch = vi.fn(async () => {
    if (throws) throw new Error('offline');
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('pricing is rendered from the catalog the server enforces', () => {
  it('renders one row per catalog tier, with that tier’s own numbers', async () => {
    serveStatus(statusBody());
    render(<DeveloperPage />);

    const table = screen.getByTestId('pricing-table');
    const rows = within(table).getAllByRole('row').slice(1); // drop the header
    expect(rows).toHaveLength(TIERS.length);

    // Column positions are pinned too: a price rendered under "Rate limit" is a
    // readable table that says the wrong thing.
    TIERS.forEach((tier, i) => {
      const row = rows[i]!;
      const cells = within(row).getAllByRole('cell');
      expect(within(row).getByRole('rowheader').textContent).toContain(tier.label);
      const price = tier.priceUsdMonthly === 0 ? 'Free' : `$${tier.priceUsdMonthly.toLocaleString('en-US')}/mo`;
      expect(cells[0]!.textContent, `${tier.id} price`).toBe(price);
      expect(cells[1]!.textContent, `${tier.id} quota`).toBe(
        tier.includedCallsPerMonth.toLocaleString('en-US'),
      );
      expect(cells[2]!.textContent, `${tier.id} rate`).toBe(`${tier.rateLimitPerMinute} req/min`);
    });
  });

  it('never quotes an overage rate that nothing can charge', async () => {
    // The catalog publishes overage rates so integrators can model cost. With no
    // processor wired nothing can bill them, so the quota hard-stops — and a cell
    // reading "$0.002/call" beside a limiter that 429s is the same lie twice.
    expect(API_BILLING_ENABLED).toBe(false);
    serveStatus(statusBody());
    render(<DeveloperPage />);

    const table = screen.getByTestId('pricing-table');
    expect(within(table).getAllByText(/hard stop/i)).toHaveLength(TIERS.length);
    for (const tier of TIERS) {
      if (tier.overageUsdPerCall !== null) {
        expect(within(table).queryByText(`$${tier.overageUsdPerCall}/call`)).toBeNull();
      }
    }
  });

  it('says the prices are not live before showing them', async () => {
    serveStatus(statusBody());
    render(<DeveloperPage />);
    const disclosure = screen.getByTestId('pricing-disclosure');
    expect(disclosure.textContent).toMatch(/proposed, not live/i);
    expect(disclosure.textContent).toMatch(/nothing here takes a card/i);
  });
});

describe('the refusal contract is published, not summarised', () => {
  it('renders every documented code', async () => {
    serveStatus(statusBody());
    render(<DeveloperPage />);
    const table = screen.getByTestId('error-table');
    for (const row of API_ERROR_SEMANTICS) {
      expect(within(table).getByText(row.code), row.code).toBeInTheDocument();
    }
  });

  it('states that a 502 is not a clean scan', async () => {
    serveStatus(statusBody());
    render(<DeveloperPage />);
    const contract = screen.getByTestId('scanned-flag-contract');
    expect(contract.textContent).toMatch(/502 is not a clean scan/i);
    expect(contract.textContent).toMatch(/no scan happened/i);
  });

  it('names the surfaces it does not serve instead of omitting them', async () => {
    serveStatus(statusBody());
    render(<DeveloperPage />);
    const roadmap = screen.getByTestId('roadmap-list');
    expect(roadmap.textContent).toMatch(/deployer reputation/i);
    expect(roadmap.textContent).toMatch(/wallet exposure/i);
  });
});

describe('the page never claims a capability it did not read', () => {
  it('offers no key issuance when the deployment reports none', async () => {
    serveStatus(statusBody());
    render(<DeveloperPage />);

    await screen.findByTestId('keys-not-configured');
    expect(screen.getByTestId('keys-not-configured').textContent).toMatch(
      /issuance is not enabled on this deployment/i,
    );
    expect(screen.queryByRole('button', { name: /issue a free key/i })).toBeNull();
  });

  it('warns that a key would still be refused when metering is unset', async () => {
    // A deployment could have a key store and no meter. Issuing a key there and
    // saying nothing would hand someone a credential that 503s on first use.
    serveStatus(
      statusBody({
        platform: {
          keyVerification: 'configured',
          keyIssuance: 'configured',
          metering: 'not_configured',
          billing: 'not_configured',
        },
      }),
    );
    render(<DeveloperPage />);
    await screen.findByTestId('keys-metering-warning');
    expect(screen.getByTestId('keys-metering-warning').textContent).toMatch(/metering_not_configured/);
  });

  it('says it does not know when the status endpoint cannot be read', async () => {
    // THE CASE THAT MATTERS. A failed read is not a reading of "off". The page must
    // not render either the signup or the "not enabled" claim.
    serveStatus(null, { throws: true });
    render(<DeveloperPage />);

    await screen.findByTestId('keys-unknown');
    expect(screen.getByTestId('keys-unknown').textContent).toMatch(/is unknown/i);
    expect(screen.queryByTestId('keys-not-configured')).toBeNull();
    expect(screen.queryByRole('button', { name: /issue a free key/i })).toBeNull();
  });

  it('treats a 200 whose body it cannot recognise as unreadable, not as configured', async () => {
    serveStatus({ ok: true });
    render(<DeveloperPage />);
    await screen.findByTestId('keys-unknown');
    expect(screen.queryByTestId('keys-panel')).toBeNull();
  });

  it('shows the issue control only once the deployment reports issuance configured', async () => {
    serveStatus(
      statusBody({
        platform: {
          keyVerification: 'configured',
          keyIssuance: 'configured',
          metering: 'configured',
          billing: 'not_configured',
        },
      }),
    );
    render(<DeveloperPage />);
    await waitFor(() => expect(screen.getByTestId('keys-panel')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /issue a free key/i })).toBeInTheDocument();
    // Still no checkout: issuance mints the free tier and takes no payment.
    expect(screen.getByTestId('keys-panel').textContent).toMatch(/nothing on this page takes payment/i);
  });
});
