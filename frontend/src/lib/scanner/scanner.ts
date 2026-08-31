// Public token scanner — orchestration + chain auto-detect + shared types.
//
// This is the glue over the PURE detection core (src/lib/detection). It does NOT
// reimplement any metric: an adapter fetches holders for a pasted address,
// normalizes them into the core's `RawHolder[]` + `HardFacts` + `LaunchFacts`
// shape, and this module hands that to `analyzeDistribution` and packages the
// descriptive-measurement result for the UI.
//
// HONEST-FRAMING CONTRACT (same as the core): nothing here fabricates data. When
// a holder source returns nothing, the adapter throws a typed `ScanError` and the
// UI self-gates to an "unavailable / unknown" state — never a made-up number. The
// result carries how many holders were actually enumerated and whether that is
// the FULL holder set or only the top-N, so a partial read is disclosed as a
// partial read (and, being the LARGEST holders, an UPPER BOUND on concentration).

import { analyzeDistribution, type DistributionAnalysis, type DistributionInput } from '../detection';

/**
 * Chains the scanner can read. 'ethereum' and 'solana' are auto-detectable
 * from address FORMAT; 'base' shares the 0x format with Ethereum, so it can
 * only arrive via an explicit `chainOverride` (UI toggle / caller knowledge).
 * The pure detection core stays typed to its own `ChainKind`
 * ('ethereum' | 'solana') — Base runs the core under EVM semantics (see
 * scanToken), only the outcome keeps the caller's chain for display.
 */
export type ScanChain = 'ethereum' | 'base' | 'solana';

/** EVM 0x-prefixed 40-hex address. */
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Base58 pubkey, 32–44 chars (excludes 0 O I l). Solana mint addresses. */
const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface ChainDetection {
  chain: ScanChain | null;
  /** Trimmed address as typed (checksum/case preserved; adapters lowercase as needed). */
  address: string;
  valid: boolean;
}

/**
 * Auto-detect the chain from an address's FORMAT alone (no network). An EVM
 * address is unambiguous (0x + 40 hex). Anything else that is valid base58 in the
 * 32–44 length window is treated as a Solana mint. Ambiguity is effectively nil:
 * a 0x string can never be valid Solana base58 (it contains no '0'... actually it
 * starts with '0x', and 'x' is base58 but the leading '0' is not), and a Solana
 * mint never starts with 0x.
 */
export function detectChain(raw: string): ChainDetection {
  const address = (raw ?? '').trim();
  if (ETH_ADDRESS_RE.test(address)) return { chain: 'ethereum', address, valid: true };
  if (SOL_ADDRESS_RE.test(address)) return { chain: 'solana', address, valid: true };
  return { chain: null, address, valid: false };
}

/** True iff `raw` is a well-formed token address for a chain the scanner reads. */
export function isValidTokenAddress(raw: string): boolean {
  return detectChain(raw).valid;
}

/** Token identity metadata an adapter resolved alongside the holders. Any field may be null. */
export interface TokenMeta {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  /** TOTAL number of holders on-chain, when the source reports it (ETH via explorer). Null on Solana top-N. */
  holdersCount: number | null;
}

/**
 * What a data adapter returns: the exact input to hand the detection core, plus
 * disclosure metadata about coverage. Adapters do the network I/O and the
 * normalization; they never compute metrics.
 */
export interface AdapterResult {
  input: DistributionInput;
  token: TokenMeta;
  /** How many distinct holders the source actually returned (post-normalization upper bound). */
  enumeratedHolders: number;
  /**
   * `full` = the complete holder set was enumerated. `top-n` = only the largest N
   * holders were read (Solana getTokenLargestAccounts caps at 20; the ETH explorer
   * route returns the top ~100). A `top-n` read is an UPPER BOUND on concentration.
   */
  holderCoverage: 'full' | 'top-n';
  /** Human label of where the data came from, shown in the method/timestamp line. */
  source: string;
}

/** The packaged scan the UI renders. */
export interface ScanOutcome {
  chain: ScanChain;
  address: string;
  token: TokenMeta;
  enumeratedHolders: number;
  holderCoverage: 'full' | 'top-n';
  source: string;
  analysis: DistributionAnalysis;
  /**
   * Scanner-level disclosures layered on top of the core's own `analysis.caveats`
   * (which describe the METHOD). These describe the DATA SOURCE's limits for this
   * particular read (partial enumeration, un-measured launch signals).
   */
  coverageNotes: string[];
}

/** Typed failure so the hook can distinguish "no data yet" from "you fat-fingered the address". */
export class ScanError extends Error {
  code: 'invalid-address' | 'unavailable' | 'not-found' | 'empty' | 'network' | 'rate-limited';
  constructor(code: ScanError['code'], message: string) {
    super(message);
    this.name = 'ScanError';
    this.code = code;
  }
}

/**
 * Build the coverage disclosures for a read. Kept pure so it is unit-testable and
 * consistent across chains. The UPPER-BOUND framing is the key honest-framing move:
 * when only the largest holders are seen, an un-enumerated tail can only DILUTE
 * concentration, so a "concentrated" verdict is a ceiling and a "well-distributed"
 * verdict is, if anything, conservative.
 */
export function buildCoverageNotes(r: {
  chain: ScanChain;
  holderCoverage: 'full' | 'top-n';
  enumeratedHolders: number;
  holdersCount: number | null;
  bundlesResolved: boolean;
  snipersResolved: boolean;
}): string[] {
  const notes: string[] = [];
  if (r.holderCoverage === 'top-n') {
    const total =
      r.holdersCount != null && r.holdersCount > r.enumeratedHolders
        ? ` of ${r.holdersCount.toLocaleString()} total holders`
        : '';
    notes.push(
      `Only the top ${r.enumeratedHolders}${total} were enumerated (a full holder index needs a dedicated indexer). These are the LARGEST holders, so the un-measured tail can only lower concentration — read a "concentrated" result as an upper bound.`,
    );
  }
  if (!r.bundlesResolved) {
    notes.push('Launch-bundle detection was not run for this read (needs launch-time transaction history) — the bundled-supply signal is a gap, not a zero.');
  }
  if (!r.snipersResolved) {
    notes.push('Sniper detection was not run for this read (needs launch-window trade history) — the sniper-held signal is a gap, not a zero.');
  }
  if (r.chain === 'base') {
    notes.push('Named-entity exclusion labels (CEX wallets, bridges, lockers) are Ethereum-curated and may not match Base addresses — on Base, non-person holders are excluded by their on-chain contract flag only. Unmatched pools can only OVERSTATE concentration, so read this as an upper bound.');
  }
  return notes;
}

/**
 * Run a scan end-to-end: pick the adapter for the detected chain, fetch + normalize
 * holders, then hand off to the PURE core. `fetchFor` is injectable so tests can
 * feed a synthetic adapter without touching the network.
 */
export async function scanToken(
  rawAddress: string,
  opts: {
    signal?: AbortSignal;
    chainOverride?: ScanChain;
    fetchFor: (chain: ScanChain, address: string, signal?: AbortSignal) => Promise<AdapterResult>;
    observedAt?: number;
  },
): Promise<ScanOutcome> {
  const detected = detectChain(rawAddress);
  const chain = opts.chainOverride ?? detected.chain;
  if (!chain || !detected.valid) {
    throw new ScanError('invalid-address', 'That does not look like an Ethereum (0x…) or Solana address.');
  }

  const adapter = await opts.fetchFor(chain, detected.address, opts.signal);
  if (adapter.enumeratedHolders === 0) {
    throw new ScanError('empty', 'No holder data was returned for this token.');
  }

  // The pure core knows 'ethereum' | 'solana'. Base is an EVM chain and runs
  // under the core's Ethereum semantics; its Ethereum-curated NAMED-entity
  // exclusion lists simply won't match Base addresses — the conservative
  // direction (pools counted as people OVERSTATE concentration, and the
  // top-n upper-bound framing already owns that), disclosed in the notes.
  const coreChain: 'ethereum' | 'solana' = chain === 'base' ? 'ethereum' : chain;
  const input: DistributionInput = {
    ...adapter.input,
    chain: coreChain,
    observedAt: opts.observedAt ?? adapter.input.observedAt,
  };
  const analysis = analyzeDistribution(input);

  const coverageNotes = buildCoverageNotes({
    chain,
    holderCoverage: adapter.holderCoverage,
    enumeratedHolders: adapter.enumeratedHolders,
    holdersCount: adapter.token.holdersCount,
    bundlesResolved: input.launch?.bundlesResolved ?? false,
    snipersResolved: input.launch?.snipersResolved ?? false,
  });

  return {
    chain,
    address: detected.address,
    token: adapter.token,
    enumeratedHolders: adapter.enumeratedHolders,
    holderCoverage: adapter.holderCoverage,
    source: adapter.source,
    analysis,
    coverageNotes,
  };
}
