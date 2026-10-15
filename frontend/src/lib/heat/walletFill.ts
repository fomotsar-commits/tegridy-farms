/**
 * The wallet fill: one read of a public address from a provider the browser already
 * carries, for a visitor who has not connected to the venue. It is not the app's wallet
 * stack. Never a signature, and never a prompt outside a press on a button that says
 * what it does. The caller names the network: this file never picks one for the visitor.
 * Any throw is the same answer as no provider: null, and the caller says one sentence.
 */

export type FillNetwork = 'ethereum' | 'solana';

/** Anything the page can be handed by an extension. Deliberately loose. */
type Injected = Record<string, any>;

function win(): Injected | undefined {
  return typeof window !== 'undefined' ? (window as unknown as Injected) : undefined;
}

function firstAddress(accounts: unknown): string | null {
  if (!Array.isArray(accounts)) return null;
  const first = accounts[0];
  return typeof first === 'string' && first.trim() !== '' ? first.trim() : null;
}

function ethereumProvider(w: Injected): Injected | null {
  return typeof w.ethereum?.request === 'function' ? w.ethereum : null;
}

/** Trust's own browser puts its Solana provider at `trustwallet.solana` and nowhere else. */
function solanaProviders(w: Injected): Injected[] {
  const found = [w.solana, w.phantom?.solana, w.trustwallet?.solana].filter(
    (p): p is Injected => Boolean(p) && (Boolean(p.publicKey) || typeof p.connect === 'function'),
  );
  return [...new Set(found)];
}

function keyText(key: unknown): string | null {
  if (!key) return null;
  const text = String(key).trim();
  return text !== '' ? text : null;
}

/**
 * Which networks a provider in this browser can answer for. Read at render, not cached
 * at module load: an extension can inject after the bundle evaluates.
 */
export function injectedNetworks(): Record<FillNetwork, boolean> {
  const w = win();
  if (!w) return { ethereum: false, solana: false };
  try {
    return { ethereum: ethereumProvider(w) !== null, solana: solanaProviders(w).length > 0 };
  } catch {
    return { ethereum: false, solana: false };
  }
}

/**
 * `eth_accounts` returns what the page is already allowed to see and prompts nobody.
 * Empty means "this origin is not authorised yet", so the press then asks for accounts:
 * the prompt the visitor asked for.
 */
async function readEthereum(w: Injected): Promise<string | null> {
  const eth = ethereumProvider(w);
  if (!eth) return null;
  try {
    const known = firstAddress(await eth.request({ method: 'eth_accounts' }));
    if (known) return known;
    return firstAddress(await eth.request({ method: 'eth_requestAccounts' }));
  } catch {
    return null;
  }
}

/**
 * A key a provider already shows, else `connect({ onlyIfTrusted: true })`, which answers
 * only for a wallet that has trusted this origin. A refusal is a normal answer.
 */
async function readSolana(w: Injected): Promise<string | null> {
  const providers = solanaProviders(w);
  for (const sol of providers) {
    const known = keyText(sol.publicKey);
    if (known) return known;
  }
  for (const sol of providers) {
    if (typeof sol.connect !== 'function') continue;
    try {
      const res = await sol.connect({ onlyIfTrusted: true });
      const asked = keyText(res?.publicKey ?? sol.publicKey);
      if (asked) return asked;
    } catch {
      // Not trusted here, or locked: the next provider may still answer.
    }
  }
  return null;
}

/** The address that network's provider hands over without a signature, or null. */
export async function readInjectedAddress(network: FillNetwork): Promise<string | null> {
  const w = win();
  if (!w) return null;
  try {
    return await (network === 'solana' ? readSolana(w) : readEthereum(w));
  } catch {
    return null;
  }
}
