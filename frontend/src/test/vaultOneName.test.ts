// In the pools' and range pools' copy, "vault" names one thing: the team's vault, the Squads
// vault that holds the pool programs' admin keys (PR #1320). A pool's own account for a coin is
// called that, never a vault, or a stranger reads two things under one name. A shown string
// passes when each "vault" in it is "the team's vault", or "the vault" once that string or its
// section (ALLOWED) has named it, or the Squads vault named as such; an identifier is no copy.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SRC, fromSrc, shownTexts, sourceFiles } from './shownText';

const POOL_COPY = /^(components\/solana\/(lp|range)\/|components\/solana\/curve\/(RangeRows|TxFlowView)\.tsx$|lib\/launcher\/solana\/(write|discover)\/|lib\/solana\/(lp|cpswap|clmm|swap)\/)/;
/** Sections that name the team's vault before they say "the vault" (the pools' Risks and the vault card). */
const ALLOWED = new Set(['components/solana/lp/LpDisclosures.tsx', 'components/solana/lp/SolanaLpSection.tsx']);
// JSX text keeps its line breaks and entities, so any run of whitespace and either apostrophe.
const TEAMS = /team(?:’|'|&apos;|&rsquo;)s\s+$/i;
const NAMED = /team(?:’|'|&apos;|&rsquo;)s\s+vault/i;

/** Each "vault" in `text` that names something other than the team's vault. */
export function strayVaults(text: string, file: string): string[] {
  if (/^[\w-]+$/.test(text.trim())) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/\bvaults?\b/gi)) {
    const before = text.slice(0, m.index);
    if (TEAMS.test(before)) continue;
    // The Squads vault, named as such: "the known Squads vault", "vault 0 of the Squads multisig".
    if (/Squads\s+$/.test(before) || /^vault\s+\d+\s+of\s+the\s+Squads\b/i.test(text.slice(m.index))) continue;
    const theVault = m[0].toLowerCase() === 'vault' && /\bthe\s+$/i.test(before);
    if (theVault && (NAMED.test(before) || ALLOWED.has(file))) continue;
    out.push(text.slice(Math.max(0, m.index - 50), m.index + 30).replace(/\s+/g, ' ').trim());
  }
  return out;
}

describe('one name for the team’s vault', () => {
  it('no string in the pools’ or range pools’ copy calls anything else a vault', { timeout: 30_000 }, () => {
    const files = sourceFiles(SRC).filter((f) => POOL_COPY.test(fromSrc(f)));
    expect(files.length).toBeGreaterThan(60);
    const offenders = files.flatMap((f) =>
      shownTexts(f, readFileSync(f, 'utf8')).flatMap((t) => strayVaults(t.text, fromSrc(f)).map((s) => `${fromSrc(f)}:${t.line}: …${s}…`)),
    );
    expect(offenders, `call a pool's own account for a coin that, never a vault:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('tells the team’s vault from a pool’s, so it cannot pass by passing everything', () => {
    const f = 'components/solana/range/X.tsx';
    expect(strayVaults('Switched off by the team’s vault right now.', f)).toEqual([]);
    expect(strayVaults("(the team&apos;s vault). Only the vault can switch them back on.", f)).toEqual([]);
    expect(strayVaults('When the team&apos;s\n          vault creates it', f)).toEqual([]);
    expect(strayVaults('vault-frozen', f)).toEqual([]);
    expect(strayVaults('The vault can switch off deposits.', 'components/solana/lp/SolanaLpSection.tsx')).toEqual([]);
    expect(strayVaults('The vault can switch off deposits.', f)).toHaveLength(1);
    expect(strayVaults('One of this pool’s vaults is frozen.', f)).toHaveLength(1);
    expect(strayVaults('A reward’s vault holds less; that pays what the vault holds.', f)).toHaveLength(2);
    expect(strayVaults('the swap names the wrong pool vault', f)).toHaveLength(1);
    // A Squads line names its own vault only: a pool's vault beside it in the same string still counts.
    expect(strayVaults(', vault 0 of the Squads multisig', f)).toEqual([]);
    expect(strayVaults("it is not the platform's known Squads vault.", f)).toEqual([]);
    expect(strayVaults('Squads holds the admin keys. One of this pool’s vaults is frozen.', f)).toHaveLength(1);
  });
});
