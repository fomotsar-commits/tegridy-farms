/**
 * OUTAGE-AS-NOTHING-QUEUED — the NFT pool owner's timelock panel.
 *
 * PoolAdminPanel reads five values off the pool. `paused` was already honest
 * (`boolean | null`, "Unknown — paused() could not be read"). The four timelock
 * reads were not:
 *
 *     const pendingSpotAfter = state?.[2]?.status === 'success' ? Number(…) : 0;
 *     const spotPending = pendingSpotAfter > 0;
 *
 * 0 is the contract's own "nothing queued" (TegridyNFTPool.sol:543/550), so a
 * failed read HID a pending, timelocked price change from the one person able to
 * cancel it, and swapped Execute/Cancel for a Propose form whose submit reverts
 * ExistingProposalPending while that proposal sits there. And with the schedule
 * read but the VALUE not, the panel printed "Pending → 0" and armed Execute on a
 * change the owner could not see.
 *
 * Both directions are pinned. The cheap fix — treat a read 0 as unknown — would
 * lock the owner out of proposing anything on an idle pool.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../../test-utils/wagmi-mocks';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { PoolAdminPanel } from './AMMSection';

const POOL = '0x2222222222222222222222222222222222222222' as const;
const nowSec = () => Math.floor(Date.now() / 1000);

function stub(functionName: string, result: unknown) {
  wagmiMock.setReadResult({ functionName, result });
}
function fail(functionName: string) {
  wagmiMock.setReadResult({ functionName, result: undefined, status: 'failure' });
}

/** Every read landed, nothing queued: an idle pool. */
function stubIdle() {
  stub('paused', false);
  stub('pendingSpotPrice', 0n);
  stub('pendingSpotPriceExecuteAfter', 0n);
  stub('pendingDelta', 0n);
  stub('pendingDeltaExecuteAfter', 0n);
}
/** A 2 ETH spot-price change, queued and already past its 24h timelock. */
function queueSpotReady() {
  stub('pendingSpotPrice', parseEther('2'));
  stub('pendingSpotPriceExecuteAfter', BigInt(nowSec() - 60));
}
/** A 0.5 ETH delta change, queued and already past its timelock. */
function queueDeltaReady() {
  stub('pendingDelta', parseEther('0.5'));
  stub('pendingDeltaExecuteAfter', BigInt(nowSec() - 60));
}

function renderPanel() {
  render(
    <PoolAdminPanel
      poolAddress={POOL}
      poolType={0}
      spotPrice={parseEther('1')}
      delta={parseEther('0.1')}
      feeBps={0n}
      ethBalance={0n}
      onChange={() => {}}
    />,
  );
}
/** The Spot Price / Delta control card. */
function card(label: 'Spot Price' | 'Delta') {
  const el = screen.getByText(label).closest('.rounded-lg');
  if (!el) throw new Error(`no card for ${label}`);
  return within(el as HTMLElement);
}

beforeEach(() => wagmiMock.reset());

describe('PoolAdminPanel — timelock reads UNREAD', () => {
  it('does not offer Propose when it could not read whether a spot change is queued', () => {
    // OLD: pendingSpotPriceExecuteAfter collapsed to 0 → "nothing queued" → the
    // Propose form, over a change that IS queued. Its submit reverts
    // ExistingProposalPending, and the owner never learns a change is pending.
    stubIdle();
    queueSpotReady();
    fail('pendingSpotPriceExecuteAfter');
    renderPanel();

    const spot = card('Spot Price');
    expect(spot.queryByRole('button', { name: /propose/i })).toBeNull();
    expect(spot.queryByRole('button', { name: /execute/i })).toBeNull();
    expect(spot.getByTestId('spot-schedule-unread')).toHaveTextContent(/could not be read/i);
  });

  it('does not state what Execute would set when the queued spot value was not read', () => {
    // OLD: pendingSpotPrice collapsed to 0n → "Pending → 0", and Execute was
    // ARMED (the schedule had landed and elapsed) on a value nobody saw.
    stubIdle();
    queueSpotReady();
    fail('pendingSpotPrice');
    renderPanel();

    const spot = card('Spot Price');
    expect(spot.getByText(/^Pending →/)).toHaveTextContent('Pending → –');
    expect(spot.getByRole('button', { name: /execute/i })).toBeDisabled();
    // Cancel is the safe direction — the schedule says something IS queued, and
    // withdrawing it needs no value. Not discriminating: enabled before and after.
    expect(spot.getByRole('button', { name: /cancel/i })).toBeEnabled();
  });

  it('gives the delta timelock the same treatment, independently of spot', () => {
    // OLD: same collapse at index [4]. Spot, read fine, must be unaffected.
    stubIdle();
    queueDeltaReady();
    fail('pendingDeltaExecuteAfter');
    renderPanel();

    const delta = card('Delta');
    expect(delta.queryByRole('button', { name: /propose/i })).toBeNull();
    expect(delta.getByTestId('delta-schedule-unread')).toBeInTheDocument();
    expect(card('Spot Price').getByRole('button', { name: /propose/i })).toBeInTheDocument();
  });

  it('does not state what Execute would set when the queued delta value was not read', () => {
    stubIdle();
    queueDeltaReady();
    fail('pendingDelta');
    renderPanel();

    const delta = card('Delta');
    expect(delta.getByText(/^Pending →/)).toHaveTextContent('Pending → –');
    expect(delta.getByRole('button', { name: /execute/i })).toBeDisabled();
  });
});

describe('PoolAdminPanel — timelock reads GENUINE', () => {
  // NOT DISCRIMINATING against the old code — identical before and after. They
  // fail if the fix is ever widened into treating a READ 0 as unknown.
  it('an idle pool (a read 0) offers Propose and claims nothing is unknown', () => {
    stubIdle();
    renderPanel();

    expect(card('Spot Price').getByRole('button', { name: /propose/i })).toBeInTheDocument();
    expect(card('Delta').getByRole('button', { name: /propose/i })).toBeInTheDocument();
    expect(screen.queryByTestId('spot-schedule-unread')).toBeNull();
    expect(screen.queryByTestId('delta-schedule-unread')).toBeNull();
  });

  it('a fully read, elapsed change shows its value and arms Execute', () => {
    stubIdle();
    queueSpotReady();
    renderPanel();

    const spot = card('Spot Price');
    expect(spot.getByText(/^Pending →/)).toHaveTextContent(/Pending → 2/);
    expect(spot.getByRole('button', { name: /execute/i })).toBeEnabled();
  });
});
