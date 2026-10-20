/**
 * The range program's id as plain text: THE ONE CONSTANT, read by program.ts (as a key)
 * and by the nav (as text, so the menu never loads the Solana library to decide whether
 * to show a tab). The deploy pack changes it and the program's declare_id! together;
 * program.test.ts holds them equal.
 */
export const PLACEHOLDER_PROGRAM_ADDRESS = 'RangePoo1PLACEHo1DERnotDep1oyed111111111111';
export const RANGE_PROGRAM_ADDRESS: string = PLACEHOLDER_PROGRAM_ADDRESS;

/**
 * Whether the Range tab and range pools in the swap route are shown. Only once the id is a
 * real program; or in a local build made with `vite build --mode range-preview`, which is
 * how the tab is walked before the deploy. Production builds use the mode 'production', so
 * a merge with the placeholder changes nothing a visitor sees.
 */
export function rangePoolsVisible(address: string = RANGE_PROGRAM_ADDRESS, mode: string = import.meta.env.MODE): boolean {
  return address !== PLACEHOLDER_PROGRAM_ADDRESS || mode === 'range-preview';
}
