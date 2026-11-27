// How the Solana swap fee's two build settings are read, in one place: lib/solana.ts uses
// these at run time, and solanaFeeGuardPlugin.ts checks a production build with the same
// two functions, so the build is refused on exactly what the site would charge.
// No import.meta.env here: vite.config.ts (node types) imports this file too.

/** The fee rate the venue charges on a Jupiter swap: 50 bps = 0.5%. */
export const SOLANA_FEE_BPS_LIVE = 50;

/** The fee owner the site uses: the setting trimmed, or '' (no fee) when it is unset. */
export function solanaFeeAccountFrom(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** The rate the site uses: a number in [0, 1000] bps, else 0. Unset is 0: no fee, never a guess. */
export function solanaFeeBpsFrom(raw: unknown): number {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const n = s === '' ? 0 : Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : 0;
}

/**
 * What a production build must not ship with: a fee owner other than `vault`, or a rate other
 * than SOLANA_FEE_BPS_LIVE. Empty when both are right. A message never repeats a setting's value.
 */
export function solanaFeeSettingProblems(env: Readonly<Record<string, unknown>>, vault: string): string[] {
  const problems: string[] = [];
  const owner = solanaFeeAccountFrom(env.VITE_SOLANA_FEE_ACCOUNT);
  if (owner === '') problems.push('VITE_SOLANA_FEE_ACCOUNT is unset, so Solana swaps would charge no fee');
  else if (owner !== vault) problems.push(`VITE_SOLANA_FEE_ACCOUNT is not the Squads vault ${vault} (value not printed)`);
  const rawBps = env.VITE_SOLANA_PLATFORM_FEE_BPS;
  if (typeof rawBps !== 'string' || rawBps.trim() === '') {
    problems.push(`VITE_SOLANA_PLATFORM_FEE_BPS is unset, so the rate would be 0; it must be ${SOLANA_FEE_BPS_LIVE}`);
  } else if (solanaFeeBpsFrom(rawBps) !== SOLANA_FEE_BPS_LIVE) {
    problems.push(`VITE_SOLANA_PLATFORM_FEE_BPS is not ${SOLANA_FEE_BPS_LIVE} (value not printed)`);
  }
  return problems;
}
