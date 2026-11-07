import { useBaylaLine } from '../useBaylaLine';
import { SHEET_ROW_WORDS } from './sheetContext';

/**
 * Bayla's line inside the sheet (answer twenty-five, screen 1, row 8): a 40 px row with a
 * green dot and her line for the room's state, and no button: the sheet's own green button
 * is her move.
 */
export function SheetBaylaRow() {
  const line = useBaylaLine();
  // Nothing read yet: her line asks for a wallet to paste, and the sheet has no field for one.
  if (line.button.move === 'read') return null;
  return <HerLine text={line.text} />;
}

/** Her line in the Buy sheet before a coin is picked (answer twenty-seven): the bungalow row above is the move. */
export function SheetPickLine() {
  return <HerLine text={SHEET_ROW_WORDS.pick} />;
}

function HerLine({ text }: { text: string }) {
  return (
    <div
      data-testid="sheet-bayla"
      className="flex items-center gap-3 min-h-[40px] px-3 py-1.5 rounded-xl"
      style={{ background: 'rgba(6,12,26,0.65)', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <span aria-hidden="true" className="shrink-0 rounded-full" style={{ width: 6, height: 6, background: 'var(--color-kyle)' }} />
      <p className="text-[12.5px] leading-[15px]" style={{ color: 'rgba(255,255,255,0.90)' }}>
        {text}
      </p>
    </div>
  );
}
