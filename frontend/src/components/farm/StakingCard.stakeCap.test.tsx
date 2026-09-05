/**
 * OUTAGE-AS-ZERO — StakingCard's per-wallet stake cap.
 *
 * The card reads `maxStakePerUser` off TegridyStaking and used to collapse the
 * read into a number with `?? 0n`:
 *
 *     const maxStakeWei = (maxStakeRaw as bigint | undefined) ?? 0n;
 *     const overCap = maxStakeWei > 0n && stakeWei > maxStakeWei;
 *     const stakeBlocked = overCap || belowMin;
 *
 * Both readers were written `maxStakeWei > 0n && …`, so the zero that stood in
 * for "we could not read it" was taken to mean "there is no cap at all". An RPC
 * hiccup therefore DISARMED the one guard between the user and a stake the
 * contract rejects with PerUserStakeCapExceeded — gas spent, nothing staked —
 * and the "Balance:" shortcut filled the whole wallet on the way in.
 *
 * The fix keeps unknown unknown (`bigint | null`) and fails CLOSED: the CTA
 * refuses to arm on a cap nobody read, and says so.
 *
 * Both halves are pinned here, because the cheap version of this fix — treating
 * every 0 as an outage — is a new bug of its own:
 *   - UNREAD  (failed read): CTA disabled, named "Stake cap unknown", caveat shown.
 *   - GENUINE ZERO (a landed 0n): a REAL cap of zero. Still disabled, but named
 *     "Max 0 per wallet", the figure renders as `0` rather than the unknown
 *     em-dash, and the outage caveat is ABSENT.
 *
 * Per-test, what the UNPATCHED code did is recorded in the test body.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useState, type ComponentProps } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';
import { StakingCard, type ConfirmState, type StakeInputState } from './StakingCard';
import { LOCK_OPTIONS } from '../../lib/constants';

type CardProps = ComponentProps<typeof StakingCard>;

const noop = () => {};

/** Big enough that "fill from balance" is a genuinely dangerous suggestion. */
const WALLET_BALANCE = '250000';
/** The testing-phase cap the contract actually carries. */
const REAL_CAP_WEI = 50_000n * 10n ** 18n;

/**
 * Stands in for FarmPage: the card does not own the amount, so a test that
 * clicks "Balance:" needs the parent's state round-trip to observe anything.
 * `amtNum` is derived exactly as FarmPage.tsx:151 derives it.
 */
function Harness({ initialAmount = '' }: { initialAmount?: string }) {
  const [amount, setAmount] = useState(initialAmount);
  const amtNum = parseFloat(amount) || 0;

  const pos = {
    hasPosition: false,
    positionUnread: false,
    isLoading: false,
    isLocked: false,
    autoMaxLock: false,
    canWithdraw: false,
    isPaused: false,
    lockEnd: 0,
    tokenId: 0n,
    accrualPerSec: 0,
    boostMultiplier: 1,
    pendingFormatted: '0',
    pendingLive: 0,
    stakedFormatted: '0',
    unsettledFormatted: '0',
    walletBalanceFormatted: WALLET_BALANCE,
    refetchAll: noop,
  };
  const actions = {
    claim: noop, claimUnsettled: noop, earlyWithdraw: noop, emergencyExit: noop,
    extendLock: noop, withdraw: noop, revalidateBoost: noop, toggleAutoMaxLock: noop,
    stake: noop, approve: noop, isConfirming: false, isPending: false,
  };
  const input: StakeInputState = {
    amount, setAmount,
    lock: LOCK_OPTIONS[0]!, setLock: noop,
    extendLockDuration: LOCK_OPTIONS[0]!, setExtendLockDuration: noop,
  };
  const confirms: ConfirmState = {
    withdraw: false, earlyWithdraw: false, emergencyExit: false,
    extendLock: false, autoMaxLock: false,
  };

  return (
    <StakingCard
      isConnected
      pos={pos as unknown as CardProps['pos']}
      actions={actions as unknown as CardProps['actions']}
      nft={{ holdsJBAC: false } as unknown as CardProps['nft']}
      input={input}
      confirms={confirms}
      setConfirm={noop}
      pool={{ apr: '100', aprNum: 100, isDeployed: true }}
      computed={{
        boostDisplay: '1.00', totalBoostBps: 10_000, amtNum,
        effectiveStake: amtNum, stakeNeedsApproval: false,
      }}
      handleStake={noop}
      lastActionRef={{ current: null }}
      submittedAmountRef={{ current: null }}
    />
  );
}

/** The "Max … TOWELI per wallet · min 100" line — one <p>, several text nodes. */
function capLine(): HTMLElement {
  return screen.getByText(
    (_content, el) => el?.tagName === 'P' && /TOWELI per wallet/.test(el.textContent ?? ''),
  );
}

const amountField = () => screen.getByLabelText(/amount of toweli to stake/i);
const balanceShortcut = () => screen.getByRole('button', { name: /^Balance:/i });
/** The submit CTA is the only button here whose name is not "Balance: …". */
const armedStakeCta = () => screen.queryByRole('button', { name: /stake & lock/i });

/** `data: undefined` from a read that ran and failed — NOT a zero. */
function stubCapUnread() {
  wagmiMock.setReadResult({ functionName: 'maxStakePerUser', result: undefined, status: 'failure' });
}
function stubCapRead(value: bigint) {
  wagmiMock.setReadResult({ functionName: 'maxStakePerUser', result: value });
}

beforeEach(() => wagmiMock.reset());

describe('StakingCard — per-wallet stake cap: UNREAD', () => {
  it('does not arm the CTA when the cap read failed', () => {
    // OLD: maxStakeWei = 0n, so `overCap` was `0n > 0n && …` = false and
    // `stakeBlocked` was false — the CTA was ENABLED and read
    // "Stake & Lock for 7 Days" on a 60,000 stake nobody had checked.
    // NEW: maxStakeWei === null → stakeBlocked, CTA disabled, name says so.
    stubCapUnread();
    renderWithProviders(<Harness />);

    fireEvent.change(amountField(), { target: { value: '60000' } });

    const cta = screen.getByRole('button', { name: /stake cap unknown/i });
    expect(cta).toBeDisabled();
    // The failed read must not present as a definite, safe number.
    expect(armedStakeCta()).toBeNull();
  });

  it('says the cap is unknown rather than implying there is none', () => {
    // OLD: this element did not exist in any state — the card silently showed
    // an em-dash and let the form proceed. NEW: an explicit outage caveat.
    stubCapUnread();
    renderWithProviders(<Harness />);

    const caveat = screen.getByTestId('stake-cap-unread');
    expect(caveat).toBeInTheDocument();
    expect(caveat).toHaveTextContent(/could not read the per-wallet cap/i);
    // And it must not be mistaken for "there is no cap".
    expect(caveat).toHaveTextContent(/not a statement that there is no cap/i);
  });

  it('does not let the Balance shortcut walk the user into an armed CTA', () => {
    // The fill VALUE is unchanged by the fix (an unread cap still falls back to
    // the wallet balance) — what changed is that the CTA no longer arms behind it.
    // OLD: clicking "Balance:" filled 250000 and the CTA became a live
    // "Stake & Lock for 7 Days" — a guaranteed PerUserStakeCapExceeded revert.
    // NEW: same fill, CTA still refuses to arm.
    stubCapUnread();
    renderWithProviders(<Harness />);

    fireEvent.click(balanceShortcut());

    expect(amountField()).toHaveValue(WALLET_BALANCE);
    expect(armedStakeCta()).toBeNull();
    expect(screen.getByRole('button', { name: /stake cap unknown/i })).toBeDisabled();
  });
});

describe('StakingCard — per-wallet stake cap: GENUINE ZERO', () => {
  it('treats a successfully read 0n as a real cap of zero', () => {
    // OLD: `overCap = maxStakeWei > 0n && …` was false for a landed 0n, so a
    // real cap of zero was read as "uncapped" — CTA ENABLED, "Stake & Lock for
    // 7 Days", straight into the contract's own revert.
    // NEW: overCap is true for any positive amount → "Max 0 per wallet".
    stubCapRead(0n);
    renderWithProviders(<Harness initialAmount="1000" />);

    const cta = screen.getByRole('button', { name: /max 0 per wallet/i });
    expect(cta).toBeDisabled();
    expect(armedStakeCta()).toBeNull();
  });

  it('reports a real 0 as a figure, never as an outage', () => {
    // OLD: `maxStakeDisplay = maxStakeWei > 0n ? format(…) : '—'` — a landed 0n
    // rendered the SAME em-dash as a failed read, i.e. a real value was
    // reported as "we do not know". NEW: the read figure, '0'.
    stubCapRead(0n);
    renderWithProviders(<Harness initialAmount="1000" />);

    expect(capLine()).toHaveTextContent('Max 0 TOWELI per wallet');
    expect(capLine().textContent).not.toContain('—');
    // A successful read is not an outage: no caveat.
    expect(screen.queryByTestId('stake-cap-unread')).toBeNull();
  });
});

describe('StakingCard — per-wallet stake cap: a cap that was read', () => {
  // NOT DISCRIMINATING against the old code — under/over a real, non-zero cap
  // the two versions behave identically. Kept as the other guard rail: it fails
  // if the fail-closed change is ever widened into blocking every stake.
  it('still gates exactly as before on a real 50,000 cap', () => {
    stubCapRead(REAL_CAP_WEI);
    const { unmount } = renderWithProviders(<Harness initialAmount="1000" />);

    expect(screen.getByRole('button', { name: /stake & lock for 7 days/i })).toBeEnabled();
    expect(screen.queryByTestId('stake-cap-unread')).toBeNull();
    expect(capLine()).toHaveTextContent('Max 50000 TOWELI per wallet');
    unmount();

    renderWithProviders(<Harness initialAmount="60000" />);
    expect(screen.getByRole('button', { name: /max 50000 per wallet/i })).toBeDisabled();
    expect(armedStakeCta()).toBeNull();
  });
});
