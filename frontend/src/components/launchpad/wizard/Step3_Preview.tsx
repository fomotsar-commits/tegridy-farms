import { useEffect, useMemo, useState } from 'react';
import type { Dispatch } from 'react';
import { parseCsv, matchCsvToFiles } from '../../../lib/nftMetadata';
import type { WizardState, WizardAction } from './wizardReducer';
import { BTN_EMERALD, LABEL } from '../launchpadConstants';
import { MetadataGrid } from './MetadataGrid';
import { TraitEditor } from './TraitEditor';

export function Step3_Preview({
  state,
  dispatch,
  onNext,
  onBack,
}: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  onNext: () => void;
  onBack: () => void;
}) {
  const [editIndex, setEditIndex] = useState<number | null>(null);

  // Re-parse on entry so the preview reflects the latest CSV/files.
  useEffect(() => {
    try {
      const { rows, warnings } = parseCsv(state.csvText);
      dispatch({ type: 'CSV_PARSED', rows, warnings });
    } catch (e) {
      dispatch({ type: 'VALIDATION_ERRORS', errors: [(e as Error).message] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Indexed lookup for the TraitEditor: clicking a cell dispatches the row's
  // original index, so we can pair it with the matching File for the modal preview.
  const fileByName = useMemo(() => {
    const { matched } = matchCsvToFiles(state.rows, state.imageFiles);
    return new Map(matched.map((m) => [m.row.file_name, m.file]));
  }, [state.rows, state.imageFiles]);

  const totalBytes = state.imageFiles.reduce((acc, f) => acc + f.size, 0);
  const mbTotal = (totalBytes / 1024 / 1024).toFixed(1);

  const editingRow = editIndex !== null ? state.rows[editIndex] : null;
  const editingFile = editingRow ? fileByName.get(editingRow.file_name) ?? null : null;

  return (
    <div className="space-y-5">
      <div>
        <label className={LABEL}>
          {state.rows.length} token{state.rows.length === 1 ? '' : 's'} · {mbTotal} MB total
        </label>
        <p className="text-white/60 text-[11px] mt-1">
          Click any token to edit its name, description, and traits. Upload size drives
          Arweave cost — you'll get an exact quote in the next step.
        </p>
      </div>

      <MetadataGrid
        rows={state.rows}
        files={state.imageFiles}
        onSelect={(index) => setEditIndex(index)}
      />

      <div className="flex justify-between pt-4 gap-3">
        <button
          onClick={onBack}
          className="px-5 py-2 rounded-lg text-xs text-white/70 hover:text-white border border-white/15 bg-black/30"
        >
          ← Back
        </button>
        <button
          onClick={onNext}
          disabled={state.rows.length === 0}
          className={`px-8 py-2.5 rounded-xl text-sm ${BTN_EMERALD} disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          Looks good — get Arweave quote →
        </button>
      </div>

      {editingRow && editIndex !== null && (
        <TraitEditor
          row={editingRow}
          file={editingFile}
          onSave={(patch) => {
            dispatch({ type: 'EDIT_ROW', index: editIndex, patch });
            setEditIndex(null);
          }}
          onCancel={() => setEditIndex(null)}
        />
      )}
    </div>
  );
}
