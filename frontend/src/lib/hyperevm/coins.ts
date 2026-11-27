import { erc20Abi } from 'viem';
import { HYPEREVM_TOKENS, WHYPE, type HyperEvmToken } from '../chains/hyperEvm';
import { displaySafe, foldForCompare, foldedForms, impersonatesAll } from '../launchMetadata/validate';
import type { HyperEvmReader, ReadResult } from './pools';
import { readUnits } from './reads';

/**
 * A coin that is not on the site's list, read from its own contract: anyone can open a pool for
 * one (opener.ts). Every coin shows its ticker (owner ruling 2026-10-22), cleaned for the screen,
 * and its whole address. A ticker or name that reads as one of the well-known HyperEVM coins at
 * another address is shown as "fake USDC", so a copy never passes for the real one. Names are
 * compared with the launcher's own rules (launchMetadata/validate.js), as the Solana screens do.
 */
const TICKER_CHARS = 12;
const NAME_CHARS = 40;

const USDT0 = '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb';
const USDC = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';
/** The coins a copy most likely pretends to be, with every address that really is one. */
export const HYPEREVM_WELL_KNOWN: readonly { label: string; addresses: readonly string[]; names: readonly string[] }[] = [
  { label: 'HYPE', addresses: [WHYPE], names: ['HYPE', 'WHYPE', 'Wrapped HYPE', 'Hyperliquid'] },
  { label: 'USDC', addresses: [USDC], names: ['USDC', 'USD Coin', 'USDCoin'] },
  { label: 'USD₮0', addresses: [USDT0], names: ['USDT0', 'USD₮0', 'USDT', 'Tether', 'Tether USD'] },
];
const FOLDED = HYPEREVM_WELL_KNOWN.flatMap((k) => k.names.map((n) => ({ folded: foldForCompare(n), known: k })));

/** The well-known coin any of `claims` (its ticker and name) says it is, when `address` is not that coin. */
export function copiedName(address: string, claims: readonly string[]): string | null {
  const a = address.toLowerCase();
  for (const claim of claims) {
    const said = [...foldedForms(claim), ...impersonatesAll(claim).map(foldForCompare)];
    const hit = FOLDED.find((k) => said.includes(k.folded));
    if (hit && !hit.known.addresses.some((x) => x.toLowerCase() === a)) return hit.known.label;
  }
  return null;
}

/**
 * The well-known coin a ticker or name merely contains ("USDC.e", "WUSDC", "HYPE2"), when it is
 * not an exact copy. Some are real coins of their own (kHYPE), so this only warns, never renames.
 */
export function lookalikeOf(address: string, claims: readonly string[]): string | null {
  const a = address.toLowerCase();
  for (const claim of claims) {
    const said = foldedForms(claim);
    for (const k of HYPEREVM_WELL_KNOWN) {
      if (k.addresses.some((x) => x.toLowerCase() === a)) continue;
      const short = k.names.filter((n) => n.length <= 6).map(foldForCompare);
      if (said.some((s) => short.some((n) => n.length >= 4 && s.includes(n)))) return k.label;
    }
  }
  return null;
}

/** Hebrew, Arabic and other right-to-left letters: such a ticker is set apart, so it cannot flip a price line around it. */
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const isolate = (s: string) => (RTL.test(s) ? `\u2068${s}\u2069` : s);

/** The listed coin at this address (HYPE's pool side is WHYPE), else null. */
export function listedCoin(address: string): HyperEvmToken | null {
  const a = address.toLowerCase();
  return HYPEREVM_TOKENS.find((t) => !t.isNative && t.address.toLowerCase() === a) ?? null;
}

/**
 * A coin from what its contract says: the listed coin when it is one, else its own ticker
 * cleaned ("fake X" for a copy), its name, and its decimals. Null when the contract does not
 * answer as a coin should, so it is never shown with made-up decimals.
 */
export function coinFrom(address: `0x${string}`, symbol: unknown, name: unknown, decimals: unknown): HyperEvmToken | null {
  const listed = listedCoin(address);
  if (listed) return listed;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const rawSymbol = typeof symbol === 'string' ? symbol : '';
  const rawName = typeof name === 'string' ? name : '';
  const shown = displaySafe(rawSymbol, TICKER_CHARS);
  if (shown === '') return null;
  const copy = copiedName(address, [rawSymbol, shown, rawName]);
  const like = copy ? null : lookalikeOf(address, [rawSymbol, shown]);
  return {
    address,
    symbol: copy ? `fake ${isolate(shown)}` : isolate(shown),
    name: isolate(displaySafe(rawName, NAME_CHARS) || shown),
    decimals,
    unlisted: true,
    ...(like ? { lookalike: like } : {}),
  };
}

const ok = (r: ReadResult | undefined): r is { status: 'success'; result: unknown } => r?.status === 'success';

/**
 * Every address's ticker, name and decimals; a coin that does not answer maps to null. Each
 * coin's three calls are one unit (reads.ts), so a coin that reverts or burns all the gas spoils
 * only its own answer.
 */
export async function readCoins(reader: HyperEvmReader, addresses: readonly `0x${string}`[]): Promise<Map<string, HyperEvmToken | null>> {
  const out = new Map<string, HyperEvmToken | null>();
  const unknown = Array.from(new Set(addresses.map((a) => a.toLowerCase()))).filter((a) => {
    const l = listedCoin(a);
    if (l) out.set(a, l);
    return !l;
  }) as `0x${string}`[];
  if (unknown.length === 0) return out;
  const res = await readUnits(reader, unknown.map((address) => [
    { address, abi: erc20Abi, functionName: 'symbol' },
    { address, abi: erc20Abi, functionName: 'name' },
    { address, abi: erc20Abi, functionName: 'decimals' },
  ]));
  unknown.forEach((a, i) => {
    const [s, n, d] = res[i] ?? [];
    const addr = addresses.find((x) => x.toLowerCase() === a)!;
    out.set(a, ok(d) && ok(s) ? coinFrom(addr, s.result, ok(n) ? n.result : '', Number(d.result)) : null);
  });
  return out;
}
