import { COST_BASIS_METHODS, methodInfo, type CostBasisMethod } from '../../lib/tax/methods';

// The method picker.
//
// There is no "recommended" badge and no pre-selected best answer, because which
// method a person is permitted to use — and whether they may change it between
// years — is a question about their jurisdiction and their prior filings. This
// venue does not know either. What it CAN do is state plainly that the choice
// changes the number, which is the fact a reader is most likely not to know.

export function CostBasisPicker({
  method,
  onChange,
}: {
  method: CostBasisMethod;
  onChange: (method: CostBasisMethod) => void;
}) {
  return (
    <fieldset className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <legend className="px-1 text-sm font-semibold text-white">Cost-basis method</legend>
      <p className="text-[12px] leading-relaxed text-white/65">
        These do not produce the same answer. On identical history they routinely differ by enough to change
        the sign of a year. Whichever you pick is stamped on every export, so a reader downstream can
        reproduce it — an unlabelled report is unusable.
      </p>

      <div className="mt-3 space-y-2">
        {COST_BASIS_METHODS.map((m) => (
          <label key={m.id} className="flex items-start gap-2 text-[12px] text-white/80">
            <input
              type="radio"
              name="cost-basis-method"
              value={m.id}
              checked={method === m.id}
              onChange={() => onChange(m.id)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium text-white/90">{m.label}</span>
              <span className="block text-white/60">{m.describes}</span>
            </span>
          </label>
        ))}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-white/50">Selected: {methodInfo(method).label}</p>
    </fieldset>
  );
}

export default CostBasisPicker;
