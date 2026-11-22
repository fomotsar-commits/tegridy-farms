/** The HyperEVM screens' buttons, shared so every press looks the same. */
export const PRIMARY_BTN = 'w-full min-h-[48px] rounded-xl text-[14px] font-semibold text-white disabled:opacity-50';
export const PRIMARY_STYLE = { background: 'linear-gradient(135deg, #7c3aed, #6d28d9)' } as const;
export const QUIET_BTN = 'min-h-[44px] px-3 rounded-xl text-[13px] text-white/85 bg-black/45 disabled:opacity-50';

/** A deadline `minutes` from now, in seconds, for a transaction the wallet signs now. */
export function deadlineIn(minutes: number): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + minutes * 60);
}
