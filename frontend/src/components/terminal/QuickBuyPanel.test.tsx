import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  SAFETY_NOT_REQUESTED,
  assessRowSafety,
  componentRead,
  componentUnread,
  type RowSafety,
} from '../../lib/terminal/rowSafety';

// NO EXECUTION PROMISE THE CODE DOES NOT PERFORM.
//
// The feed is three chains and the venue's swap is one. The tempting shortcut —
// render the same Buy button everywhere and let it fail on two of them — is the
// exact failure this file pins against. Each chain gets the affordance its rail
// actually supports, and Base gets none because Base has none.

vi.mock('../../hooks/useSwap', () => ({
  useSwap: () => ({
    fromToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18 },
    toToken: null,
    setToToken: vi.fn(),
    inputAmount: '',
    setInputAmount: vi.fn(),
    outputFormatted: '',
    isQuoteLoading: false,
    needsApproval: false,
    insufficientBalance: false,
    approve: vi.fn(),
    executeSwap: vi.fn(),
    isPending: false,
    isConfirming: false,
    customTokens: [],
  }),
}));

import { QuickBuyPanel, type QuickBuyPanelProps } from './QuickBuyPanel';

const EVM_TOKEN = '0x1111111111111111111111111111111111111111';
const EVM_POOL = '0x2222222222222222222222222222222222222222';
const SOL_MINT = '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump';

function renderPanel(props: Partial<QuickBuyPanelProps> = {}) {
  return render(
    <MemoryRouter>
      <QuickBuyPanel token={EVM_TOKEN} safety={SAFETY_NOT_REQUESTED} {...props} />
    </MemoryRouter>,
  );
}

function panel() {
  return screen.getByLabelText('Quick buy');
}

describe('Solana rows are a hand-off, and say so', () => {
  it('links to /solana with the mint preset, and offers no Buy button', () => {
    renderPanel({ token: SOL_MINT, network: 'solana' });
    const link = within(panel()).getByRole('link', { name: /Solana swap page/i });
    expect(link.getAttribute('href')).toBe(`/solana?out=${SOL_MINT}`);
    expect(within(panel()).queryByRole('button', { name: /^buy$/i })).toBeNull();
    expect(within(panel()).queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('states that nothing is bought from this page', () => {
    renderPanel({ token: SOL_MINT, network: 'solana' });
    expect(within(panel()).getByText(/nothing is bought from this page/i)).toBeTruthy();
  });

  it('carries the unresolvable-mint caveat rather than implying the preset always works', () => {
    // The Solana swap page resolves decimals through Jupiter and keeps its own
    // default when it cannot. Saying so is the difference between a hand-off
    // and a promise.
    renderPanel({ token: SOL_MINT, network: 'solana' });
    expect(within(panel()).getByText(/if\s+Jupiter cannot resolve this mint/i)).toBeTruthy();
  });

  it('shows the unread acknowledgement as INFORMATION, not as a checkbox gate', () => {
    // A checkbox in front of a link would imply this page controls what happens
    // on the other side of it.
    const { container } = renderPanel({ token: SOL_MINT, network: 'solana' });
    expect(within(panel()).getByText(/nothing about this token has been measured/i)).toBeTruthy();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('refuses a mint that is not valid base58 rather than linking to it', () => {
    renderPanel({ token: '0xnot-a-mint', network: 'solana' });
    expect(within(panel()).getByText(/could not be read as an address/i)).toBeTruthy();
    expect(within(panel()).queryByRole('link')).toBeNull();
  });
});

describe('Base rows have no rail, and the panel does not pretend otherwise', () => {
  it('offers no buy at all', () => {
    renderPanel({ token: EVM_TOKEN, network: 'base', pool: EVM_POOL });
    expect(within(panel()).queryByRole('button', { name: /^buy$/i })).toBeNull();
    expect(within(panel()).getByText(/there is no\s+in-app buy here/i)).toBeTruthy();
  });

  it('offers the two reads that DO work there — a Base scan and the external pool page', () => {
    renderPanel({ token: EVM_TOKEN, network: 'base', pool: EVM_POOL });
    const scan = within(panel()).getByRole('link', { name: /holder distribution on Base/i });
    expect(scan.getAttribute('href')).toBe(`/scan?token=${EVM_TOKEN}&chain=base`);

    const external = within(panel()).getByRole('link', { name: /GeckoTerminal pool page \(external\)/i });
    expect(external.getAttribute('href')).toBe(
      `https://www.geckoterminal.com/base/pools/${EVM_POOL}`,
    );
    // An external link opened in a new tab without this is a tabnabbing hole.
    expect(external.getAttribute('rel')).toContain('noopener');
    expect(external.getAttribute('target')).toBe('_blank');
  });

  it('omits the external link entirely when the pool address is unreadable', () => {
    renderPanel({ token: EVM_TOKEN, network: 'base', pool: 'not-an-address' });
    expect(within(panel()).queryByRole('link', { name: /external/i })).toBeNull();
    // The scan link, which needs only the token, still stands.
    expect(within(panel()).getByRole('link', { name: /holder distribution on Base/i })).toBeTruthy();
  });

  it('never resolves a Base address against the Ethereum swap token list', () => {
    // Wrong-chain routing: the same 0x address is a different contract on Base,
    // and a match here would arm an approval against it.
    renderPanel({ token: EVM_TOKEN, network: 'base', pool: EVM_POOL });
    expect(within(panel()).queryByLabelText(/amount in/i)).toBeNull();
  });
});

describe('Ethereum rows keep the existing, unchanged path', () => {
  it('routes an unimported token to the verifying importer rather than around it', () => {
    // FE-HIGH-6: a token entering the swap state must have had its on-chain
    // symbol/decimals checked first, and TokenSelectModal is where that lives.
    renderPanel({ token: EVM_TOKEN, network: 'eth' });
    expect(within(panel()).getByText(/buy via trade after import/i)).toBeTruthy();
    const importer = within(panel()).getByRole('link', { name: /trade/i });
    expect(importer.getAttribute('href')).toBe('/swap');
    expect(within(panel()).queryByRole('button', { name: /^buy$/i })).toBeNull();
  });

  it('says in words that in-app buys route only already-imported tokens', () => {
    renderPanel({ token: EVM_TOKEN, network: 'eth' });
    expect(
      within(panel()).getByText(/route only tokens you have already imported and verified/i),
    ).toBeTruthy();
  });

  it('arms nothing before a row is selected', () => {
    renderPanel({ token: '' });
    expect(within(panel()).getByText(/select a row to load a buy/i)).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: /^buy$/i })).toBeNull();
  });
});

describe('the acknowledgement never contradicts the badge beside it', () => {
  const HIGH_RISK_PARTLY_READ: RowSafety = assessRowSafety({
    // excludedShareOfTotal became required on DistributionRead in the audit lane; this
    // fixture arrived from #360 before that landed, so the merge is where they meet.
    // 0 is the honest value for a fixture that excludes nothing.
    distribution: componentRead({ band: 'concentrated', confidence: 'high', firedGateIds: [], excludedShareOfTotal: 0 }),
    deployer: componentUnread('no creator lookup on this build'),
    heat: componentUnread('no heat'),
  });

  it('asks about the FINDINGS on a row wearing a red badge', () => {
    // FAILS on the pre-change component, whose branch order tested coverage
    // first and asked a trader to affirm that a high-risk row "carries no
    // safety result" — the softer of two contradictory sentences, beside a red
    // mark, on the screen where the decision is made.
    renderPanel({ token: SOL_MINT, network: 'solana', safety: HIGH_RISK_PARTLY_READ });
    const text = panel().textContent ?? '';
    expect(text).toMatch(/showed findings/i);
    expect(text).not.toMatch(/carries no safety result/i);
  });

  it('shows the red badge and the matching sentence together', () => {
    const { container } = renderPanel({
      token: SOL_MINT,
      network: 'solana',
      safety: HIGH_RISK_PARTLY_READ,
    });
    const badge = container.querySelector('[data-testid="safety-badge"]');
    expect(badge?.getAttribute('data-tone')).toBe('bad');
    expect(badge?.textContent).toMatch(/high risk \(partly unread\)/i);
  });

  it('shows no green mark on any chain, in any state this page can reach', () => {
    for (const props of [
      { token: EVM_TOKEN, network: 'eth' as const },
      { token: EVM_TOKEN, network: 'base' as const, pool: EVM_POOL },
      { token: SOL_MINT, network: 'solana' as const },
    ]) {
      const { container, unmount } = renderPanel({ ...props, safety: HIGH_RISK_PARTLY_READ });
      expect(container.querySelectorAll('[data-tone="good"]')).toHaveLength(0);
      unmount();
    }
  });
});
