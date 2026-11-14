// Small form pieces the NFT lending screens share (NFTLendingSection.tsx, LoanRequests.tsx).
import { InfoTooltip } from '../ui/InfoTooltip';
import { CARD_BG, LABEL_STYLE, SELECTED_BG } from './nftLendingShared';

/** Under a box whose text the form cannot use: the values it takes. */
export function BoxHint({ id, testId, text }: { id: string; testId: string; text: string }) {
  return (
    <p id={id} className="text-amber-300 text-[11px] mt-1" style={LABEL_STYLE} data-testid={testId}>
      {text}
    </p>
  );
}

export function PresetRow({
  label,
  tooltip,
  presets,
  value,
  onChange,
}: {
  label: string;
  tooltip?: string;
  presets: { label: string; seconds: number }[];
  value: number;
  onChange: (s: number) => void;
}) {
  return (
    <div>
      <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 flex items-center gap-1.5" style={LABEL_STYLE}>
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </label>
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {presets.map((d) => (
          <button
            key={d.seconds}
            aria-pressed={value === d.seconds}
            onClick={() => onChange(d.seconds)}
            className={`min-h-[44px] px-4 py-2 rounded-xl text-[13px] font-medium transition-all ${
              value === d.seconds ? 'border border-emerald-500/60 text-emerald-300' : 'border border-white/5 text-white/70 hover:text-white/70 hover:border-white/15'
            }`}
            style={{ background: value === d.seconds ? SELECTED_BG : CARD_BG }}
          >
            {d.label}
          </button>
        ))}
      </div>
    </div>
  );
}
