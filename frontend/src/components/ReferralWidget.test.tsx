// ReferralWidget — the one surface whose output the user carries off-site.
//
// Why it is tested for honesty rather than markup: everything this component
// produces is a claim that leaves the app. A referral link that points at a
// domain nobody registered (F46: tegridy.farm, DNS-level fail) silently voids
// every share; tweet copy that promises the JOINER a bonus promises something
// ReferralSplitter never pays, since only the referrer is credited; and the
// earning condition — the referrer's own staking power — is the difference
// between "share and earn" and "share and earn nothing".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode, HTMLAttributes } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('wagmi', () => ({
  usePublicClient: () => undefined,
}));

vi.mock('./ArtImg', () => ({ ArtImg: () => null }));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy({}, {
    get: () => ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  });
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    useReducedMotion: () => true,
  };
});

import { ReferralWidget } from './ReferralWidget';
import { SITE_URL } from '../lib/constants';

const ADDR = '0x1234567890abcdef1234567890abcdef12345678';

function renderWidget(over: Partial<Parameters<typeof ReferralWidget>[0]> = {}) {
  return render(
    <ReferralWidget
      address={ADDR}
      referredCount={0}
      referralEarned={0}
      referralPending={0}
      {...over}
    />,
  );
}

describe('ReferralWidget', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('the link it mints', () => {
    it('is built on the canonical live origin, not a hardcoded vanity domain', () => {
      const { container } = renderWidget();
      const tweet = container.querySelector<HTMLAnchorElement>('a[href*="twitter.com/intent/tweet"]');
      expect(tweet).not.toBeNull();
      const shared = decodeURIComponent(new URL(tweet!.href).searchParams.get('url') ?? '');
      expect(shared.startsWith(SITE_URL)).toBe(true);
      expect(shared).toContain(`ref=${ADDR}`);
      // The dead domain that voided every prior share.
      expect(shared).not.toContain('tegridy.farm');
    });

    it('shows the user a preview whose host matches the link it will copy', () => {
      const { container } = renderWidget();
      const host = SITE_URL.replace(/^https?:\/\//, '');
      expect(container.textContent ?? '').toContain(host);
    });
  });

  // HONESTY GUARD: what the widget promises, and to whom.
  describe('what it promises', () => {
    it('discloses the staking-power condition on earning', () => {
      const { container } = renderWidget();
      expect(container.textContent ?? '').toMatch(/at least 1,000 TOWELI/i);
    });

    it('promises the joiner nothing, because the contract pays the referrer only', () => {
      const { container } = renderWidget();
      const tweet = container.querySelector<HTMLAnchorElement>('a[href*="twitter.com/intent/tweet"]')!;
      const text = decodeURIComponent(new URL(tweet.href).searchParams.get('text') ?? '');
      expect(text).not.toMatch(/bonus|reward|earn|free|airdrop/i);
    });

    it('states no APR, multiplier, or percentage it does not read from chain', () => {
      const { container } = renderWidget();
      const promo = container.textContent ?? '';
      expect(promo).not.toMatch(/\d+\s*%\s*(of\s+)?(apr|apy|bonus|commission)/i);
    });
  });

  describe('figures', () => {
    it('prints the counts it was handed, with no invented default', () => {
      renderWidget({ referredCount: 7, referralEarned: 0.1234, referralPending: 0.5 });
      expect(screen.getByText('7')).toBeTruthy();
      expect(screen.getByText('0.1234')).toBeTruthy();
    });

    it('does not offer a claim button when there is nothing pending', () => {
      renderWidget({ referralPending: 0, onClaim: () => {} });
      expect(screen.queryByRole('button', { name: /claim eth/i })).toBeNull();
    });

    it('offers the claim only against a real pending balance', () => {
      renderWidget({ referralPending: 0.25, onClaim: () => {} });
      expect(screen.getByRole('button', { name: /claim eth/i })).toBeTruthy();
    });
  });

  describe('referrer linking', () => {
    it('refuses a self-referral and says why', () => {
      const onSetReferrer = vi.fn();
      renderWidget({ onSetReferrer });
      const input = screen.getByLabelText(/referrer address/i);
      fireEvent.change(input, { target: { value: ADDR } });
      const link = screen.getByRole('button', { name: /^link$/i });
      expect(link.hasAttribute('disabled')).toBe(true);
      expect(screen.getByText(/valid address \(not your own\)/i)).toBeTruthy();
      fireEvent.click(link);
      expect(onSetReferrer).not.toHaveBeenCalled();
    });

    it('accepts a distinct valid address', () => {
      const onSetReferrer = vi.fn();
      renderWidget({ onSetReferrer });
      // Lowercase on purpose: viem's isAddress enforces EIP-55 checksums on any
      // mixed-case input, so a mixed-case literal here would fail validation for
      // a reason that has nothing to do with the behaviour under test.
      const other = '0xabcdef0000000000000000000000000000000001';
      fireEvent.change(screen.getByLabelText(/referrer address/i), { target: { value: other } });
      const link = screen.getByRole('button', { name: /^link$/i });
      expect(link.hasAttribute('disabled')).toBe(false);
      fireEvent.click(link);
      expect(onSetReferrer).toHaveBeenCalledWith(other);
    });

    it('shows the on-chain referrer rather than the input when one is already set', () => {
      renderWidget({ onSetReferrer: () => {}, hasReferrer: true, referrer: '0xabcdef0000000000000000000000000000000001' });
      expect(screen.getByText(/referred by/i)).toBeTruthy();
      expect(screen.queryByLabelText(/referrer address/i)).toBeNull();
    });
  });
});
