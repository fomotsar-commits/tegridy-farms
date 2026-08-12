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
) => Promise<{ locked: boolean; locker: Address | null; unlockAt: number | null; readable?: boolean }>;

export interface CollectOptions {
  chainId?: number;
  now?: number;
  /** Extra known-safe implementations beyond the Doppler default. */
  knownSafeImpls?: readonly Address[];
  lockResolver?: LockResolver;
  /** Fee constitution is a launch-config input (what WE set), not read from the token. */
  feeConstitution?: FeeConstitutionLine[];
}

// `cloneImplTarget` and its CLONE_LAYOUTS moved to api/_lib/record-core.js so the
// browser collector and the serverless birth-record route agree on what a Doppler clone
// is. Two copies would drift, and the drift would be silent on one rail — the Solady
// layout is the one Doppler actually deploys, and missing it makes every real launch
// look unverified. Re-exported here so every existing caller is untouched.
import { cloneImplTarget } from '../../../api/_lib/record-core.js';
export { cloneImplTarget };

/** @deprecated use cloneImplTarget — kept for existing callers. EIP-1167 only. */
export function eip1167Target(code: Hex | undefined): Address | null {
  const c = (code ?? '0x').slice(2).toLowerCase();
  if (!c.startsWith('363d3d373d3d3d363d73')) return null;
  return cloneImplTarget(code);
}

// Reads NOTHING. `readable: false` says so, so callers that publish prose (and the
// on-chain disclosures digest) render "not read" instead of "not locked" — the latter
// being an assertion this resolver is in no position to make.
const DEFAULT_LOCK_RESOLVER: LockResolver = async () => ({
  locked: false,
  locker: null,
  unlockAt: null,
  readable: false,
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

  // WHICH reads actually landed. `safeRead` degrades a failure to a conservative fallback,
  // which is right for the GATE (it cannot grant a tier off a value nobody read) but wrong for
  // a page that publishes prose: an unread `owner` becomes `null` becomes "Ownership
  // renounced.", which is not merely unknown but INVERTED for a token that has a live owner.
  // Callers that render statements must consult this and say "not read" instead.
  const unread = new Set<string>();

  const [name, symbol, totalSupply, owner] = await Promise.all([
    safeRead<string>(reader, token, 'name', '', unread),
    safeRead<string>(reader, token, 'symbol', '', unread),
    safeRead<bigint>(reader, token, 'totalSupply', 0n, unread),
    safeRead<Address | null>(reader, token, 'owner', null, unread),
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

  // A THROWN resolver read nothing either — `readable: false`, same as the default.
  // Without it a failed locker read would be indistinguishable from a successful read
  // that found no lock, and the sheet would publish "not locked" on the strength of an
  // exception.
  const liquidity = await lockResolver(token).catch(() => ({
    locked: false,
    locker: null,
    unlockAt: null,
    readable: false,
  }));

  return {
    token,
    chainId,
    unreadFields: [...unread],
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

async function safeRead<T>(
  reader: ChainReader,
  token: Address,
  fn: string,
  fallback: T,
  unread?: Set<string>,
): Promise<T> {
  try {
    const v = await reader.readToken<T>(token, fn);
    // A null/undefined answer is NOT the same as a successful read of a real value: a
    // contract without the method, and an RPC that dropped the call, both land here.
    if (v == null) unread?.add(fn);
    return (v ?? fallback) as T;
  } catch {
    unread?.add(fn);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// viem PublicClient adapter (READ-ONLY). Turns a live client into the ChainReader
// collectTokenFacts consumes. No writes, no signing — only getCode + view calls.
// ---------------------------------------------------------------------------

/**
 * The read-only DopplerERC20V1 view surface the collector consults. Every entry
 * is a zero-arg `view`: name/symbol/totalSupply/owner are the ERC-20 + Ownable
 * basics; isBalanceLimitActive/vestedTotalAmount are DopplerERC20V1's own getters.
 * A read of a function a token does NOT implement reverts — which safeRead()
 * catches and degrades to the conservative fallback, so an opaque/unverified
 * token defaults CLOSED rather than being vouched for.
 */
export const TOKEN_READER_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'isBalanceLimitActive', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'vestedTotalAmount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

/**
 * The read-only subset of a viem PublicClient this adapter uses. A real
 * PublicClient satisfies it structurally (it has both getCode + readContract);
 * tests supply a lightweight mock. Kept deliberately minimal so nothing routed
 * through here can write, sign, or send.
 */
export interface ReadOnlyPublicClient {
  getCode(args: { address: Address }): Promise<Hex | undefined>;
  // `readContract` args are intentionally `any`: a REAL viem PublicClient's overload
  // infers a literal `functionName` union from the abi, so it is NOT assignable to a
  // `functionName: string` param (contravariance) — `any` short-circuits the variance
  // check so both a real client AND a lightweight test mock satisfy this interface. The
  // adapter casts the result and never trusts the shape (every read is safeRead-guarded).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract(args: any): Promise<unknown>;
}

/**
 * Wrap a viem PublicClient into the {@link ChainReader} collectTokenFacts needs.
 * Pure read-only: `getCode` returns the runtime bytecode (the collector resolves
 * the EIP-1167 / Solady clone-impl target itself via cloneImplTarget), and
 * `readToken` issues one zero-arg `view` call, letting reverts propagate so the
 * collector's safeRead can degrade to the conservative (gate-closing) fallback.
 */
export function viemChainReader(client: ReadOnlyPublicClient): ChainReader {
  return {
    getCode: (address: Address) => client.getCode({ address }),
    readToken: <T>(address: Address, functionName: string): Promise<T> =>
      client.readContract({ address, abi: TOKEN_READER_ABI, functionName }) as Promise<T>,
  };
}
