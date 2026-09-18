/**
 * WAVE SEVEN, element B: THE WALLET FILL.
 *
 * "When an injected provider exists (window.ethereum, or a Solana provider), a
 * small 'Use my wallet' button fills the field from eth_accounts (never
 * eth_requestAccounts until tapped; never a signature) or from the Solana
 * provider's publicKey / connect({ onlyIfTrusted }); on failure it says 'Paste
 * the address instead.' and nothing else."
 *
 * WHY THIS IS NOT THE APP'S WALLET STACK. HeatCard already fills from wagmi's
 * connected account. This is for the visitor who has a wallet in the browser and
 * has NOT connected it to the venue: the instrument reads a public address, so
 * asking someone to run a whole connect flow to look up their own held time is a
 * toll booth in front of a public number. Nothing here touches the connectors,
 * the modal or the chain - one read of an address a provider already knows.
 *
 * NEVER A SIGNATURE, and never a silent prompt. `eth_accounts` returns what the
 * page is ALREADY authorised to see and prompts nobody; only when that is empty
 * does this ask for accounts, and only inside a tap the visitor made on a button
 * that says what it does. The Solana side is the same shape: a publicKey that
 * already exists, else `connect({ onlyIfTrusted: true })`, which resolves only
 * for a wallet that has already trusted this origin and never opens a dialog.
 *
 * EVM IS TRIED FIRST because the field's own placeholder leads with 0x and most
 * injected providers are EVM; a browser carrying both answers with its EVM
 * account, which the visitor can still overtype. Any throw, anywhere, is the
 * same outcome as no provider: null, and the caller says one sentence.
 */

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

/**
 * Is there anything to fill FROM? Read at render, not cached at module load:
 * an extension can inject after the bundle evaluates, and a button that decided
 * it did not exist half a second too early never comes back.
 */
export function hasInjectedWallet(): boolean {
  const w = win();
  if (!w) return false;
  return Boolean(w.ethereum) || Boolean(w.solana) || Boolean(w.phantom?.solana);
}

/**
 * The address an injected provider will hand over without a signature, or null.
 * `null` is not an error state to explain - the caller has exactly one sentence
 * for it, and the field still takes a paste.
 */
export async function readInjectedAddress(): Promise<string | null> {
  const w = win();
  if (!w) return null;

  const eth = w.ethereum;
  if (eth && typeof eth.request === 'function') {
    try {
      const known = firstAddress(await eth.request({ method: 'eth_accounts' }));
      if (known) return known;
      // Empty means "this origin is not authorised yet", not "no wallet". The
      // visitor tapped the button; this is the prompt they asked for.
      const asked = firstAddress(await eth.request({ method: 'eth_requestAccounts' }));
      if (asked) return asked;
    } catch {
      // A rejected prompt, a locked wallet, a provider that does not speak this
      // method: all the same answer. Fall through and try Solana.
    }
  }

  const sol = w.solana ?? w.phantom?.solana;
  if (sol) {
    try {
      if (sol.publicKey) {
        const pk = String(sol.publicKey);
        if (pk.trim() !== '') return pk.trim();
      }
      if (typeof sol.connect === 'function') {
        const res = await sol.connect({ onlyIfTrusted: true });
        const pk = res?.publicKey ?? sol.publicKey;
        if (pk) {
          const s = String(pk).trim();
          if (s !== '') return s;
        }
      }
    } catch {
      // onlyIfTrusted rejects for a wallet that has not trusted this origin.
      // That is a normal answer, not a fault, and it gets the same sentence.
    }
  }

  return null;
}
