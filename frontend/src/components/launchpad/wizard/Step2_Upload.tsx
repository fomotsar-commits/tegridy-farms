import { useRef, useEffect } from 'react';
import type { Dispatch } from 'react';
import { parseCsv, validateImages, matchCsvToFiles } from '../../../lib/nftMetadata';
import type { WizardState, WizardAction } from './wizardReducer';
import { canAdvanceFromStep2 } from './wizardReducer';
import { INPUT, LABEL, BTN_EMERALD } from '../launchpadConstants';

export function Step2_Upload({
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
  const imageInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  // Re-validate images + CSV whenever inputs change so the user sees errors inline.
  useEffect(() => {
    const errors: string[] = [];
    const warnings: string[] = [...state.validationWarnings];

    if (state.imageFiles.length > 0) {
      const img = validateImages(state.imageFiles);
      errors.push(...img.errors);
      warnings.push(...img.warnings);
    }

    if (state.csvText.trim() && state.imageFiles.length > 0) {
      try {
        const { rows } = parseCsv(state.csvText);
        const { missingFiles, extraFiles } = matchCsvToFiles(rows, state.imageFiles);
        if (missingFiles.length > 0) {
          errors.push(`${missingFiles.length} CSV row(s) reference missing image files`);
        }
        if (extraFiles.length > 0) {
          warnings.push(`${extraFiles.length} uploaded file(s) not referenced in CSV`);
        }
      } catch (e) {
        errors.push((e as Error).message);
      }
    }

    dispatch({ type: 'VALIDATION_ERRORS', errors });
    // Intentional: we don't want to write `state.validationWarnings` into itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.imageFiles, state.csvText]);

  const handleImages = (files: FileList | null) => {
    if (!files) return;
    dispatch({ type: 'SET_IMAGE_FILES', files: Array.from(files) });
  };

  const handleCsv = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    dispatch({ type: 'SET_CSV', text });
  };

  const canAdvance = canAdvanceFromStep2(state);

  return (
    <div className="space-y-5">
      {/* Collection metadata */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL}>Collection Name</label>
          <input
            value={state.collectionName}
            onChange={(e) =>
              dispatch({ type: 'SET_FIELD', field: 'collectionName', value: e.target.value })
            }
            placeholder="Towelies"
            className={INPUT}
          />
        </div>
        <div>
          <label className={LABEL}>Symbol</label>
          <input
            value={state.collectionSymbol}
            onChange={(e) =>
              dispatch({
                type: 'SET_FIELD',
                field: 'collectionSymbol',
                value: e.target.value.toUpperCase(),
              })
            }
            placeholder="TOWEL"
            className={INPUT}
          />
        </div>
      </div>

      <div>
        <label className={LABEL}>Description</label>
        <textarea
          value={state.description}
          onChange={(e) =>
            dispatch({ type: 'SET_FIELD', field: 'description', value: e.target.value })
          }
          rows={3}
          placeholder="Tell collectors what this collection is about…"
          className={`${INPUT} resize-none`}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className={LABEL}>Max Supply</label>
          <input
            type="number"
            value={state.maxSupply}
            onChange={(e) =>
              dispatch({ type: 'SET_FIELD', field: 'maxSupply', value: e.target.value })
            }
            className={`${INPUT} font-mono`}
          />
        </div>
        <div>
          <label className={LABEL}>Mint Price (ETH)</label>
          <input
            type="number"
            step="0.001"
            value={state.mintPrice}
            onChange={(e) =>
              dispatch({ type: 'SET_FIELD', field: 'mintPrice', value: e.target.value })
            }
            className={`${INPUT} font-mono`}
          />
        </div>
        <div>
          <label className={LABEL}>Max / Wallet</label>
          <input
            type="number"
            value={state.maxPerWallet}
            onChange={(e) =>
              dispatch({ type: 'SET_FIELD', field: 'maxPerWallet', value: e.target.value })
            }
            className={`${INPUT} font-mono`}
          />
        </div>
      </div>

      <div>
        <label className={LABEL}>Royalty ({(state.royaltyBps / 100).toFixed(1)}%)</label>
        <input
          type="range"
          min={0}
          max={1000}
          step={25}
          value={state.royaltyBps}
          onChange={(e) =>
            dispatch({ type: 'SET_FIELD', field: 'royaltyBps', value: Number(e.target.value) })
          }
          className="w-full h-1.5 rounded-full appearance-none bg-black/60 accent-emerald-500 cursor-pointer mt-2"
        />
      </div>

      <div>
        <label className={LABEL}>External Link (optional)</label>
        <input
          value={state.externalLink}
          onChange={(e) =>
            dispatch({ type: 'SET_FIELD', field: 'externalLink', value: e.target.value })
          }
          placeholder="https://yourcollection.xyz"
          className={INPUT}
          type="url"
        />
      </div>

      {/* Collection-level art: cover (OpenSea square), banner (wide hero). Optional
          but strongly recommended for marketplace presentation. Upload once,
          reused via contractURI JSON. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL}>Cover Image (1:1, OpenSea thumbnail)</label>
          <input
            ref={coverInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => dispatch({ type: 'SET_COVER', file: e.target.files?.[0] ?? null })}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => coverInputRef.current?.click()}
            className="w-full py-4 rounded-xl text-[12px] text-white border-2 border-dashed border-white/20 hover:border-emerald-500/50 transition-colors bg-black/40"
          >
            {state.coverFile ? `✓ ${state.coverFile.name}` : '+ Cover image'}
          </button>
        </div>
        <div>
          <label className={LABEL}>Banner Image (wide hero, optional)</label>
          <input
            ref={bannerInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => dispatch({ type: 'SET_BANNER', file: e.target.files?.[0] ?? null })}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => bannerInputRef.current?.click()}
            className="w-full py-4 rounded-xl text-[12px] text-white border-2 border-dashed border-white/20 hover:border-emerald-500/50 transition-colors bg-black/40"
          >
            {state.bannerFile ? `✓ ${state.bannerFile.name}` : '+ Banner image'}
          </button>
        </div>
      </div>

      {/* File pickers */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL}>Images (folder / multi-select)</label>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={(e) => handleImages(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            className={`w-full py-6 rounded-xl text-sm text-white border-2 border-dashed border-white/20 hover:border-emerald-500/50 transition-colors bg-black/40`}
          >
            {state.imageFiles.length > 0
              ? `${state.imageFiles.length} image${state.imageFiles.length > 1 ? 's' : ''} selected`
              : '+ Select images'}
          </button>
        </div>

        <div>
          <label className={LABEL}>Traits CSV</label>
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => handleCsv(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => csvInputRef.current?.click()}
            className={`w-full py-6 rounded-xl text-sm text-white border-2 border-dashed border-white/20 hover:border-emerald-500/50 transition-colors bg-black/40`}
          >
            {state.csvText
              ? 'CSV loaded — click to replace'
              : '+ Select CSV'}
          </button>
          <a
            href="/sample-collection.csv"
            download
            className="mt-1.5 inline-block text-[11px] text-white/60 hover:text-white/90 underline underline-offset-2"
          >
            Download template
          </a>
        </div>
      </div>

      {/* Validation surface */}
      {(state.validationErrors.length > 0 || state.validationWarnings.length > 0) && (
        <div className="space-y-1 text-[12px]">
          {state.validationErrors.map((e, i) => (
            <p key={`e${i}`} className="text-red-400">• {e}</p>
          ))}
          {state.validationWarnings.map((w, i) => (
            <p key={`w${i}`} className="text-amber-400/90">• {w}</p>
          ))}
        </div>
      )}

      <div className="flex justify-between pt-4 gap-3">
        <button
          onClick={onBack}
          className="px-5 py-2 rounded-lg text-xs text-white/70 hover:text-white border border-white/15 bg-black/30"
        >
          ← Back
        </button>
        <button
          onClick={onNext}
          disabled={!canAdvance}
          className={`px-8 py-2.5 rounded-xl text-sm ${BTN_EMERALD} disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          Preview →
        </button>
      </div>
    </div>
  );
}
