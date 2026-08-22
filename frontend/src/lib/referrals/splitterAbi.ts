// The ReferralSplitter reads this slice needs that lib/contracts.ts does not carry.
//
// Composed by spreading the shared REFERRAL_SPLITTER_ABI rather than restating
// it. The entries below are strictly ADDITIONAL — a duplicate would give viem
// two candidate fragments for one selector, and `abiHasNoDuplicateNames` in the
// test beside this file fails the build if one is ever introduced.
//
// Every entry here answers a question the earnings surface cannot honestly skip:
//
//   setupComplete            the whole contract is inert until this is true, and
//                            "inert" renders identically to "you earned nothing"
//   MIN_REFERRAL_STAKE_POWER the threshold below which a referee's fee is taken
//                            and given to the treasury instead of the referrer
//   stakingContract /        the two contracts the splitter itself sums voting
//   restakingContract        power from — read so the UI mirrors the contract's
//                            arithmetic rather than guessing at its inputs
//   bannedReferrers          a banned referrer earns nothing and claims nothing
//   referrerRegisteredAt     start of the 7-day MIN_REFERRAL_AGE claim lock
//   referralFeeBps           the actual carve, which is timelock-changeable

import { REFERRAL_SPLITTER_ABI } from '../contracts';

/** `votingPowerOf(address)` — the shape both the staking and restaking
 *  contracts expose, and the only method the splitter calls on either. */
export const VOTING_POWER_ABI = [
  {
    type: 'function',
    name: 'votingPowerOf',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

const EXTRA_SPLITTER_FRAGMENTS = [
  { type: 'function', name: 'setupComplete', inputs: [], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'MIN_REFERRAL_STAKE_POWER', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'MIN_REFERRAL_AGE', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'referralFeeBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'MAX_REFERRAL_FEE', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'stakingContract', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'restakingContract', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'bannedReferrers', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'referrerRegisteredAt', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalForfeited', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

export const REFERRAL_SPLITTER_FULL_ABI = [
  ...REFERRAL_SPLITTER_ABI,
  ...EXTRA_SPLITTER_FRAGMENTS,
] as const;

/** Names contributed by this file — the surface a duplicate test checks. */
export const EXTRA_SPLITTER_FUNCTION_NAMES = EXTRA_SPLITTER_FRAGMENTS.map((f) => f.name);
