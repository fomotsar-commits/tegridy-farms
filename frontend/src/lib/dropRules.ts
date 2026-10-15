import { keccak256, toBytes, toFunctionSelector, type Address, type Hex } from 'viem';

/**
 * Which rules an NFT collection (a TegridyDropV2 clone) runs, read from its code.
 *
 *  - 'needs-new-price': the template with the 2026-10-14 fixes (pull request 799).
 *    Opening an auction sets the fixed price to 0, and an allowlist or public sale
 *    cannot open again until a new price has waited its 24 hours
 *    (`fixedPriceNeedsProposal`).
 *  - 'instant-switch': the template deployed today, 0xA35ec3e20C4361144b0D99573DEa00B67873e872.
 *    Price, allowlist and auction changes wait 24 hours, but the phase can switch a
 *    sale between a fixed price and an auction in one step.
 *
 * Both have the same propose / execute / cancel functions; only the switch differs.
 */
export type DropRules = 'needs-new-price' | 'instant-switch';

/** The template the live launchpad clones today (read on chain 2026-10-14, 21,554 bytes). */
export const DEPLOYED_DROP_TEMPLATE: Address = '0xA35ec3e20C4361144b0D99573DEa00B67873e872';

/** Timelock keys, as the contract computes them (TegridyDropV2.sol, the same on the deployed template). */
export const DROP_TIMELOCK_KEYS = {
  mintPrice: keccak256(toBytes('DROP_MINT_PRICE_CHANGE_V2')),
  dutchAuction: keccak256(toBytes('DROP_DUTCH_CONFIG_CHANGE_V2')),
  merkleRoot: keccak256(toBytes('DROP_MERKLE_ROOT_CHANGE_VB')),
} as const;

/** Every drop proposal waits this long, and expires this long after it is ready. */
export const DROP_PROPOSAL_DELAY_SECONDS = 24 * 60 * 60;
export const DROP_PROPOSAL_VALIDITY_SECONDS = 7 * 24 * 60 * 60;

// EIP-1167 minimal proxy: the code every launchpad clone carries.
const CLONE_HEAD = '363d3d373d3d3d363d73';
const CLONE_TAIL = '5af43d82803e903d91602b57fd5bf3';

/** The template a clone delegates to, or null when the code is not a minimal proxy. */
export function cloneImplementation(code: Hex): Address | null {
  const body = code.toLowerCase().replace(/^0x/, '');
  if (body.length !== CLONE_HEAD.length + 40 + CLONE_TAIL.length) return null;
  if (!body.startsWith(CLONE_HEAD) || !body.endsWith(CLONE_TAIL)) return null;
  return `0x${body.slice(CLONE_HEAD.length, CLONE_HEAD.length + 40)}`;
}

// The dispatcher compares the call's selector with PUSH4 <selector> for each function.
const NEW_PRICE_FLAG = `63${toFunctionSelector('fixedPriceNeedsProposal()').slice(2)}`;

/** The rules of a template, from its runtime code. */
export function rulesFromCode(code: Hex): DropRules {
  return code.toLowerCase().includes(NEW_PRICE_FLAG) ? 'needs-new-price' : 'instant-switch';
}

/** Where a timelocked change stands, from its `proposalExecuteAfter` (0 = none pending). */
export type ProposalState = 'none' | 'waiting' | 'ready' | 'expired';
export function proposalState(executeAfter: bigint, nowSeconds: number): ProposalState {
  if (executeAfter === 0n) return 'none';
  const now = BigInt(Math.floor(nowSeconds));
  if (now < executeAfter) return 'waiting';
  if (now > executeAfter + BigInt(DROP_PROPOSAL_VALIDITY_SECONDS)) return 'expired';
  return 'ready';
}

/** Fixed-price phases (allowlist, public) and the auction phase, as `mintPhase` numbers them. */
export const FIXED_PRICE_PHASES = [1, 2] as const;
export const AUCTION_PHASE = 3;

/** A live sale switching straight between a fixed price and an auction: the panel closes it first. */
export function isPricingModeSwitch(fromPhase: number, toPhase: number): boolean {
  const fixed = (p: number) => (FIXED_PRICE_PHASES as readonly number[]).includes(p);
  return (fixed(fromPhase) && toPhase === AUCTION_PHASE) || (fromPhase === AUCTION_PHASE && fixed(toPhase));
}
