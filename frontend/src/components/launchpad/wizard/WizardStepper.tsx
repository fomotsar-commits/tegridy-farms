import type { Step } from './wizardReducer';

const STEP_LABELS: Record<Step, string> = {
  1: 'Connect',
  2: 'Upload',
  3: 'Preview',
  4: 'Fund + Arweave',
  5: 'Deploy',
};

export function WizardStepper({ current }: { current: Step }) {
  return (
    <div className="flex items-center justify-between mb-6 gap-1 sm:gap-2">
      {([1, 2, 3, 4, 5] as Step[]).map((s, i) => {
        const isActive = s === current;
        const isDone = s < current;
        return (
          <div key={s} className="flex items-center flex-1 min-w-0">
            <div
              className={`flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold flex-shrink-0 transition-colors ${
                isDone
                  ? 'bg-emerald-500 text-black'
                  : isActive
                  ? 'bg-emerald-500/30 text-emerald-300 border border-emerald-500/70'
                  : 'bg-black/60 text-white/50 border border-white/15'
              }`}
            >
              {isDone ? '✓' : s}
            </div>
            <span
              className={`ml-2 text-[11px] truncate hidden sm:inline ${
                isActive ? 'text-white' : 'text-white/60'
              }`}
            >
              {STEP_LABELS[s]}
            </span>
            {i < 4 && (
              <div
                className={`flex-1 h-px mx-2 ${
                  isDone ? 'bg-emerald-500/60' : 'bg-white/15'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
