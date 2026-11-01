import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex, type Log } from 'viem';
import { stakingClaimPaid, stakingStakeReturned } from './stakingClaimPaid';
import { TEGRIDY_STAKING_ADDRESS } from './constants';

const ABI = parseAbi([
  'event RewardPaid(address indexed user, uint256 indexed tokenId, uint256 reward)',
  'event UnsettledClaimed(address indexed user, uint256 amount)',
  'event RewardsForfeited(address indexed user, uint256 amount)',
]);
const USER = '0x9df0666AF7e7dC12792326F420A885cce9f4A0a5';

function log(eventName: 'RewardPaid' | 'UnsettledClaimed' | 'RewardsForfeited', value: bigint, address: string = TEGRIDY_STAKING_ADDRESS): Log {
  const topics = eventName === 'RewardPaid'
    ? encodeEventTopics({ abi: ABI, eventName, args: { user: USER, tokenId: 12n } })
    : encodeEventTopics({ abi: ABI, eventName, args: { user: USER } });
  return {
    address: address as Hex, topics: topics as [Hex, ...Hex[]], data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
  };
}

describe('stakingClaimPaid', () => {
  it('reads the paid amount off RewardPaid', () => {
    expect(stakingClaimPaid({ logs: [log('RewardPaid', 5n * 10n ** 18n)] })).toBe(5n * 10n ** 18n);
  });

  it('counts a claimUnsettled payout too', () => {
    expect(stakingClaimPaid({ logs: [log('UnsettledClaimed', 7n)] })).toBe(7n);
  });

  // The receipt mainnet gives today: getReward on position #12, reserve empty. The
  // claim "succeeded", paid nothing, and logged only RewardsForfeited.
  it('a read receipt with no payout is a measured zero, not a missing figure', () => {
    expect(stakingClaimPaid({ logs: [log('RewardsForfeited', 391_192_412_348_536_329_400_000n)] })).toBe(0n);
    expect(stakingClaimPaid({ logs: [] })).toBe(0n);
  });

  it('ignores a look-alike event from another contract', () => {
    expect(stakingClaimPaid({ logs: [log('RewardPaid', 9n, '0x0000000000000000000000000000000000000001')] })).toBe(0n);
  });

  it('no receipt is unknown, never zero', () => {
    expect(stakingClaimPaid(undefined)).toBeNull();
    expect(stakingClaimPaid(null)).toBeNull();
  });
});

const EXIT_ABI = parseAbi([
  'event Withdrawn(address indexed user, uint256 indexed tokenId, uint256 amount)',
  'event EarlyWithdrawn(address indexed user, uint256 indexed tokenId, uint256 amount, uint256 penalty)',
  'event EmergencyWithdraw(address indexed user, uint256 indexed tokenId, uint256 amount)',
  'event EmergencyExitPosition(address indexed user, uint256 indexed tokenId, uint256 amount)',
]);

function exitLog(
  eventName: 'Withdrawn' | 'EarlyWithdrawn' | 'EmergencyWithdraw' | 'EmergencyExitPosition',
  amount: bigint,
  address: string = TEGRIDY_STAKING_ADDRESS,
): Log {
  const topics = encodeEventTopics({ abi: EXIT_ABI, eventName, args: { user: USER, tokenId: 12n } });
  const data = eventName === 'EarlyWithdrawn'
    ? encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [amount, amount / 3n])
    : encodeAbiParameters([{ type: 'uint256' }], [amount]);
  return {
    address: address as Hex, topics: topics as [Hex, ...Hex[]], data,
    blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
  };
}

describe('stakingStakeReturned', () => {
  it('reads the paused exit (emergencyWithdrawPosition): the whole stake', () => {
    expect(stakingStakeReturned({ logs: [exitLog('EmergencyWithdraw', 1000n * 10n ** 18n)] })).toBe(1000n * 10n ** 18n);
  });

  it('reads the expired-lock exit, and ignores the reward it pays beside the stake', () => {
    expect(stakingStakeReturned({
      logs: [log('RewardPaid', 5n * 10n ** 18n), exitLog('EmergencyExitPosition', 300n * 10n ** 18n)],
    })).toBe(300n * 10n ** 18n);
  });

  it('reads withdraw, and an early exit NET of its penalty (what came back)', () => {
    expect(stakingStakeReturned({ logs: [exitLog('Withdrawn', 7n)] })).toBe(7n);
    expect(stakingStakeReturned({ logs: [exitLog('EarlyWithdrawn', 750n)] })).toBe(750n);
  });

  it('a receipt with no exit log is unknown, never zero', () => {
    expect(stakingStakeReturned({ logs: [] })).toBeNull();
    expect(stakingStakeReturned({ logs: [log('RewardPaid', 9n)] })).toBeNull();
  });

  it('ignores a look-alike exit from another contract', () => {
    expect(stakingStakeReturned({ logs: [exitLog('EmergencyWithdraw', 9n, '0x0000000000000000000000000000000000000001')] })).toBeNull();
  });

  it('no receipt is unknown', () => {
    expect(stakingStakeReturned(undefined)).toBeNull();
    expect(stakingStakeReturned(null)).toBeNull();
  });
});
