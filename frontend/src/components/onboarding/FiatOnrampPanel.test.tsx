// HONESTY GUARD — the on-ramp surface must disclose its own state.
//
// The bug shape this pins: an unconfigured integration that renders nothing. A blank panel
// and a partner outage look identical to a user, and identical to an operator reviewing the
// deployment — which is how a venue ships a funnel wall it believes it fixed. So the
// unconfigured branch is required to SAY it is unconfigured, name the missing keys, and
// offer the path that needs no partner at all.
//
// The second pin is the fee sentence. `VITE_ONRAMP_PARTNER_FEE_BPS` mirrors a figure agreed
// inside the provider's dashboard, which this code cannot read. Unset therefore renders as
// "not declared here, the partner's checkout is authoritative" — never as no fee.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FiatOnrampPanel } from './FiatOnrampPanel';

const EVM = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d';

function configureTransak() {
  vi.stubEnv('VITE_ONRAMP_TRANSAK_KEY', 'transak-key');
  vi.stubEnv('VITE_ONRAMP_TRANSAK_ENV', 'PRODUCTION');
}

function configureMoonPay() {
  vi.stubEnv('VITE_ONRAMP_MOONPAY_KEY', 'pk_live_moonkey');
  vi.stubEnv('VITE_ONRAMP_MOONPAY_SIGN_URL', '/api/aggregator?resource=ramp-sign');
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('with no partner configured', () => {
  it('says so in words, rather than rendering nothing', () => {
    render(<FiatOnrampPanel walletAddress={EVM} />);
    expect(screen.getByText(/not configured/i)).toBeTruthy();
  });

  it('renders no link to any partner — there is nothing to click', () => {
    const { container } = render(<FiatOnrampPanel walletAddress={EVM} />);
    expect(container.querySelectorAll('a').length).toBe(0);
    expect(container.querySelectorAll('iframe').length).toBe(0);
  });

  it('names the exact keys the operator is missing', () => {
    const { container } = render(<FiatOnrampPanel walletAddress={EVM} />);
    const text = container.textContent ?? '';
    for (const key of [
      'VITE_ONRAMP_TRANSAK_KEY',
      'VITE_ONRAMP_TRANSAK_ENV',
      'VITE_ONRAMP_MOONPAY_KEY',
      'VITE_ONRAMP_MOONPAY_SIGN_URL',
    ]) {
      expect(text).toContain(key);
    }
  });

  it('offers the path that needs no partner', () => {
    const { container } = render(<FiatOnrampPanel walletAddress={EVM} />);
    expect(container.textContent).toMatch(/sending eth from an exchange/i);
  });
});

describe('with a partner configured but no wallet', () => {
  it('asks for an address instead of guessing one, and links nowhere', () => {
    configureTransak();
    const { container } = render(<FiatOnrampPanel />);
    expect(screen.getByText(/connect a wallet first/i)).toBeTruthy();
    expect(container.querySelectorAll('a').length).toBe(0);
  });
});

describe('with a partner configured and a wallet connected', () => {
  it('hands off to the partner origin in a new tab, with noopener', () => {
    configureTransak();
    render(<FiatOnrampPanel walletAddress={EVM} />);
    const link = screen.getByRole('link', { name: /continue to transak/i }) as HTMLAnchorElement;
    expect(link.href.startsWith('https://global.transak.com')).toBe(true);
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(link.rel).toContain('noreferrer');
  });

  it('states that payment details are collected by the partner, not by the venue', () => {
    configureTransak();
    const { container } = render(<FiatOnrampPanel walletAddress={EVM} />);
    expect(container.textContent).toMatch(/never receives them/i);
  });

  it('embeds nothing — the partner is never rendered inside our chrome', () => {
    configureTransak();
    const { container } = render(<FiatOnrampPanel walletAddress={EVM} />);
    expect(container.querySelectorAll('iframe').length).toBe(0);
  });

  it('refuses an address that is not valid for the chain, and offers no link', () => {
    configureTransak();
    const { container } = render(<FiatOnrampPanel walletAddress="0xnope" />);
    expect(container.textContent).toMatch(/not a valid ethereum address/i);
    expect(container.querySelectorAll('a').length).toBe(0);
  });
});

describe('a signing partner surfaces its round-trip honestly', () => {
  it('offers no link until the handoff has been prepared', () => {
    configureMoonPay();
    const { container } = render(<FiatOnrampPanel walletAddress={EVM} />);
    expect(container.querySelectorAll('a').length).toBe(0);
    expect(screen.getByRole('button', { name: /prepare purchase with moonpay/i })).toBeTruthy();
  });

  it('reports an outage as an outage, and still offers no link', async () => {
    configureMoonPay();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response));
    const { container } = render(<FiatOnrampPanel walletAddress={EVM} />);
    fireEvent.click(screen.getByRole('button', { name: /prepare purchase/i }));
    await waitFor(() => expect(container.textContent).toMatch(/unavailable right now/i));
    expect(container.textContent).toMatch(/this is an outage/i);
    expect(container.querySelectorAll('a').length).toBe(0);
  });
});

describe('the partner fee is disclosed, and an unset dial is never a zero', () => {
  it('says the figure is not declared here when the dial is unset', () => {
    configureTransak();
    const { container } = render(<FiatOnrampPanel walletAddress={EVM} />);
    expect(container.textContent).toMatch(/not declared in this build/i);
    expect(container.textContent).not.toMatch(/no partner fee|fee of 0%/i);
  });

  it('renders the declared figure when the operator sets one', () => {
    configureTransak();
    vi.stubEnv('VITE_ONRAMP_PARTNER_FEE_BPS', '75');
    const { container } = render(<FiatOnrampPanel walletAddress={EVM} />);
    expect(container.textContent).toMatch(/partner fee of 0\.75%/i);
  });

  it('never presents the partner’s checkout total as this page’s own quote', () => {
    configureTransak();
    const { container } = render(<FiatOnrampPanel walletAddress={EVM} />);
    expect(container.textContent).toMatch(/nothing on this page is a quote/i);
  });
});
