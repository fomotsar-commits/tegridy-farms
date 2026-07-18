// EIP-5792 (Wallet Call API) helpers — `wallet_getCapabilities` / `wallet_sendCalls`.
//
// This is the standard, battle-tested way to batch several contract calls into
// ONE wallet confirmation on supporting wallets (MetaMask via the EIP-7702 EOA
// upgrade, Coinbase Smart Wallet, ...). The headline Tegridy use cases:
//   - approve + swap         → one click
//   - approve + stake        → one click
//   - claim   + restake      → one click
//
// FOUNDATION ONLY (2026-06-01): these are pure/provider-level utilities, written
// against the raw EIP-1193 provider so they are independent of any
// wagmi-experimental export surface (which moves between wagmi minor versions).
// Wiring them into the audited swap/stake money paths is a separate, reviewed
// batch that needs live-wallet QA — see docs/USER_VALUE_ROADMAP.md.
//
// Refs: https://eips.ethereum.org/EIPS/eip-5792  ·  https://www.eip5792.xyz/

export interface Eip1193Like {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface WalletCall {
  to: `0x${string}`;
  /** ABI-encoded calldata; omit for a plain value transfer. */
  data?: `0x${string}`;
  /** Hex-encoded wei value; omit for a zero-value call. */
  value?: `0x${string}`;
}

export interface SendCallsParams {
  from: `0x${string}`;
  /** Hex chain id, e.g. '0x1' for mainnet. */
  chainId: string;
  calls: WalletCall[];
  /**
   * When true, the wallet must execute the batch atomically (all-or-nothing) —
   * on a vanilla EOA this triggers the EIP-7702 smart-account upgrade prompt.
   * When the caller can tolerate sequential execution, leave it false/undefined.
   */
  atomicRequired?: boolean;
}

/**
 * Parse a `wallet_getCapabilities` response and decide whether the wallet can
 * batch atomically on the given chain. EIP-5792 advertises this under
 * `capabilities[chainIdHex].atomic.status`, which is one of:
 *   - 'supported'  — can execute the batch atomically now
 *   - 'ready'      — can, pending a one-time user approval (e.g. EIP-7702 upgrade)
 *   - 'unsupported'— cannot; caller must fall back to sequential txs
 * Both 'supported' and 'ready' mean "offer the one-click path". Chain-id key
 * matching is case-insensitive because wallets vary on hex casing.
 */
export function isAtomicBatchSupported(capabilities: unknown, chainIdHex: string): boolean {
  if (typeof capabilities !== 'object' || capabilities === null) return false;
  const perChain = lookupChain(capabilities as Record<string, unknown>, chainIdHex);
  if (typeof perChain !== 'object' || perChain === null) return false;
  const atomic = (perChain as { atomic?: unknown }).atomic;
  if (typeof atomic !== 'object' || atomic === null) return false;
  const status = (atomic as { status?: unknown }).status;
  return status === 'supported' || status === 'ready';
}

function lookupChain(caps: Record<string, unknown>, chainIdHex: string): unknown {
  if (chainIdHex in caps) return caps[chainIdHex];
  const wanted = chainIdHex.toLowerCase();
  for (const key of Object.keys(caps)) {
    if (key.toLowerCase() === wanted) return caps[key];
  }
  return undefined;
}

/** Thin wrapper over the `wallet_getCapabilities` RPC. */
export function getWalletCapabilities(provider: Eip1193Like, account: `0x${string}`): Promise<unknown> {
  return provider.request({ method: 'wallet_getCapabilities', params: [account] });
}

/**
 * Extract the batch id string from a `wallet_sendCalls` result. The EIP-5792 v2.0.0
 * envelope resolves to `{ id: string }` (usable with wallet_getCallsStatus); some
 * wallets still return a bare string. `String(result)` on the object form yields the
 * useless literal "[object Object]", so callers MUST normalize through this.
 */
export function callsId(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'id' in result) return String((result as { id: unknown }).id);
  return String(result);
}

/** Thin wrapper over the `wallet_sendCalls` RPC (EIP-5792 v2.0.0 envelope). */
export function sendCalls(provider: Eip1193Like, params: SendCallsParams): Promise<unknown> {
  return provider.request({
    method: 'wallet_sendCalls',
    params: [
      {
        version: '2.0.0',
        from: params.from,
        chainId: params.chainId,
        atomicRequired: params.atomicRequired ?? false,
        calls: params.calls,
      },
    ],
  });
}
