// Whether the Solana swap page may send a trade to one of our pools. Web3-free, so the
// page reads it before any write code is fetched. Off: the page still compares our pools
// with Jupiter and says so, and every trade goes through Jupiter. Even on, a trade in our
// pool goes out only through the LP write layer's gate (mode 'on') and its own checks.

/** On from 2026-10-07 (owner: "wire up so our pool gets hit when its more efficient"). */
export const OWN_POOL_SWAPS: boolean = true;

/** What a trade in our pool pays in priority fee, at most: write/budget.ts's cap, pinned by a test. */
export const OWN_PRIORITY_CAP_LAMPORTS = 1_000_000n;
