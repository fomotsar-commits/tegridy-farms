// Exclusion registry + address classification.
//
// RUN ORDER MATTERS: concentration math must only see real holders, so every
// address is classified and the structural buckets (LP/CEX/bridge/burn/locker/
// contract/PDA) are removed BEFORE any metric is computed. An address we cannot
// place is marked `unclassified` and KEPT — the honest-framing rule is that an
// unlabeled large wallet lowers our confidence, it is NOT assumed hostile.
//
// EXTENSIBILITY: the core ships only a minimal built-in registry (burn / dead /
// incinerator addresses). Richer labels — Etherscan tags, CEX/bridge lists,
// on-chain code checks, locker allow-lists — plug in as `LabelSource`s an
// adapter passes at call time. Nothing here reaches the network.

import type {
  ChainKind,
  ClassifiedHolder,
  Classification,
  HolderCategory,
  LabelContext,
  LabelSource,
  RawHolder,
} from './types';
import { EXCLUDED_CATEGORIES } from './types';
import { ratio, sumBalances } from './metrics';

/**
 * Built-in burn / dead / incinerator addresses (lowercased). Tokens sent here
 * are provably unspendable, so they are never "held" by anyone. Kept tiny on
 * purpose — everything else comes from pluggable label sources.
 */
export const BURN_ADDRESSES: ReadonlySet<string> = new Set<string>([
  // EVM
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  // Solana incinerator
  '1nc1nerator11111111111111111111111111111111',
]);

/** True iff `address` is a known burn/dead/incinerator sink. */
export function isBurnAddress(address: string): boolean {
  return BURN_ADDRESSES.has(address.toLowerCase());
}

/**
 * Group raw holders into one entry per economic owner and merge their flags.
 *
 * Solana wallets hold via Associated Token Accounts (ATAs); a single owner can
 * have several. When `ownerAddress` is present we key by owner so those ATAs
 * count once. EVM holders have no `ownerAddress`, so each address stands alone.
 * Flags are merged conservatively (OR of behavioral flags; first explicit label
 * wins; `offCurve`/`isContract` OR'd) and `bundledBalance` is summed.
 */
export function normalizeHolders(holders: readonly RawHolder[]): RawHolder[] {
  const byKey = new Map<string, RawHolder>();
  for (const h of holders) {
    if (h.balance <= 0n) continue; // dust / zeroed accounts never affect shares
    const key = (h.ownerAddress ?? h.address).toLowerCase();
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        address: h.ownerAddress ?? h.address,
        balance: h.balance,
        ownerAddress: h.ownerAddress ?? null,
        offCurve: h.offCurve ?? false,
        isContract: h.isContract ?? false,
        label: h.label ?? null,
        clusterId: h.clusterId ?? null,
        bundled: h.bundled ?? false,
        bundledBalance: h.bundledBalance,
        sniper: h.sniper ?? false,
      });
      continue;
    }
    prev.balance += h.balance;
    prev.offCurve = prev.offCurve || (h.offCurve ?? false);
    prev.isContract = prev.isContract || (h.isContract ?? false);
    prev.label = prev.label ?? h.label ?? null;
    prev.clusterId = prev.clusterId ?? h.clusterId ?? null;
    prev.bundled = prev.bundled || (h.bundled ?? false);
    prev.sniper = prev.sniper || (h.sniper ?? false);
    if (h.bundledBalance != null) prev.bundledBalance = (prev.bundledBalance ?? 0n) + h.bundledBalance;
  }
  return [...byKey.values()];
}

function excludedFor(category: HolderCategory): boolean {
  return EXCLUDED_CATEGORIES.has(category);
}

function reasonFor(category: HolderCategory): string {
  switch (category) {
    case 'lp':
      return 'Liquidity-pool / AMM contract — pool inventory, not a holder.';
    case 'cex':
      return 'Centralized-exchange wallet — custodial supply for many users.';
    case 'bridge':
      return 'Cross-chain bridge — supply in transit, not an end holder.';
    case 'burn':
      return 'Burn / dead address — supply is provably unspendable.';
    case 'locker':
      return 'Lock / vesting / treasury contract — time-locked, not freely held.';
    case 'contract':
      return 'Smart contract with no holder label — excluded from person concentration.';
    case 'pda':
      return 'Solana program-derived address (off-curve) — program-owned, not a wallet.';
    case 'unclassified':
      return 'Large wallet with no available label — counted, but lowers data-confidence.';
    case 'eoa':
      return 'Externally-owned wallet — counted as a holder.';
  }
}

/**
 * Classify one address. Priority (highest first):
 *   1. explicit adapter `label`
 *   2. structural flags (`offCurve` ⇒ PDA)
 *   3. pluggable label sources (first non-null wins)
 *   4. built-in burn registry
 *   5. heuristic: has contract code ⇒ `contract`
 *   6. default: `eoa`, promoted to `unclassified` when it is a large unlabeled wallet
 */
export function classifyAddress(
  holder: RawHolder,
  shareOfTotal: number,
  chain: ChainKind,
  labelSources: readonly LabelSource[],
  unclassifiedThreshold: number,
  /**
   * AUDIT FIX TF-024: share at or above which the low-confidence `contract`
   * heuristic stops being allowed to EXCLUDE a holder. Defaults to the same
   * 0.5 the score gate uses for `hardTop1Threshold`, so a holder big enough to
   * decide the verdict on its own cannot be removed on a guess.
   */
  heuristicExclusionCap = 0.5,
): Classification {
  // 1. explicit label from the adapter / feed
  if (holder.label) {
    return {
      category: holder.label,
      excluded: excludedFor(holder.label),
      confidence: 'high',
      source: 'input-label',
      reason: reasonFor(holder.label),
    };
  }

  // 2. structural: Solana off-curve address is a PDA
  if (holder.offCurve) {
    return { category: 'pda', excluded: true, confidence: 'high', source: 'structural', reason: reasonFor('pda') };
  }

  // 3. pluggable label sources
  const ctx: LabelContext = { chain, shareOfTotal, isContract: holder.isContract };
  for (const src of labelSources) {
    const cat = src.classify(holder.address, ctx);
    if (cat) {
      return {
        category: cat,
        excluded: excludedFor(cat),
        confidence: 'high',
        source: 'label-source',
        reason: reasonFor(cat),
      };
    }
  }

  // 4. built-in burn registry
  if (isBurnAddress(holder.address)) {
    return { category: 'burn', excluded: true, confidence: 'high', source: 'registry', reason: reasonFor('burn') };
  }

  // 5. heuristic: EVM contract code, no better label.
  //
  // AUDIT FIX TF-024: this label is a GUESS — `confidence: 'low'`,
  // `source: 'heuristic'`, no label source claimed the address — and a guess
  // does not get to DELETE a holder large enough to decide the verdict on its
  // own. Pre-fix, parking 99% of supply in any deployer-controlled contract
  // (a bare contract with a `transfer` costs a few dollars of gas) removed it
  // from the denominator entirely, and the remaining dust read as
  // "Well-distributed" — the single strongest signal this scanner emits,
  // inverted by the cheapest possible action.
  //
  // At or above the cap it falls through to step 6 and is KEPT as
  // `unclassified`, which is already exactly what this file says an unlabeled
  // dominant address means. An address a label source actually named (step 3)
  // is unaffected: that is evidence, not a guess.
  if (holder.isContract && shareOfTotal < heuristicExclusionCap) {
    return {
      category: 'contract',
      excluded: true,
      confidence: 'low',
      source: 'heuristic',
      reason: reasonFor('contract'),
    };
  }

  // 6. default wallet. A LARGE unlabeled wallet is `unclassified` (kept, lowers
  //    confidence); a small one is a plain `eoa`. Never assumed hostile.
  if (shareOfTotal >= unclassifiedThreshold) {
    return {
      category: 'unclassified',
      excluded: false,
      confidence: 'low',
      source: 'default',
      reason: reasonFor('unclassified'),
    };
  }
  return { category: 'eoa', excluded: false, confidence: 'low', source: 'default', reason: reasonFor('eoa') };
}

/**
 * Normalize, then classify every holder against `totalSupply`. Returns the full
 * classified set (both kept and excluded) plus the split, so callers can both
 * run metrics over `included` AND disclose exactly what was removed.
 */
export function classifyHolders(params: {
  holders: readonly RawHolder[];
  totalSupply: bigint;
  chain: ChainKind;
  labelSources: readonly LabelSource[];
  unclassifiedThreshold: number;
  /** AUDIT FIX TF-024 — see `classifyAddress`. Defaults to the gate's 0.5. */
  heuristicExclusionCap?: number;
}): {
  totalSupply: bigint;
  classified: ClassifiedHolder[];
  included: RawHolder[];
  excluded: RawHolder[];
} {
  const normalized = normalizeHolders(params.holders);
  // Total supply defaults to the sum of holder balances when the caller did not
  // provide an authoritative on-chain total.
  const totalSupply = params.totalSupply > 0n ? params.totalSupply : sumBalances(normalized);

  const classified: ClassifiedHolder[] = normalized.map((holder) => {
    const shareOfTotal = ratio(holder.balance, totalSupply);
    const classification = classifyAddress(
      holder,
      shareOfTotal,
      params.chain,
      params.labelSources,
      params.unclassifiedThreshold,
      params.heuristicExclusionCap,
    );
    return { holder, classification, shareOfTotal };
  });

  const included: RawHolder[] = [];
  const excluded: RawHolder[] = [];
  for (const c of classified) (c.classification.excluded ? excluded : included).push(c.holder);

  return { totalSupply, classified, included, excluded };
}
