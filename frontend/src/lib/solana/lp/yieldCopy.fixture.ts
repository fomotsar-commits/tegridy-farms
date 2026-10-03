// Test helper, shared by the unit tests and the Solana e2e specs: does this page text
// promise a yield? The liquidity pages show none, because none has been measured, and
// the tests hold them to it.
//
// WHY A HELPER. The old check was `/APR|APY|yield of/i` against a whole section's text.
// That text is full of base58 addresses (pool, mints, the wallet), generated fresh on
// every run, and base58 with the `i` flag contains "apr" or "apy" about once in every
// few dozen runs. So the check failed at random on an address, having found no copy.
//
// WHAT IT MEANS NOW. The words APR, APY and "yield" as WORDS in prose:
//   1. addresses are taken out first: any base58 run of 32 or more characters (an
//      address or a signature), and the site's short form "AbCd…WxYz" (shortAddress);
//   2. what is left is matched as words, so "12% APR", "APRs vary", "APR12%" and "a
//      yield of 9%" are caught, and letters inside a longer word are not.
// A real "APR" in copy is three letters beside a space or punctuation: step 1 never
// removes it (it is neither 32 characters long nor exactly four characters each side of
// an ellipsis; the one prose shape that is, "APRs…from", is kept on purpose).

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
/** A full address or signature. */
const FULL_ADDRESS = new RegExp(`${BASE58}{32,}`, 'g');
/**
 * The site's short form (format.ts shortAddress): EXACTLY four characters, an ellipsis,
 * four characters, with no base58 character touching either end. Three dots too. Exact,
 * so prose around an ellipsis ("yields…from fees") is not taken for an address.
 */
const SHORT_ADDRESS = new RegExp(`(?<!${BASE58})(${BASE58}{4})(?:…|\\.{3})(${BASE58}{4})(?!${BASE58})`, 'g');
/**
 * The one piece of prose that has an address's exact shape: "APRs…from". A half that IS
 * the plural word is kept as prose. (A real address starts or ends with those four
 * letters about six times in a million, against once in a few dozen for the old check.)
 */
const PLURAL_YIELD_WORD = /^(?:APR|APY)s$/i;

/** The text with every address (full or shortened) replaced by a space. */
export function withoutAddresses(text: string): string {
  return text
    .replace(FULL_ADDRESS, ' ')
    .replace(SHORT_ADDRESS, (whole, head: string, tail: string) => (PLURAL_YIELD_WORD.test(head) || PLURAL_YIELD_WORD.test(tail) ? whole : ' '));
}

/** The one sentence on the liquidity section that may say "yield" (SolanaLpSection.tsx): it says none is shown. */
export const NO_YIELD_SENTENCE = 'This page shows no yield, because none has been measured.';

/**
 * APR or APY as a word, its plural (APRs), or with a number glued on either side
 * ("12%APR", "APR12%"): not after a letter or digit, and not running on into more
 * letters (April). "yield" as a word or the start of one (yields, yielding).
 */
export const YIELD_WORDS = /(?<![A-Za-z0-9])(?:APR|APY)s?(?![A-Za-z])|\byield/i;

/**
 * The first yield claim in the text's prose, with a little of what surrounds it (for
 * the failure message); null when there is none. `allowed` names exact sentences that
 * may say "yield" (the one that says none is shown).
 */
export function yieldClaim(text: string, allowed: readonly string[] = []): string | null {
  let prose = withoutAddresses(text.replace(/\s+/g, ' '));
  for (const sentence of allowed) prose = prose.split(sentence).join(' ');
  const m = YIELD_WORDS.exec(prose);
  if (!m) return null;
  return prose.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).trim();
}
