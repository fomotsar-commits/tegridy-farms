import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { base64ToBytes } from '../lp/accounts';

/**
 * The price keeper's own Jupiter client. Not the site's (lib/jupiter.ts): that one goes
 * through the site's proxy and shares the site's one request a second. The keeper calls
 * Jupiter directly with ITS OWN key, the way api/aggregator.js does: a key → api.jup.ag
 * with `x-api-key`; no key → the keyless lite-api host while Jupiter still answers there.
 * Calls are spaced `gapMs` apart, so a free key's one request a second is never exceeded.
 * The keyless host is slower still, and a pass without a key is spaced further.
 */

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: { swapInfo?: { label?: string } }[];
  [key: string]: unknown;
}

interface WireIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

export interface SwapInstructions {
  swap: TransactionInstruction;
  lookupTables: string[];
  /** Instructions Jupiter adds that the keeper never signs: their presence refuses the trade. */
  extra: number;
}

export interface JupiterApi {
  quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number; excludeDexes: readonly string[]; maxAccounts: number }): Promise<JupiterQuote>;
  swapInstructions(quote: JupiterQuote, user: PublicKey): Promise<SwapInstructions>;
  /** Program id → venue name, for the venues the keeper refuses. */
  labels(): Promise<Record<string, string>>;
  prices(mints: string[]): Promise<Record<string, number>>;
}

export const JUPITER_KEYED_BASE = 'https://api.jup.ag';
export const JUPITER_KEYLESS_BASE = 'https://lite-api.jup.ag';

export function jupiterApi(opts: { key?: string; fetchImpl?: typeof fetch; gapMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): JupiterApi {
  const key = opts.key?.trim() ?? '';
  const base = key ? JUPITER_KEYED_BASE : JUPITER_KEYLESS_BASE;
  const headers: Record<string, string> = key ? { 'x-api-key': key, Accept: 'application/json' } : { Accept: 'application/json' };
  const doFetch = opts.fetchImpl ?? fetch;
  // A key allows one request a second; the keyless host refuses calls 1.3 s apart (walked 2026-10-29).
  const gapMs = opts.gapMs ?? (key ? 1100 : 2000);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = -Infinity;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const wait = last + gapMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
    const res = await doFetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
    if (!res.ok) {
      // Jupiter's own code, when it gives one ("NO_ROUTES_FOUND"): a reason, not an outage.
      const said = await res.json().then((b: { errorCode?: unknown; error?: unknown }) => b?.errorCode ?? b?.error, () => null);
      throw new Error(`Jupiter ${path.split('?')[0]} answered ${res.status}${typeof said === 'string' ? ` (${said.slice(0, 80)})` : ''}`);
    }
    return (await res.json()) as T;
  }

  return {
    quote: (p) => {
      const qs = new URLSearchParams({
        inputMint: p.inputMint,
        outputMint: p.outputMint,
        amount: p.amount.toString(),
        slippageBps: String(p.slippageBps),
        swapMode: 'ExactIn',
        restrictIntermediateTokens: 'true',
        instructionVersion: 'V2',
        maxAccounts: String(p.maxAccounts),
      });
      if (p.excludeDexes.length) qs.set('excludeDexes', p.excludeDexes.join(','));
      return call<JupiterQuote>(`/swap/v1/quote?${qs.toString()}`);
    },
    swapInstructions: async (quote, user) => {
      const body = {
        quoteResponse: quote,
        userPublicKey: user.toBase58(),
        // The keeper holds its SOL wrapped, in its own account: nothing to wrap or unwrap.
        wrapAndUnwrapSol: false,
        useSharedAccounts: false,
        dynamicComputeUnitLimit: false,
      };
      const r = await call<{
        swapInstruction?: WireIx;
        addressLookupTableAddresses?: string[];
        cleanupInstruction?: WireIx | null;
        otherInstructions?: WireIx[];
        tokenLedgerInstruction?: WireIx | null;
      }>('/swap/v1/swap-instructions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.swapInstruction) throw new Error('Jupiter built no swap instruction');
      // Jupiter's compute-budget and account-setup instructions are dropped: the keeper
      // writes its own. Anything else it adds is counted, and refuses the trade.
      const extra = (r.cleanupInstruction ? 1 : 0) + (r.tokenLedgerInstruction ? 1 : 0) + (r.otherInstructions?.length ?? 0);
      return { swap: toInstruction(r.swapInstruction), lookupTables: r.addressLookupTableAddresses ?? [], extra };
    },
    labels: () => call<Record<string, string>>('/swap/v1/program-id-to-label'),
    prices: async (mints) => {
      const ids = [...new Set(mints)];
      if (!ids.length) return {};
      const json = await call<Record<string, { usdPrice?: number } | null>>(`/price/v3?ids=${ids.join(',')}`);
      const out: Record<string, number> = {};
      for (const [mint, v] of Object.entries(json)) if (v && typeof v.usdPrice === 'number') out[mint] = v.usdPrice;
      return out;
    },
  };
}

export function toInstruction(w: WireIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(w.programId),
    keys: w.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(base64ToBytes(w.data)),
  });
}

/**
 * Every venue whose name says Raydium: the owner's ruling is no money to Raydium, ever. The
 * names go to Jupiter (`excludeDexes`); the programs, with `known` (the keeper's own list of
 * Raydium's programs, scripts/lib/raydium-programs.mjs) always among them, are refused in the
 * instruction Jupiter builds. A list naming no Raydium venue at all cannot exclude it, and the
 * caller does not trade on it. `allowRaydium` (the owner's word for the keeper, 2026-10-31)
 * refuses nothing.
 */
export function refusedVenues(labels: Record<string, string>, known: readonly string[], allowRaydium = false): { names: string[]; programs: Set<string> } {
  if (allowRaydium) return { names: [], programs: new Set() };
  const hits = Object.entries(labels).filter(([, name]) => /raydium/i.test(name));
  return { names: [...new Set(hits.map(([, n]) => n))].sort(), programs: new Set([...known, ...hits.map(([id]) => id)]) };
}
