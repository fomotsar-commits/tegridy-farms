/**
 * OUTAGE-AS-ZERO — the bounty board's "what are you owed" tiles and the Claim
 * control they arm.
 *
 * The defect these tests exist to keep dead:
 *
 *   const payoutBig = (pendingPayout as bigint) ?? 0n;
 *   const refundBig = (pendingRefund as bigint) ?? 0n;
 *
 * wagmi leaves `data` undefined for a read that FAILED, and `?? 0n` turned that
 * silence into a number. Two things followed from one unanswered RPC call:
 *
 *   1. "Your Pending Payout: 0.0000 ETH" rendered as settled fact, and
 *   2. the Claim block, gated on `payoutBig > 0n`, vanished with it —
 *      no button, no explanation.
 *
 * A user who WAS owed ETH was told they were owed none and given no control to
 * reach it. 0n is also the honest "the board owes you nothing", so the whole
 * job of the fix is to make those two states distinguishable on screen.
 *
 * Every test below therefore pins BOTH halves:
 *   UNREAD      — a failed read renders '–' (U+2013), never a figure, and arms
 *                 nothing; an explicit caveat says why.
 *   GENUINE ZERO — a successfully-read 0n is a real zero and still renders
 *                 "0.0000 ETH" exactly as it always did.
 *
 * The mock matters here: an unstubbed `useReadContract` resolves as
 * `data: undefined, isError: false` — that is "in flight", NOT "failed". A
 * failed read must be stubbed with `status: 'failure'` to set `isError`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
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

import { BountiesSection } from './BountiesSection';

/** The glyph the app uses for a figure nobody read. Spelled out so a stray
 *  hyphen-minus or em-dash in the source cannot quietly satisfy these tests. */
const DASH = '–';
/** The exact string the old code printed off a failed read. */
const FALSE_ZERO = /0\.0000 ETH/;

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const ONE_POINT_FIVE_ETH = 1_500_000_000_000_000_000n;

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'BountiesSection.tsx'),
  'utf-8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * A stat tile is a label <p> and a value <p> inside one wrapper div. Reading
 * the wrapper's textContent is what the user actually sees on that tile, and
 * keeps the payout tile's claim separate from the refund tile's.
 */
function tile(label: string): HTMLElement {
  const labelEl = screen.getByText(label);
  const wrapper = labelEl.parentElement;
  if (!wrapper) throw new Error(`stat tile "${label}" has no wrapper element`);
  return wrapper;
}

const payoutTile = () => tile('Your Pending Payout');
const refundTile = () => tile('Your Pending Refund');

const claimButton = (kind: 'payout' | 'refund') =>
  screen.queryByRole('button', { name: new RegExp(`^claim .* eth ${kind}$`, 'i') });

/** Keep the bounty LIST out of the way — 0 bounties, list resolved, no
 *  getBounty reads. These specs are about the payout/refund tiles only. */
function stubQuietList() {
  wagmiMock.setReadResult({ functionName: 'bountyCount', result: 0n });
  wagmiMock.setReadResult({ functionName: 'totalBountiesPosted', result: 3n });
  wagmiMock.setReadResult({ functionName: 'totalPaidOut', result: 0n });
}

describe('BountiesSection — a failed payout read is not a zero balance', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(1); // === CHAIN_ID, so _ensureChain() is not the thing under test
    stubQuietList();
  });

  // ── UNREAD: the figure ───────────────────────────────────────────────────
  it('renders the dash, not "0.0000 ETH", when pendingPayouts fails to read', () => {
    wagmiMock.setAccount({ address: WALLET, isConnected: true });
    wagmiMock.setReadResult({ functionName: 'pendingPayouts', result: undefined, status: 'failure' });
    wagmiMock.setReadResult({ functionName: 'pendingRefund', result: 0n });

    renderWithProviders(<BountiesSection />);

    // OLD: `undefined ?? 0n` -> formatWei(0n) -> "0.0000 ETH" on the tile.
    // NEW: isError -> '–'.
    expect(payoutTile().textContent).toContain(DASH);
    expect(payoutTile().textContent).not.toMatch(FALSE_ZERO);
  });

  // ── UNREAD: the control ──────────────────────────────────────────────────
  it('arms no Claim control off an unread balance, and says why instead of implying nothing is owed', () => {
    wagmiMock.setAccount({ address: WALLET, isConnected: true });
    wagmiMock.setReadResult({ functionName: 'pendingPayouts', result: undefined, status: 'failure' });
    wagmiMock.setReadResult({ functionName: 'pendingRefund', result: undefined, status: 'failure' });

    renderWithProviders(<BountiesSection />);

    // The discriminating half: OLD collapsed both reads to 0n, hid the Claim
    // block, and rendered NO explanation at all — this element did not exist.
    const caveat = screen.getByTestId('bounties-claims-unread');
    expect(caveat).toBeInTheDocument();
    expect(caveat.textContent).toMatch(/could not read/i);

    // The must-not-arm half: nothing signable may hang off a figure nobody read.
    expect(claimButton('payout')).toBeNull();
    expect(claimButton('refund')).toBeNull();
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  // ── GENUINE ZERO vs UNREAD, side by side in ONE render ───────────────────
  it('distinguishes a read 0 from an unread balance in the same render', () => {
    wagmiMock.setAccount({ address: WALLET, isConnected: true });
    // The board genuinely owes this wallet no payout...
    wagmiMock.setReadResult({ functionName: 'pendingPayouts', result: 0n });
    // ...and the refund read did not answer.
    wagmiMock.setReadResult({ functionName: 'pendingRefund', result: undefined, status: 'failure' });

    renderWithProviders(<BountiesSection />);

    // GENUINE ZERO: unchanged from before the fix. A fix that turned real zeros
    // into "unavailable" would be a new bug, and this is the assertion that
    // catches it.
    expect(payoutTile().textContent).toMatch(FALSE_ZERO);
    expect(payoutTile().textContent).not.toContain(DASH);

    // UNREAD: OLD printed "0.0000 ETH" here too — the two states were literally
    // the same pixels. NEW they differ.
    expect(refundTile().textContent).toContain(DASH);
    expect(refundTile().textContent).not.toMatch(FALSE_ZERO);

    // The property, stated directly: read-zero and unread are not the same tile.
    expect(payoutTile().textContent).not.toEqual(
      refundTile().textContent!.replace('Refund', 'Payout'),
    );

    // The unread refund is announced; a real 0 payout is not dressed up as one.
    expect(screen.getByTestId('bounties-claims-unread')).toBeInTheDocument();
    expect(claimButton('payout')).toBeNull(); // genuinely owed nothing
    expect(claimButton('refund')).toBeNull(); // unknown — must not arm
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  // ── The fix must not OVER-gate: one failed read may not disarm the other ──
  it('still arms the payout Claim when only the refund read fails', () => {
    wagmiMock.setAccount({ address: WALLET, isConnected: true });
    wagmiMock.setReadResult({ functionName: 'pendingPayouts', result: ONE_POINT_FIVE_ETH });
    wagmiMock.setReadResult({ functionName: 'pendingRefund', result: undefined, status: 'failure' });

    renderWithProviders(<BountiesSection />);

    // A landed, non-zero payout is still claimable — the caveat is additive,
    // not a blanket kill switch.
    const btn = claimButton('payout');
    expect(btn).not.toBeNull();
    expect(btn).not.toBeDisabled();
    expect(payoutTile().textContent).toMatch(/1\.5000 ETH/);

    // OLD: the failed refund read became 0n and this element never rendered.
    expect(screen.getByTestId('bounties-claims-unread')).toBeInTheDocument();
    // The unread side stays unarmed and undeclared.
    expect(claimButton('refund')).toBeNull();
    expect(refundTile().textContent).toContain(DASH);
    expect(refundTile().textContent).not.toMatch(FALSE_ZERO);
  });

  // ── A visitor who never asked is not a failed read ───────────────────────
  it('shows the dash — not a fabricated zero, and not a failure caveat — with no wallet connected', () => {
    // No setAccount: the payout/refund reads are `enabled: !!address`, so they
    // were never attempted.
    renderWithProviders(<BountiesSection />);

    // OLD: undefined data -> 0n -> "Your Pending Payout: 0.0000 ETH" to a
    // visitor whose balance was never even queried.
    expect(payoutTile().textContent).toContain(DASH);
    expect(payoutTile().textContent).not.toMatch(FALSE_ZERO);
    expect(refundTile().textContent).toContain(DASH);
    expect(refundTile().textContent).not.toMatch(FALSE_ZERO);

    // Nothing failed, so nothing alarming: a not-attempted read is not an outage.
    expect(screen.queryByTestId('bounties-claims-unread')).toBeNull();
  });

  // ── HAPPY PATH: the fix changes nothing for a landed, non-zero balance ───
  it('renders and fires the Claim button for a real non-zero payout', () => {
    wagmiMock.setAccount({ address: WALLET, isConnected: true });
    wagmiMock.setReadResult({ functionName: 'pendingPayouts', result: ONE_POINT_FIVE_ETH });
    wagmiMock.setReadResult({ functionName: 'pendingRefund', result: 0n });

    renderWithProviders(<BountiesSection />);

    expect(payoutTile().textContent).toMatch(/1\.5000 ETH/);
    // The genuinely-zero refund keeps its real zero, and arms no button.
    expect(refundTile().textContent).toMatch(FALSE_ZERO);
    expect(refundTile().textContent).not.toContain(DASH);
    expect(screen.queryByTestId('bounties-claims-unread')).toBeNull();
    expect(claimButton('refund')).toBeNull();

    const btn = claimButton('payout');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);

    const writeContract = wagmiMock.writeContract();
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract.mock.calls[0]![0]).toMatchObject({ functionName: 'withdrawPayout' });
  });
});

describe('BountiesSection — the coalesce cannot come back', () => {
  // The defect was one operator. Pin its absence directly so a future edit
  // cannot reintroduce it through a route the DOM specs above do not cover
  // (the `handleClaim` fail-closed gate, for instance, is unreachable from the
  // UI precisely because the button is already gated on a landed read).
  it('never coalesces an unread balance to 0n', () => {
    expect(SRC).not.toMatch(/\?\?\s*0n/);
    expect(SRC).not.toMatch(/pendingPayout\s+as\s+bigint/);
    expect(SRC).not.toMatch(/pendingRefund\s+as\s+bigint/);
  });

  it('reads the error flag off both owed-balance reads', () => {
    expect(SRC).toMatch(/isError:\s*payoutReadFailed/);
    expect(SRC).toMatch(/isError:\s*refundReadFailed/);
  });
});
