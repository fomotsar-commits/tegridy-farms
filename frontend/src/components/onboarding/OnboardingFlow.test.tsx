// The first-run route, end to end.
//
// The pins that matter are the ones about what a newcomer is TOLD. The flow must be usable
// with no wallet (a funnel that demands a connection before explaining itself is the wall it
// exists to remove), it must reach the risk disclosure without a wallet too, and every link
// it renders must be an in-app route to a surface whose own gate says it is running.
//
// On an unconfigured build — which is what CI is — the funding step must still say
// something. A blank funding step is the exact failure the on-ramp was added to fix.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';
import OnboardingFlow from './OnboardingFlow';
import { onboardingSteps } from './onboardingSteps';

function next() {
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
}

beforeEach(() => {
  wagmiMock.reset();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the flow works without a wallet', () => {
  it('opens on the first step and shows the step count', () => {
    renderWithProviders(<OnboardingFlow />);
    const steps = onboardingSteps();
    expect(screen.getByText(steps[0]!.title)).toBeTruthy();
    expect(screen.getByText(`Step 1 of ${steps.length}`)).toBeTruthy();
  });

  it('walks to the last step with no connection', () => {
    renderWithProviders(<OnboardingFlow />);
    const steps = onboardingSteps();
    for (let i = 1; i < steps.length; i += 1) next();
    expect(screen.getByText(steps.at(-1)!.title)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('reaches the risk disclosure without a wallet', () => {
    renderWithProviders(<OnboardingFlow />);
    const steps = onboardingSteps();
    const riskIndex = steps.findIndex((s) => s.id === 'risks');
    for (let i = 0; i < riskIndex; i += 1) next();
    expect(screen.getByText(steps[riskIndex]!.title)).toBeTruthy();
    expect(document.body.textContent).toMatch(/experimental software/i);
  });
});

describe('the funding step always says something', () => {
  it('renders the on-ramp panel’s unconfigured disclosure on a build with no partner keys', () => {
    renderWithProviders(<OnboardingFlow />);
    const steps = onboardingSteps();
    const fundingIndex = steps.findIndex((s) => s.showOnramp);
    for (let i = 0; i < fundingIndex; i += 1) next();
    expect(screen.getByText(/not configured/i)).toBeTruthy();
    expect(document.body.textContent).toMatch(/VITE_ONRAMP_TRANSAK_KEY/);
  });

  it('passes the connected address through to the panel', () => {
    const address = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d';
    wagmiMock.setAccount({ address, isConnected: true });
    vi.stubEnv('VITE_ONRAMP_TRANSAK_KEY', 'transak-key');
    vi.stubEnv('VITE_ONRAMP_TRANSAK_ENV', 'PRODUCTION');
    renderWithProviders(<OnboardingFlow />);
    const steps = onboardingSteps();
    const fundingIndex = steps.findIndex((s) => s.showOnramp);
    for (let i = 0; i < fundingIndex; i += 1) next();
    const link = screen.getByRole('link', { name: /continue to transak/i }) as HTMLAnchorElement;
    expect(link.href).toContain(encodeURIComponent(address));
  });
});

describe('every link is an in-app route to something that is running', () => {
  it('renders only relative hrefs on the last step', () => {
    const { container } = renderWithProviders(<OnboardingFlow />);
    const steps = onboardingSteps();
    for (let i = 1; i < steps.length; i += 1) next();
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href.startsWith('/'), `${href} leaves the app`).toBe(true);
      expect(href.startsWith('//')).toBe(false);
    }
  });

  it('offers exactly the live surfaces the step model resolved, no more', () => {
    const { container } = renderWithProviders(<OnboardingFlow />);
    const steps = onboardingSteps();
    for (let i = 1; i < steps.length; i += 1) next();
    const expected = steps.at(-1)!.actions.map((a) => a.route);
    const grid = container.querySelector('.grid');
    const rendered = grid ? [...within(grid as HTMLElement).getAllByRole('link')].map((a) => a.getAttribute('href')) : [];
    expect(rendered).toEqual(expected);
  });
});

describe('the flow itself asks for nothing', () => {
  it('renders no form field and no wallet prompt of its own', () => {
    const { container } = renderWithProviders(<OnboardingFlow />);
    expect(container.querySelectorAll('input, form').length).toBe(0);
  });
});
