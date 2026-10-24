import { LEGACY_TOKEN_PROGRAM, type SolToken } from '../../solanaTokenList';

// Jupiter's recurring (DCA) program predates Token-2022: an order for a Token-2022 mint
// fails Jupiter's own test run (error 3007, buying and selling; BAYLA, 2026-10-13). The
// program that owns each mint is read from the chain before anything is signed. A mint
// whose owner could not be read is unchecked, never "fine", and never a refusal.

export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Jupiter asks for at least this much per buy (developers.jup.ag, Recurring API). */
export const DCA_MIN_PER_BUY_USD = 50;

export type DcaPairCheck = { kind: 'ok' } | { kind: 'token-2022'; symbol: string } | { kind: 'unread' };

export const dcaToken2022Copy = (symbol: string) => `${symbol} is a Token-2022 token, and Jupiter's recurring orders cannot buy or sell it.`;
/** Beside the form, when the tab's own read could not run. */
export const DCA_UNREAD_NOTE = 'The two tokens could not be checked just now. Start the DCA checks them again.';
/** At a press whose read could not run. */
export const DCA_UNREAD_COPY = 'The two tokens could not be checked just now, so nothing was sent. Press again.';

/** `readOwners`: the owning program of each mint, in order; null for an account not found. */
export async function checkDcaPair(
  tokens: readonly SolToken[],
  readOwners: (mints: string[]) => Promise<(string | null)[]>,
): Promise<DcaPairCheck> {
  // Jupiter's own token record can say it first: refusing needs no read.
  const flagged = tokens.find((t) => t.tokenProgram !== undefined && t.tokenProgram !== LEGACY_TOKEN_PROGRAM);
  if (flagged) return { kind: 'token-2022', symbol: flagged.symbol };
  let owners: (string | null)[];
  try {
    owners = await readOwners(tokens.map((t) => t.mint));
  } catch {
    return { kind: 'unread' };
  }
  const i = owners.findIndex((o) => o === TOKEN_2022_PROGRAM);
  if (i >= 0 && tokens[i]) return { kind: 'token-2022', symbol: tokens[i].symbol };
  return owners.length === tokens.length && owners.every((o) => o === LEGACY_TOKEN_PROGRAM) ? { kind: 'ok' } : { kind: 'unread' };
}
