// Solana data adapter for the public token scanner.
//
// Reads a token's distribution through the SAME hardened same-origin RPC proxy the
// Solana swap surface uses (/api/solrpc). No new serverless function, no client-side
// RPC key. It uses only bounded, cheap JSON-RPC methods:
//
//   getTokenSupply(mint)          → authoritative total supply + decimals
//   getAccountInfo(mint)          → mint / freeze authority (HARD FACTS for the gate)
//   getTokenLargestAccounts(mint) → the top-20 token accounts (SPL caps this at 20)
//   getMultipleAccounts(...)      → resolve each token account → its owner wallet,
//                                   then classify each owner (System-Program-owned =
//                                   a real wallet; program-owned = a vault/PDA → excluded)
//
// COVERAGE: getTokenLargestAccounts is a hard top-20. That is a partial read of the
// LARGEST holders, so it yields an upper bound on concentration (disclosed by the
// scanner). Launch-time signals (bundles / snipers / token age) are NOT derivable
// from current balances, so they are left unmeasured — the core drops them from the
// blend and lowers confidence rather than assuming a flattering zero.

import { normalizeHolders, type HardFacts, type RawHolder } from '../detection';
import { type AdapterResult, ScanError, type TokenMeta } from './scanner';

const SOLRPC_PATH = '/api/solrpc';
/** Accounts owned by the System Program are ordinary wallets; anything else is program-owned. */
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

interface RpcCall {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}
interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** POST a JSON-RPC batch to the same-origin proxy and return results keyed by id. */
async function solrpcBatch(calls: RpcCall[], signal?: AbortSignal): Promise<Map<number, unknown>> {
  let res: Response;
  try {
    res = await fetch(SOLRPC_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(calls),
      signal,
    });
  } catch {
    throw new ScanError('network', 'Could not reach the Solana data proxy.');
  }
  if (res.status === 429) throw new ScanError('rate-limited', 'Too many scans right now — try again in a moment.');
  if (!res.ok) throw new ScanError('network', `Solana data proxy returned ${res.status}.`);

  let json: RpcResponse | RpcResponse[];
  try {
    json = (await res.json()) as RpcResponse | RpcResponse[];
  } catch {
    throw new ScanError('network', 'Solana data proxy returned an invalid response.');
  }
  const arr = Array.isArray(json) ? json : [json];
  const out = new Map<number, unknown>();
  for (const r of arr) if (r && typeof r.id === 'number') out.set(r.id, r.error ? undefined : r.result);
  return out;
}

// ── minimal shapes for the RPC results we read ────────────────────────────────
interface TokenSupplyResult {
  value?: { amount?: string; decimals?: number };
}
interface MintInfoResult {
  value?: {
    data?: { parsed?: { info?: { mintAuthority?: string | null; freezeAuthority?: string | null } } } | null;
  } | null;
}
interface LargestAccountsResult {
  value?: Array<{ address?: string; amount?: string }>;
}
interface ParsedTokenAccount {
  data?: { parsed?: { info?: { owner?: string } } } | null;
}
interface MultipleAccountsResult<T> {
  value?: Array<T | null>;
}
interface RawOwnerAccount {
  owner?: string;
  executable?: boolean;
}

/** The already-fetched RPC payloads, so parsing is a PURE, unit-testable step. */
export interface SolanaScanRaw {
  mint: string;
  supply: TokenSupplyResult | undefined;
  mintInfo: MintInfoResult | undefined;
  largest: LargestAccountsResult | undefined;
  /** getMultipleAccounts(jsonParsed) over the largest token accounts — resolves owner wallets. */
  tokenAccounts: MultipleAccountsResult<ParsedTokenAccount> | undefined;
  /** getMultipleAccounts(base64) over the owner wallets — classifies program-owned vaults. */
  ownerAccounts: MultipleAccountsResult<RawOwnerAccount> | undefined;
}

/**
 * Turn the raw Solana RPC payloads into the detection core's input. PURE — no
 * network, no clock — so the whole normalization path is testable with fixtures.
 */
export function parseSolanaScan(raw: SolanaScanRaw): AdapterResult {
  const amountStr = raw.supply?.value?.amount;
  const decimals = raw.supply?.value?.decimals ?? null;
  if (!amountStr) {
    throw new ScanError('not-found', 'No SPL token supply found at that address — is it a valid mint?');
  }
  const totalSupply = safeBig(amountStr);

  // HARD FACTS: a present mint/freeze authority string means it is LIVE (not renounced).
  // A null authority means renounced. If the mint account is missing, leave the fact
  // UNKNOWN (undefined) — unknown never fires the gate.
  const mintParsed = raw.mintInfo?.value?.data?.parsed?.info;
  const hardFacts: HardFacts = {};
  if (raw.mintInfo?.value) {
    hardFacts.mintAuthorityLive = mintParsed?.mintAuthority != null;
    hardFacts.freezeAuthorityLive = mintParsed?.freezeAuthority != null;
  }

  const largest = raw.largest?.value ?? [];
  const tokenAccts = raw.tokenAccounts?.value ?? [];
  const ownerAccts = raw.ownerAccounts?.value ?? [];

  const holders: RawHolder[] = [];
  for (let i = 0; i < largest.length; i++) {
    const entry = largest[i];
    const tokenAccount = entry?.address;
    const amount = entry?.amount;
    if (!tokenAccount || !amount) continue;
    const balance = safeBig(amount);
    if (balance <= 0n) continue;

    // Resolve token-account → owner wallet (so a whale's multiple ATAs collapse to one holder).
    const owner = tokenAccts[i]?.data?.parsed?.info?.owner ?? tokenAccount;

    // Classify the owner: an account owned by a program (or marked executable) is a
    // vault / PDA / contract, not a person — exclude it. A System-Program-owned or
    // unknown account is treated as a wallet and left to the core (which promotes a
    // large unlabeled wallet to `unclassified`, lowering confidence, never hostile).
    const ownerAcct = ownerAccts[i] ?? null;
    const programOwned = !!ownerAcct && ownerAcct.owner != null && ownerAcct.owner !== SYSTEM_PROGRAM;
    const label = ownerAcct?.executable || programOwned ? ('contract' as const) : null;

    holders.push({ address: tokenAccount, balance, ownerAddress: owner, label });
  }

  const enumeratedHolders = normalizeHolders(holders).length;

  const token: TokenMeta = {
    name: null, // getTokenLargestAccounts / getTokenSupply do not carry a token name
    symbol: null,
    decimals,
    holdersCount: null, // Solana top-20 read has no authoritative total-holder count
  };

  return {
    input: {
      holders,
      chain: 'solana',
      totalSupply,
      hardFacts,
      launch: { bundlesResolved: false, snipersResolved: false, tokenAgeSeconds: null },
    },
    token,
    enumeratedHolders,
    holderCoverage: 'top-n',
    source: 'Solana RPC (getTokenLargestAccounts, top 20)',
  };
}

/** Fetch + parse a Solana token scan through the same-origin RPC proxy. */
export async function fetchSolanaScan(mint: string, signal?: AbortSignal): Promise<AdapterResult> {
  // Batch 1: supply + mint authorities + the top-20 token accounts.
  const b1 = await solrpcBatch(
    [
      { jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] },
      { jsonrpc: '2.0', id: 2, method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed' }] },
      { jsonrpc: '2.0', id: 3, method: 'getTokenLargestAccounts', params: [mint] },
    ],
    signal,
  );
  const supply = b1.get(1) as TokenSupplyResult | undefined;
  const mintInfo = b1.get(2) as MintInfoResult | undefined;
  const largest = b1.get(3) as LargestAccountsResult | undefined;

  if (!supply?.value?.amount) {
    throw new ScanError('not-found', 'No SPL token supply found at that address — is it a valid mint?');
  }

  const tokenAccountAddrs = (largest?.value ?? [])
    .map((v) => v?.address)
    .filter((a): a is string => typeof a === 'string');

  let tokenAccounts: MultipleAccountsResult<ParsedTokenAccount> | undefined;
  let ownerAccounts: MultipleAccountsResult<RawOwnerAccount> | undefined;
  if (tokenAccountAddrs.length > 0) {
    // Batch 2: resolve each token account to its owner wallet.
    const b2 = await solrpcBatch(
      [{ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [tokenAccountAddrs, { encoding: 'jsonParsed' }] }],
      signal,
    );
    tokenAccounts = b2.get(1) as MultipleAccountsResult<ParsedTokenAccount> | undefined;

    // Batch 3: classify each owner wallet (System-Program-owned vs program-owned vault).
    const ownerAddrs = (tokenAccounts?.value ?? []).map(
      (a, i) => a?.data?.parsed?.info?.owner ?? tokenAccountAddrs[i],
    );
    const b3 = await solrpcBatch(
      [{ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [ownerAddrs, { encoding: 'base64' }] }],
      signal,
    );
    ownerAccounts = b3.get(1) as MultipleAccountsResult<RawOwnerAccount> | undefined;
  }

  return parseSolanaScan({ mint, supply, mintInfo, largest, tokenAccounts, ownerAccounts });
}

/** Parse a base-unit integer string to bigint; 0n on garbage (never throws). */
function safeBig(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}
