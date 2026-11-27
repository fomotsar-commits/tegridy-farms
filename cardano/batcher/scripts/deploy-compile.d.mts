import type { DeployInputs, Scripts, compiledParams } from '../src/deploy.ts';
export const TRUNK: string;
export function addressData(bech32: string): string;
export interface SourceOptions {
  /** Preprod (network 0) only: compile a tree that is not a clean trunk commit, with a warning. */
  unproven?: boolean;
  /** git, run at the repository's root (tests stand one in). */
  git?: (args: string[]) => string;
  /** The tree provenance checks. */
  root?: string;
}
export function checkSource(network: number, opts?: SourceOptions): { commit: string; proven: boolean };
export function compileDeployment(p: DeployInputs, opts?: SourceOptions): { compiler: string; source: { commit: string; proven: boolean }; params: ReturnType<typeof compiledParams>; scripts: Scripts };
