// Turning raw reads into per-source reports — where every "we don't know" is decided.
//
// This module is pure so that the honesty rules are testable without a chain, a wallet,
// or a render. The hook above it does I/O and nothing else.
//
// ── The price gate ──────────────────────────────────────────────────────────────────
// The dashboard this replaces zeroed its ETH-denominated legs when the Chainlink ETH/USD
// feed went stale, and flagged it with a chip. That is a silent markdown: the portfolio
// number FALLS by the value of the user's ETH, and a chip beside it does not undo the
// fact that the headline figure is now a smaller number presented as a total. Here a
// stale mark produces `unpriced` — the leg leaves the sum and is named as excluded, so
// the total goes PARTIAL instead of quietly going down.
//
// Both marks come from the shared price context (`useTOWELIPrice`). No price source is
// introduced here; `PriceGate` is only the shape in which that hook's existing staleness
// flags are handed to the pure layer.
//
// ── What is deliberately NOT valued ─────────────────────────────────────────────────
// NFT holdings are counted and never marked. A floor price is not a price — it is the
// best bid on a thin book — and the only honest way to put JBAC into a dollar total is
// with a feed this venue does not have. Counting them and saying "unpriced" is worth
// more than a confident wrong number.

import type { PortfolioSourceReport } from './types';

/** Read-time marks handed in from the shared price context. */
export interface PriceGate {
  /** TOWELI/USD. Only read when `toweliPriceable`. */
  toweliUsd: number;
  /** ETH/USD (Chainlink). Only read when `ethPriceable`. */
  ethUsd: number;
  /** False when the TOWELI price is unavailable or is a stale cache echo. */
  toweliPriceable: boolean;
  /** False when the ETH/USD feed missed its heartbeat or answered out of band. */
  ethPriceable: boolean;
}

/**
 * One multicall batch's liveness. `asOf` is when its data last landed; `failed` means the
 * batch itself errored, which is different from an individual call reverting.
 */
export interface BatchLiveness {
  asOf: number | null;
  isLoading: boolean;
  failed: boolean;
}

/**
 * Amounts already converted out of wei by the hook. `null` means THAT CALL did not
 * return — never "zero". Preserving the distinction this far up is the whole point.
 */
export interface PortfolioSnapshot {
  connected: boolean;
  /** False when the wallet is on a chain whose balances are not this portfolio's subject. */
  onExpectedChain: boolean;
  price: PriceGate;
  /** Batch A — wallet balances, LP, farm, claimables, NFT counts. */
  base: BatchLiveness;
  /**
   * Batch B — the staking position, readable only after batch A yields the token id.
   * Structurally a round behind batch A; that lag is what the freshness spread reports.
   */
  position: BatchLiveness;
  wallet: { eth: number | null; toweli: number | null };
  staking: {
    /** True once batch A has established the wallet owns a staking NFT. */
    hasPosition: boolean;
    staked: number | null;
    pending: number | null;
    unsettled: number | null;
  };
  lp: { toweli: number | null; weth: number | null; pendingRewards: number | null };
  claimable: { revenueEth: number | null; referralEth: number | null };
  /** JBAC only — the one NFT collection whose address this build actually holds. */
  nft: { jbac: number | null };
}

const NO_ETH_MARK = 'the ETH/USD feed is stale, so this cannot be valued right now';
const NO_TOWELI_MARK = 'no TOWELI price is available, so this cannot be valued right now';

/** Batch state → the report state every leg on that batch must take, or null to proceed. */
function batchBlock(
  connected: boolean,
  onExpectedChain: boolean,
  batch: BatchLiveness,
): Pick<PortfolioSourceReport, 'state' | 'usd' | 'detail' | 'asOf'> | null {
  if (!connected) {
    return { state: 'unavailable', usd: null, detail: 'no wallet connected', asOf: null };
  }
  if (!onExpectedChain) {
    // A wrong-chain wallet has balances, just not the ones this portfolio is about.
    // Reporting them would price another chain's assets as if they were these.
    return { state: 'unavailable', usd: null, detail: 'wallet is on a different network', asOf: null };
  }
  if (batch.failed) {
    return { state: 'unavailable', usd: null, detail: 'the network read failed', asOf: null };
  }
  if (batch.asOf === null || batch.isLoading) {
    return { state: 'loading', usd: null, detail: 'still reading', asOf: null };
  }
  return null;
}

/** A leg whose own call did not return, on an otherwise healthy batch. */
function callFailed(asOf: number | null): Pick<PortfolioSourceReport, 'state' | 'usd' | 'detail' | 'asOf'> {
  return { state: 'unavailable', usd: null, detail: 'the contract call did not return', asOf };
}

/**
 * Build one report per source. Order is display order and is stable, so the source list
 * never reshuffles between polls.
 */
export function buildPortfolioSources(snap: PortfolioSnapshot): PortfolioSourceReport[] {
  const { price, base, position } = snap;
  const baseBlock = batchBlock(snap.connected, snap.onExpectedChain, base);

  // ── Wallet · ETH ──────────────────────────────────────────────────────────────────
  const walletEth: PortfolioSourceReport = {
    id: 'wallet-eth',
    label: 'ETH in wallet',
    ...(baseBlock ??
      (snap.wallet.eth === null
        ? callFailed(base.asOf)
        : !price.ethPriceable
          ? {
              state: 'unpriced' as const,
              usd: null,
              detail: `${snap.wallet.eth} ETH held — ${NO_ETH_MARK}`,
              asOf: base.asOf,
            }
          : { state: 'ok' as const, usd: snap.wallet.eth * price.ethUsd, asOf: base.asOf })),
  };

  // ── Wallet · TOWELI ───────────────────────────────────────────────────────────────
  const walletToweli: PortfolioSourceReport = {
    id: 'wallet-toweli',
    label: 'TOWELI in wallet',
    ...(baseBlock ??
      (snap.wallet.toweli === null
        ? callFailed(base.asOf)
        : !price.toweliPriceable
          ? {
              state: 'unpriced' as const,
              usd: null,
              detail: `${snap.wallet.toweli} TOWELI held — ${NO_TOWELI_MARK}`,
              asOf: base.asOf,
            }
          : { state: 'ok' as const, usd: snap.wallet.toweli * price.toweliUsd, asOf: base.asOf })),
  };

  // ── Staking position ──────────────────────────────────────────────────────────────
  // Unsettled rewards ride batch A (they are read by wallet address); staked + pending
  // ride batch B (read by token id). When the wallet owns no staking NFT there is no
  // batch B to wait for and the leg settles on batch A alone.
  const stakingBlock = baseBlock ?? (snap.staking.hasPosition
    ? batchBlock(snap.connected, snap.onExpectedChain, position)
    : null);
  const stakingAsOf = snap.staking.hasPosition ? position.asOf : base.asOf;
  const stakingLegs = snap.staking.hasPosition
    ? [snap.staking.staked, snap.staking.pending, snap.staking.unsettled]
    : [0, 0, snap.staking.unsettled];
  const staking: PortfolioSourceReport = {
    id: 'staking',
    label: 'Staked TOWELI + rewards',
    ...(stakingBlock ??
      (stakingLegs.some((v) => v === null)
        ? callFailed(stakingAsOf)
        : !price.toweliPriceable
          ? {
              state: 'unpriced' as const,
              usd: null,
              detail: `${stakingLegs[0]} staked, ${(stakingLegs[1] as number) + (stakingLegs[2] as number)} claimable TOWELI — ${NO_TOWELI_MARK}`,
              asOf: stakingAsOf,
            }
          : {
              state: 'ok' as const,
              usd: (stakingLegs as number[]).reduce((a, b) => a + b, 0) * price.toweliUsd,
              asOf: stakingAsOf,
            })),
  };

  // ── Liquidity ─────────────────────────────────────────────────────────────────────
  // Two-sided: the redeemable TOWELI half and the redeemable WETH half. If EITHER mark
  // is missing the whole leg is unpriced. Valuing the half we can price and dropping the
  // other would emit a number that is confidently, invisibly about half right.
  const lpAmounts = [snap.lp.toweli, snap.lp.weth, snap.lp.pendingRewards];
  const lp: PortfolioSourceReport = {
    id: 'lp',
    label: 'Liquidity position',
    ...(baseBlock ??
      (lpAmounts.some((v) => v === null)
        ? callFailed(base.asOf)
        : !price.toweliPriceable || !price.ethPriceable
          ? {
              state: 'unpriced' as const,
              usd: null,
              detail: `${snap.lp.toweli} TOWELI + ${snap.lp.weth} WETH redeemable — ${!price.ethPriceable ? NO_ETH_MARK : NO_TOWELI_MARK}`,
              asOf: base.asOf,
            }
          : {
              state: 'ok' as const,
              usd:
                (snap.lp.toweli as number) * price.toweliUsd +
                (snap.lp.weth as number) * price.ethUsd +
                (snap.lp.pendingRewards as number) * price.toweliUsd,
              asOf: base.asOf,
            })),
  };

  // ── Claimable ETH ─────────────────────────────────────────────────────────────────
  const claimAmounts = [snap.claimable.revenueEth, snap.claimable.referralEth];
  const claimable: PortfolioSourceReport = {
    id: 'claimable',
    label: 'Claimable ETH',
    ...(baseBlock ??
      (claimAmounts.some((v) => v === null)
        ? callFailed(base.asOf)
        : !price.ethPriceable
          ? {
              state: 'unpriced' as const,
              usd: null,
              detail: `${(snap.claimable.revenueEth as number) + (snap.claimable.referralEth as number)} ETH claimable — ${NO_ETH_MARK}`,
              asOf: base.asOf,
            }
          : {
              state: 'ok' as const,
              usd:
                ((snap.claimable.revenueEth as number) + (snap.claimable.referralEth as number)) *
                price.ethUsd,
              asOf: base.asOf,
            })),
  };

  // ── NFTs ──────────────────────────────────────────────────────────────────────────
  // Counted, never marked — see the header. A confirmed count of zero is a genuine zero
  // contribution and is allowed to be `ok`; anything held is `unpriced` forever, which is
  // the correct permanent state until a floor feed exists to change it.
  const nft: PortfolioSourceReport = {
    id: 'nft',
    label: 'JBAC NFTs',
    ...(baseBlock ??
      (snap.nft.jbac === null
        ? callFailed(base.asOf)
        : snap.nft.jbac === 0
          ? { state: 'ok' as const, usd: 0, detail: 'none held', asOf: base.asOf }
          : {
              state: 'unpriced' as const,
              usd: null,
              detail: `${snap.nft.jbac} held — this venue has no NFT price feed, and a collection floor is not a price`,
              asOf: base.asOf,
            })),
  };

  // ── Launched tokens ───────────────────────────────────────────────────────────────
  // Standing gap, not an outage. Valuing a wallet's holdings of tokens launched through
  // the rail needs a per-wallet token index; this build has none (docs/BATTLE_PLAN.md
  // #42 is where that lands). Declared here so the shortfall is stated on the surface
  // rather than inferred from its absence.
  const launched: PortfolioSourceReport = {
    id: 'launched-tokens',
    label: 'Launched tokens & other wallet assets',
    state: 'out-of-scope',
    usd: null,
    detail:
      'not tracked — this build has no per-wallet token index, so tokens launched through the rail, other ERC-20s, and other NFT collections are outside this total',
    asOf: null,
  };

  return [walletEth, walletToweli, staking, lp, claimable, nft, launched];
}
