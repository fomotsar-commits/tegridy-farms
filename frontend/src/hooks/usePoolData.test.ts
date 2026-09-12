import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { parseEther, formatEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

// Sonner: not used by usePoolData but keep the pattern symmetrical in case
// of transitive imports.
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { usePoolData } from './usePoolData';
import { TEGRIDY_STAKING_ADDRESS } from '../lib/constants';

const USER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;

describe('usePoolData', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  it('defaults to zero-formatted strings when no reads are stubbed', () => {
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalStaked).toBe('0');
    expect(result.current.totalStakedRaw).toBe(0n);
    expect(result.current.totalBoostedStake).toBe('0');
    expect(result.current.rewardRate).toBe('0');
    expect(result.current.totalRewardsFunded).toBe('0');
    expect(result.current.totalPenalties).toBe('0');
    expect(result.current.apr).toBe('0');
    expect(result.current.aprCapped).toBe(false);
  });

  it('isDeployed is true for the canonical staking address', () => {
    const { result } = renderHook(() => usePoolData());
    expect(result.current.isDeployed).toBe(true);
  });

  it('aprDisclaimer is the fixed display string', () => {
    const { result } = renderHook(() => usePoolData());
    // Copy updated with the bootstrap-rate framing on outlier APRs
    // (was "Current rate, subject to change").
    expect(result.current.aprDisclaimer).toBe('Bootstrap rate — falls as staking grows');
  });

  it('isLoading propagates as a boolean', () => {
    const { result } = renderHook(() => usePoolData());
    // The wagmi mock returns isLoading: false for useReadContracts.
    expect(typeof result.current.isLoading).toBe('boolean');
    expect(result.current.isLoading).toBe(false);
  });

  it('propagates totalStaked from the read batch (raw + formatted)', () => {
    const staked = 1234n * 10n ** 18n;
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: staked });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalStakedRaw).toBe(staked);
    expect(result.current.totalStaked).toBe('1234');
  });

  it('propagates totalBoostedStake and rewardRate as formatted ether', () => {
    // totalLocked was dropped from the hook: the deployed staking contract has
    // no totalLocked() (2026-05-30 EIP-170 golf), so the read always reverted
    // and the field could only ever be '0'.
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: parseEther('500') });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: parseEther('0.1') });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalBoostedStake).toBe('500');
    expect(result.current.rewardRate).toBe('0.1');
  });

  it('propagates totalRewardsFunded and totalPenalties as formatted ether', () => {
    wagmiMock.setReadResult({ functionName: 'totalRewardsFunded', result: parseEther('1000000') });
    wagmiMock.setReadResult({ functionName: 'totalPenaltiesCollected', result: parseEther('42.5') });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalRewardsFunded).toBe('1000000');
    expect(result.current.totalPenalties).toBe('42.5');
  });

  it('falls back to 0 when individual reads return failure', () => {
    // Stack: success then failure — last match wins per findRead().
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: parseEther('100') });
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: 0n, status: 'failure' });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalStaked).toBe('0');
    expect(result.current.totalStakedRaw).toBe(0n);
  });

  it('apr is 0 when rewardRate is 0 (no reward flow)', () => {
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: parseEther('1000') });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 0n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe('0');
    expect(result.current.aprCapped).toBe(false);
  });

  it('apr is 0 when totalBoostedStake is 0 (avoids div-by-zero)', () => {
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: parseEther('1') });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 0n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe('0');
    expect(result.current.aprCapped).toBe(false);
  });

  it('computes apr correctly for a realistic reward/stake ratio', () => {
    // rewardRate = 1 wei/sec vs boosted stake of 31_536_000 wei.
    // APR = rewardRate * secs_per_year / totalBoostedStake = 1.0 (i.e. 100%).
    // Formatted with 2 decimals: "100.00".
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 1n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 31_536_000n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe('100.00');
    expect(result.current.aprNum).toBe(100);
    expect(result.current.aprCapped).toBe(false);
  });

  it('computes a small apr with preserved precision (scaling by 1e18)', () => {
    // rewardRate = 1 wei/sec, totalBoostedStake = 31_536_000 * 100 = 3_153_600_000
    // APR = 1%  → "1.00"
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 1n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 3_153_600_000n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe('1.00');
    expect(result.current.aprNum).toBe(1);
    expect(result.current.aprCapped).toBe(false);
  });

  it('renders a very large apr as a comma integer with no cap (operator decision 2026-06-07)', () => {
    // rewardRate=100 wei/s, boostedStake=31_536_000 wei → APR = exactly 10,000%.
    // Post-2026-06-07 the hook shows the REAL APR (comma integer), not a ">9999" cap,
    // and exposes the numeric aprNum so consumers never parseFloat the comma string.
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 100n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 31_536_000n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe((10000).toLocaleString());
    expect(result.current.aprNum).toBe(10000);
    expect(result.current.aprCapped).toBe(false);
  });

  it('scopes reads to the TEGRIDY_STAKING_ADDRESS contract', () => {
    // A stub matched to a different address must not affect this hook.
    wagmiMock.setReadResult({
      functionName: 'totalStaked',
      address: '0x0000000000000000000000000000000000000001',
      result: parseEther('9999'),
    });
    // A stub for the real staking address should be picked up.
    wagmiMock.setReadResult({
      functionName: 'totalStaked',
      address: TEGRIDY_STAKING_ADDRESS,
      result: parseEther('7'),
    });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalStaked).toBe('7');
  });

  it('totalStaked handles fractional ether correctly via formatEther', () => {
    const raw = parseEther('0.000123');
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: raw });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalStaked).toBe(formatEther(raw));
    expect(result.current.totalStakedRaw).toBe(raw);
  });
});

// THE RESERVE ARITHMETIC, WHICH HAD NO COVERAGE AT ALL.
//
// `rewardsRemaining`, `secondsRemaining`, `isDry` and the `haveReads` that
// gated all three were untested before this block — grep the 15 tests above for
// any of those names and there are no hits. The formula is
// `balanceOf(staking) − totalStaked − totalUnsettledRewards`, three separate
// reads, and the flag that claimed to guard it (`stakingBalance > 0n`) checked
// only the first one, and only that it was non-zero rather than that it landed.
describe('usePoolData — an unread reserve is not an empty one', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  /** A healthy pool: 6.0M staked, 6.4M held, 400k of real reward reserve. */
  function stubHealthyReserve() {
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: parseEther('6000000') });
    wagmiMock.setReadResult({ functionName: 'totalUnsettledRewards', result: 0n });
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: parseEther('6400000') });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: parseEther('0.0713') });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: parseEther('6000000') });
  }

  it('reads the true reserve when every leg lands', () => {
    stubHealthyReserve();
    const { result } = renderHook(() => usePoolData());
    expect(result.current.reserveUnread).toBe(false);
    expect(result.current.rewardsRemaining).toBe(formatEther(parseEther('400000')));
    expect(result.current.isDry).toBe(false);
  });

  it('does NOT advertise staker principal as reward reserve', () => {
    // THE EXPENSIVE ONE. balanceOf lands, totalStaked does not. The old
    // `haveReads = stakingBalance > 0n` was TRUE here, totalStaked collapsed to
    // 0n, and `balance − 0 − unsettled` handed back the contract's entire
    // holdings — 6.4M instead of 400k, a 16x overstatement of the reward pool,
    // made of other people's principal. It passes every `> 0` hedge downstream
    // because it is large and plausible, which is why no surface caught it.
    stubHealthyReserve();
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: 0n, status: 'failure' });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.reserveUnread).toBe(true);
    expect(result.current.rewardsRemaining).not.toBe(formatEther(parseEther('6400000')));
    expect(result.current.rewardsRemaining).toBe('0');
    // And it must not swing to the opposite lie either: unread is not empty.
    expect(result.current.isDry).toBe(false);
  });

  it('an unread balance is not an empty reserve', () => {
    stubHealthyReserve();
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: 0n, status: 'failure' });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.reserveUnread).toBe(true);
    expect(result.current.isDry).toBe(false);
  });

  it('an unread unsettled-rewards leg poisons the subtraction too', () => {
    // The third operand. It was never checked by anything.
    stubHealthyReserve();
    wagmiMock.setReadResult({ functionName: 'totalUnsettledRewards', result: 0n, status: 'failure' });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.reserveUnread).toBe(true);
  });

  it('a GENUINELY empty reserve still reports dry — the collapse is not the bug', () => {
    // The house convention keeps the zero; what it adds is the ability to tell
    // this case apart from the one above. Both used to render identically.
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: parseEther('6000000') });
    wagmiMock.setReadResult({ functionName: 'totalUnsettledRewards', result: 0n });
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: parseEther('6000000') });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: parseEther('0.0713') });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: parseEther('6000000') });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.reserveUnread).toBe(false);
    expect(result.current.rewardsRemaining).toBe('0');
    expect(result.current.isDry).toBe(true);
  });

  it('a read reserve over an UNREAD RATE is not "period ended"', () => {
    // THE LEG THE FIRST PASS MISSED. secondsRemaining = rewardsRemaining /
    // rewardRate, so it straddles both axes: the reserve legs can land
    // perfectly and an unread rewardRate still drives it to 0. TokenomicsPage's
    // "Emissions End In" tile gated on reserveUnread alone, so it went on
    // printing the SENTENCE "Period ended" — the same claim that sends a locked
    // staker into a 25% early-withdrawal penalty on a farm that is still paying.
    stubHealthyReserve();
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 0n, status: 'failure' });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.aprUnread).toBe(true);
    expect(result.current.reserveUnread).toBe(false);
    // The reserve itself read fine...
    expect(result.current.rewardsRemaining).toBe(formatEther(parseEther('400000')));
    // ...but the runway derived from it is not a fact, and now says so.
    expect(result.current.secondsRemaining).toBe(0);
    expect(result.current.runwayUnread).toBe(true);
  });

  it('runwayUnread is also true when the reserve is the dark half', () => {
    stubHealthyReserve();
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: 0n, status: 'failure' });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.runwayUnread).toBe(true);
  });

  it('a fully-read pool has a runway', () => {
    stubHealthyReserve();
    const { result } = renderHook(() => usePoolData());
    expect(result.current.runwayUnread).toBe(false);
    expect(result.current.secondsRemaining).toBeGreaterThan(0);
  });

  it('an unread APR leg is separate from the reserve', () => {
    // Deliberately independent: a dark rewardRate must not blank a runway that
    // was read fine, and a dark reserve must not blank a real APR.
    stubHealthyReserve();
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 0n, status: 'failure' });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.aprUnread).toBe(true);
    expect(result.current.reserveUnread).toBe(false);
  });

  it('an unread totalBoostedStake is an unread APR', () => {
    stubHealthyReserve();
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 0n, status: 'failure' });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.aprUnread).toBe(true);
  });

  // OFF MAINNET A FAILED LEG IS STILL A FAILED LEG.
  //
  // `batchRan` was `isDeployed && onMainnet && !isLoading`, copied from the
  // `enabled` gate this batch carried at the time. #514 (f7452f99) deleted that
  // gate -- useChainId() follows the wallet under the multichain config and wagmi
  // persists it through a disconnect, so a visitor last on Base had every read
  // DISABLED and /farm printed a "0%" APR as fact -- and dropped the same term
  // from useLPFarming's unread flags for the same reason. This flag is the one
  // that was left behind. With the reads running off mainnet and `batchRan`
  // still false there, `entryUnread` answered "read fine" for every entry
  // nobody had read: the exact partial failure the block above exists to catch,
  // reachable again by switching network.
  //
  // MUTATION CHECK: put `&& onMainnet` back on `batchRan` and the two failure
  // cases below go false and fail. Each pins a flag through its OWN clause --
  // `reserveUnread` off entry [0], `aprUnread` off entry [2] -- because
  // `runwayUnread` is their union and would be carried by either one.
  describe.each([['Base', 8453], ['Robinhood Chain', 4663]] as const)(
    'a wallet on %s',
    (_label, chainId) => {
      it('reports an unread reserve leg as unread, not as a read reserve', () => {
        stubHealthyReserve();
        wagmiMock.setReadResult({ functionName: 'totalStaked', result: 0n, status: 'failure' });
        wagmiMock.setChainId(chainId);
        const { result } = renderHook(() => usePoolData());
        expect(result.current.reserveUnread).toBe(true);
        // The figure the silence published: balance - 0 - 0, every staker's
        // principal offered as reward reserve, 16x the real 400k.
        expect(result.current.rewardsRemaining).not.toBe(formatEther(parseEther('6400000')));
        expect(result.current.rewardsRemaining).toBe('0');
        expect(result.current.runwayUnread).toBe(true);
      });

      it('reports an unread rate as an unread APR, not "period ended"', () => {
        stubHealthyReserve();
        wagmiMock.setReadResult({ functionName: 'rewardRate', result: 0n, status: 'failure' });
        wagmiMock.setChainId(chainId);
        const { result } = renderHook(() => usePoolData());
        expect(result.current.aprUnread).toBe(true);
        // Its own clause, not the reserve's: those three legs landed.
        expect(result.current.reserveUnread).toBe(false);
        expect(result.current.runwayUnread).toBe(true);
      });

      it('still reports a fully-read pool as read — the fix does not blank the chain', () => {
        // The other direction. Dropping the term must not turn every off-mainnet
        // visitor into an outage: the reads are pinned to CHAIN_ID, they land,
        // and the report matches what mainnet reports.
        stubHealthyReserve();
        wagmiMock.setChainId(chainId);
        const { result } = renderHook(() => usePoolData());
        expect(result.current.reserveUnread).toBe(false);
        expect(result.current.aprUnread).toBe(false);
        expect(result.current.runwayUnread).toBe(false);
        expect(result.current.rewardsRemaining).toBe(formatEther(parseEther('400000')));
        expect(result.current.secondsRemaining).toBeGreaterThan(0);
      });
    },
  );
});
