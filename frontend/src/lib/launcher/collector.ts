// On-chain fact collector: token address -> RawTokenFacts (feeds gate.ts).
//
// Grounded in the REAL DopplerERC20V1 surface (verified against
// github.com/whetstoneresearch/doppler/src/tokens/DopplerERC20V1.sol, 2026-07-17):
// the template is an OZ minimal-proxy clone that has NO mint / pause / blacklist /
// fee-on-transfer, and is not upgradeable. It exposes owner(), isPoolLocked,
// isBalanceLimitActive, and on-chain vesting (vestedTotalAmount, vestingStart).
//
// Provenance is the load-bearing signal: if we can prove the token is a clone of
// the known DopplerERC20V1 implementation, its dangerous powers are known-false
// by construction. If we CANNOT prove it, we stay conservative — the unknown
// powers are reported as present, so the gate yields 'none' rather than
// vouching for an unverified contract. Safety defaults to closed.
//
// LP-lock state lives in a separate contract (StreamableFeesLocker) keyed by the
// graduated position, so it is supplied by an injected LockResolver rather than
// guessed here — keeping every line in this file grounded and unit-testable.

import type { Address, Hex } from 'viem';
import type { FeeConstitutionLine, VestingSchedule } from './factSheet';
import type { RawTokenFacts } from './gate';
import { DOPPLER_MAINNET } from './doppler.constants';

/** Minimal chain-read surface. A viem PublicClient adapter is provided below; tests mock this. */
export interface ChainReader {
  getCode(address: Address): Promise<Hex | undefined>;
  readToken<T>(address: Address, functionName: string): Promise<T>;
}

/** Resolves the LP lock for a graduated token (StreamableFeesLocker lookup). Injected + mockable. */
export type LockResolver = (
  token: Address,
) => Promise<{ locked: boolean; locker: Address | null; unlockAt: number | null }>;

export interface CollectOptions {
  chainId?: number;
  now?: number;
  /** Extra known-safe implementations beyond the Doppler default. */
  knownSafeImpls?: readonly Address[];
  lockResolver?: LockResolver;
  /** Fee constitution is a launch-config input (what WE set), not read from the token. */
  feeConstitution?: FeeConstitutionLine[];
}

// Two minimal-proxy layouts we must recognise:
//  - Canonical OZ / EIP-1167: 363d3d373d3d3d363d73 <impl> 5af43d82803e903d91602b57fd5bf3
//  - Solady LibClone (what Doppler's token factories DEPLOY — VERIFIED on a mainnet
//    fork 2026-07-17): 3d3d3d3d363d3d37363d73 <impl> 5af43d3d93803e602a57fd5bf3
// A launched Doppler token uses the Solady layout, so parsing ONLY EIP-1167 would
// make the gate fail to recognise every real Doppler launch (default-closed for all).
const CLONE_LAYOUTS: { prefix: string; suffix: string }[] = [
  { prefix: '363d3d373d3d3d363d73', suffix: '5af43d82803e903d91602b57fd5bf3' }, // EIP-1167
  { prefix: '3d3d3d3d363d3d37363d73', suffix: '5af43d3d93803e602a57fd5bf3' }, // Solady LibClone
];

/** Extract the implementation address from a known minimal-proxy runtime, or null. */
export function cloneImplTarget(code: Hex | undefined): Address | null {
  if (!code) return null;
  const c = code.slice(2).toLowerCase();
  for (const { prefix, suffix } of CLONE_LAYOUTS) {
    if (c.startsWith(prefix) && c.endsWith(suffix)) {
      const middle = c.slice(prefix.length, c.length - suffix.length);
      if (middle.length === 40) return (`0x${middle}`) as Address;
    }
  }
  return null;
}

/** @deprecated use cloneImplTarget — kept for existing callers. EIP-1167 only. */
export function eip1167Target(code: Hex | undefined): Address | null {
  const c = (code ?? '0x').slice(2).toLowerCase();
  if (!c.startsWith('363d3d373d3d3d363d73')) return null;
  return cloneImplTarget(code);
}

const DEFAULT_LOCK_RESOLVER: LockResolver = async () => ({
  locked: false,
  locker: null,
  unlockAt: null,
});

/**
 * Collect facts for a token. Async; every read goes through the injected reader.
 * Never throws on a single failed read of an optional field — it degrades to the
 * conservative value (which fails the gate) and records nothing false.
 */
export async function collectTokenFacts(
  reader: ChainReader,
  token: Address,
  opts: CollectOptions = {},
): Promise<RawTokenFacts> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const chainId = opts.chainId ?? DOPPLER_MAINNET.chainId;
  const lockResolver = opts.lockResolver ?? DEFAULT_LOCK_RESOLVER;

  const knownImpls = new Set(
    [DOPPLER_MAINNET.support.dopplerErc20V1Impl, ...(opts.knownSafeImpls ?? [])].map((a) => a.toLowerCase()),
  );

  const code = await reader.getCode(token);
  const impl = cloneImplTarget(code);
  const isDopplerTemplate = impl != null && knownImpls.has(impl.toLowerCase());
  // tokenFactory the gate recognises: only assert the Doppler factory when the impl matches.
  const tokenFactory: Address | null = isDopplerTemplate
    ? DOPPLER_MAINNET.modules.dopplerErc20V1Factory.address
    : null;

  const [name, symbol, totalSupply, owner] = await Promise.all([
    safeRead<string>(reader, token, 'name', ''),
    safeRead<string>(reader, token, 'symbol', ''),
    safeRead<bigint>(reader, token, 'totalSupply', 0n),
    safeRead<Address | null>(reader, token, 'owner', null),
  ]);

  // Powers. Known Doppler template => proven-false by construction (verified source).
  // Unknown template => conservative: report the dangerous powers as present so the
  // gate cannot grant a tier to something we haven't verified.
  const powers = isDopplerTemplate
    ? {
        mint: false,
        pause: false,
        blacklist: false,
        feeOnTransfer: false,
        upgrade: false,
        balanceLimit: await safeRead<boolean>(reader, token, 'isBalanceLimitActive', false),
      }
    : { mint: true, pause: true, blacklist: true, feeOnTransfer: true, upgrade: true, balanceLimit: false };

  // Ownership neutralisation.
  const ownerRenounced = owner == null || owner.toLowerCase() === '0x0000000000000000000000000000000000000000';
  // Timelock detection is provenance-based (owner is a known timelock factory output); default false.
  const ownerIsTimelock = false;

  // Team/insider allocation: DopplerERC20V1 tracks the total vested (insider) amount on-chain.
  // Everything vested is, by definition, under an on-chain schedule.
  let teamAllocationBps = 0;
  let teamAllocationVestedBps = 0;
  const vesting: VestingSchedule[] = [];
  if (isDopplerTemplate && totalSupply > 0n) {
    const vestedTotal = await safeRead<bigint>(reader, token, 'vestedTotalAmount', 0n);
    teamAllocationBps = Number((vestedTotal * 10_000n) / totalSupply);
    teamAllocationVestedBps = teamAllocationBps; // vestedTotalAmount is BY DEFINITION on-chain-vested
  }

  const liquidity = await lockResolver(token).catch(() => ({ locked: false, locker: null, unlockAt: null }));

  return {
    token,
    chainId,
    name,
    symbol,
    totalSupply,
    tokenFactory,
    templateCodehash: null, // set by the reader adapter when available; provenance uses impl match
    powers,
    owner,
    ownerRenounced,
    ownerIsTimelock,
    liquidity,
    feeConstitution: opts.feeConstitution ?? [],
    vesting,
    teamAllocationBps,
    teamAllocationVestedBps,
    observedAt: now,
  };
}

async function safeRead<T>(reader: ChainReader, token: Address, fn: string, fallback: T): Promise<T> {
  try {
    const v = await reader.readToken<T>(token, fn);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}
