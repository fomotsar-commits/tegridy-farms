/**
 * A11Y-R04 — the /developers key table scrolls inside its own container.
 *
 * Five columns, `w-full`, and no scroll wrapper: at 390px the Tier / Label /
 * State / Revoke columns were pushed past the viewport and then clipped by the
 * global `body { overflow-x: hidden }`, so revoking a key from a phone was not
 * merely awkward — the control was unreachable. This asserts the wrapper, which
 * does not exist on the pre-change file.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiKeyPanel } from './ApiKeyPanel';
import type { ApiStatusState } from './useApiPlatformStatus';

const READY: ApiStatusState = {
  phase: 'ready',
  data: {
    platform: {
      keyVerification: 'configured',
      keyIssuance: 'configured',
      metering: 'configured',
      billing: 'not_configured',
    },
    pricingState: 'proposed',
    billingEnabled: false,
    tiers: [],
    routes: [],
    roadmap: [],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('ApiKeyPanel — key table', () => {
  it('wraps the five-column table in a named, focusable scroll container', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          keys: [
            {
              id: 'k1',
              key_prefix: 'tg_live_abcd',
              tier: 'free',
              label: 'staging bot',
              created_at: '2026-09-01T00:00:00Z',
              revoked_at: null,
            },
          ],
        }),
      })),
    );

    render(<ApiKeyPanel status={READY} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show my keys' }));

    const table = await waitFor(() => screen.getByTestId('key-list'));
    const wrapper = table.parentElement!;
    expect(wrapper.className).toContain('overflow-x-auto');
    // A11Y-R12: a scroll container a keyboard user can actually reach and that
    // announces what it holds.
    expect(wrapper.getAttribute('tabindex')).toBe('0');
    expect(wrapper.getAttribute('role')).toBe('region');
    expect(wrapper.getAttribute('aria-label')).toBe('Your API keys');
  });
});
