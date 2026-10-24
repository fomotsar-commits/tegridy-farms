/**
 * The range program's id as plain text: THE ONE CONSTANT, read by program.ts (as a key)
 * and by the nav (as text, so the menu never loads the Solana library to decide whether
 * to show a tab). program.test.ts holds it equal to the program's declare_id!.
 */
export const PLACEHOLDER_PROGRAM_ADDRESS = 'RangePoo1PLACEHo1DERnotDep1oyed111111111111';
/** Deployed 2026-10-21, held by the vault. */
export const RANGE_PROGRAM_ADDRESS: string = '7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso';

/**
 * Whether visitors see range pools: the Range tab, its route, and range pools in the swap
 * route. The owner's switch, on once the fee tiers exist on chain (vault proposal #19, checked
 * by the deploy pack's 6-verify-tiers); programId.test.ts and the route table's row change with it.
 */
export const RANGE_POOLS_OPEN: boolean = true;

/**
 * Shown once opened; or in a local build made with `vite build --mode range-preview`, which
 * is how the tab is walked before it opens. Production builds use the mode 'production'.
 */
export function rangePoolsVisible(open: boolean = RANGE_POOLS_OPEN, mode: string = import.meta.env.MODE): boolean {
  return open || mode === 'range-preview';
}
