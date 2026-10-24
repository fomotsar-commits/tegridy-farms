// The Range tab's controls in the editorial look (lib/editorial.ts): hard corners, hairlines,
// mono type, the venue's green for the one picked. 44px tall; fields at 16px so iOS Safari
// does not zoom the page when one gets focus.
export function chipCls(on: boolean): string {
  return `min-h-[44px] px-3.5 border font-mono text-[11.5px] tracking-[0.04em] transition-colors disabled:opacity-60 ${
    on ? 'border-[#22c55e] bg-[#22c55e]/10 text-white' : 'border-white/20 bg-black/20 text-[#f5e4b8]/80 hover:border-white/40 hover:text-white'
  }`;
}

export const FIELD_CLS = 'w-full min-h-[44px] bg-black/40 border border-white/20 px-3 text-white text-[16px] font-mono tabular-nums focus:border-[#22c55e] focus:outline-none';

export const FIELD_LABEL_CLS = 'block font-mono text-[10.5px] tracking-[0.1em] text-[#f5e4b8]/70 mb-1';
