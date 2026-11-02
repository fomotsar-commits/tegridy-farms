import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { displaySafe } from '../../launchMetadata/validate';
import type { SolToken } from '../../solanaTokenList';
import { claimedTicker } from '../lp/identity';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, readTokenSafety, type TokenSafety } from '../lp/tokenSafety';

/**
 * A coin for the swap form, read from the chain itself: the fallback when Jupiter's token
 * list does not know a mint. A pool on our venue can hold a coin Jupiter has never listed,
 * and a link from that pool (`/solana?out=<mint>`) must open on THAT coin, not slide to the
 * default pair with nothing said. The mint account gives the decimals (never invented) and
 * the token program; its metadata gives the ticker, named as every pool screen names a
 * coin (identity.ts: ours by mint, a copy as "fake X"). Jupiter's richer record (logo,
 * verified, scores) stays what it is when Jupiter answers: this is asked only after it.
 */

/** A longer name is cut here; the swap form shows it in the token's About panel. */
const NAME_CHARS = 32;

/** The form's coin from a check that read the mint; null for one that did not, or that found no mint. */
export function solTokenFromSafety(safety: TokenSafety | undefined): SolToken | null {
  if (!safety || safety.kind !== 'read' || !safety.facts) return null;
  const symbol = claimedTicker(safety.mint, safety.symbol) ?? `${safety.mint.slice(0, 4)}…`;
  const name = displaySafe(safety.name ?? '', NAME_CHARS);
  return {
    mint: safety.mint,
    symbol,
    name: name === '' ? symbol : name,
    decimals: safety.facts.decimals,
    tokenProgram: safety.facts.program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
    // Not on Jupiter's list is not "verified": the form's unverified warning and tick box apply.
    verified: false,
  };
}

/** Read `mint` from the chain for the form. Never throws: a read that failed is null, and the caller's default stands. */
export async function tokenFromChain(rpc: SolanaRpc, mint: string): Promise<SolToken | null> {
  try {
    const read = await readTokenSafety(rpc, [mint]);
    return solTokenFromSafety(read.get(mint));
  } catch {
    return null;
  }
}
