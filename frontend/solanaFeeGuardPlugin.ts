import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { SOLANA_FEE_BPS_LIVE, solanaFeeSettingProblems } from './src/lib/solanaFeeEnv.ts';

// A production build (Vercel's VERCEL_ENV=production) stops unless the Solana fee owner it would
// inline is the registry's squads-vault and the rate is 50 bps (src/lib/solanaFeeEnv.ts). Both
// are build settings, so a deleted or mistyped one would otherwise ship a site that charges no
// fee, or pays someone else, without an error. Every other build says it did not check.

/** The registry row the fee owner must equal. */
export const FEE_OWNER_ROW = 'squads-vault';

/** The squads-vault row's address in scripts/addresses.json. Throws when the row is missing. */
export function registryVault(root: string): string {
  const registry = JSON.parse(readFileSync(resolve(root, 'scripts/addresses.json'), 'utf-8')) as {
    solana?: { id?: string; address?: string }[];
  };
  const row = registry.solana?.find((r) => r.id === FEE_OWNER_ROW);
  if (typeof row?.address !== 'string' || row.address === '') {
    throw new Error(`solana-fee-guard: scripts/addresses.json has no solana row "${FEE_OWNER_ROW}"`);
  }
  return row.address;
}

/**
 * The check itself: throws, naming every problem, when `vercelEnv` is "production" and the
 * settings are wrong. Returns the line the build log shows either way.
 */
export function checkSolanaFeeSettings(env: Readonly<Record<string, unknown>>, vercelEnv: string | undefined, root: string): string {
  if (vercelEnv !== 'production') {
    return `solana-fee-guard: not a production build (VERCEL_ENV ${vercelEnv ? `"${vercelEnv}"` : 'unset'}), fee settings not checked`;
  }
  const vault = registryVault(root);
  const problems = solanaFeeSettingProblems(env, vault);
  if (problems.length > 0) {
    throw new Error(`solana-fee-guard: this production build is refused:\n  - ${problems.join('\n  - ')}`);
  }
  return `solana-fee-guard: production build, the Solana fee owner is ${vault} and the rate is ${SOLANA_FEE_BPS_LIVE} bps`;
}

export function solanaFeeGuardPlugin(): Plugin {
  return {
    name: 'solana-fee-guard',
    apply: 'build',
    // config.env is exactly what the build inlines as import.meta.env.
    configResolved(config) {
      config.logger.info(checkSolanaFeeSettings(config.env, process.env.VERCEL_ENV, config.root));
    },
  };
}
