import { useEffect, useMemo, useState } from 'react';
import { m } from 'framer-motion';
import type { CsvRow, TokenAttribute } from '../../../lib/nftMetadata';
import { ArtCard } from '../launchpadShared';
import { ART } from '../../../lib/artConfig';
import { BTN_EMERALD, INPUT, LABEL } from '../launchpadConstants';

export function TraitEditor({
  row,
  file,
  onSave,
  onCancel,
}: {
  row: CsvRow;
  file: File | null;
  onSave: (patch: Partial<CsvRow>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(row.name);
  const [description, setDescription] = useState(row.description ?? '');
  const [attrs, setAttrs] = useState<TokenAttribute[]>(() => row.attributes.map((a) => ({ ...a })));

  // Object URL preview of the associated image. Revoke on unmount.
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  // Esc to cancel — matches the TopNav drawer UX.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const updateAttr = (i: number, patch: Partial<TokenAttribute>) => {
    setAttrs((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  };
  const addAttr = () => setAttrs((prev) => [...prev, { trait_type: '', value: '' }]);
  const removeAttr = (i: number) => setAttrs((prev) => prev.filter((_, idx) => idx !== i));

  const handleSave = () => {
    // Drop empty attribute pairs so we don't bloat the on-chain metadata JSON.
    const cleaned = attrs
      .map((a) => ({
        trait_type: a.trait_type.trim(),
        value: typeof a.value === 'string' ? a.value.trim() : a.value,
      }))
      .filter((a) => a.trait_type && a.value !== '' && a.value !== undefined);

    onSave({
      name: name.trim() || row.name,
      description: description.trim() || undefined,
      attributes: cleaned,
    });
  };

  return (
    <m.div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-label={`Edit traits for ${row.name}`}
    >
      <div
        className="absolute inset-0 bg-black/75 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />
      <m.div
        className="relative w-full max-w-lg max-h-[90vh] overflow-hidden"
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2 }}
      >
        <ArtCard art={ART.chaosScene} opacity={0.35} overlay="rgba(0,0,0,0.55)" className="rounded-2xl">
          <div className="max-h-[80vh] overflow-y-auto -m-1 p-1">
            <div className="flex items-start gap-4 mb-4">
              {url && (
                <img
                  src={url}
                  alt=""
                  className="w-20 h-20 rounded-lg object-cover border border-white/15 flex-shrink-0"
                />
              )}
              <div className="min-w-0 flex-1">
                <h3 className="heading-luxury text-lg text-white mb-1 truncate">{row.name}</h3>
                <p className="text-white/50 text-[11px] truncate">{row.file_name}</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className={LABEL}>Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={INPUT}
                  placeholder="Token name"
                />
              </div>

              <div>
                <label className={LABEL}>Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="Optional per-token description"
                  className={`${INPUT} resize-none`}
                />
              </div>

              <div>
                <label className={LABEL}>Attributes ({attrs.length})</label>
                <div className="space-y-2 mt-1">
                  {attrs.map((a, i) => (
                    <div key={i} className="flex gap-2">
                      <input
                        value={a.trait_type}
                        onChange={(e) => updateAttr(i, { trait_type: e.target.value })}
                        placeholder="trait_type"
                        className={`${INPUT} flex-1`}
                      />
                      <input
                        value={String(a.value)}
                        onChange={(e) => updateAttr(i, { value: e.target.value })}
                        placeholder="value"
                        className={`${INPUT} flex-1`}
                      />
                      <button
                        type="button"
                        onClick={() => removeAttr(i)}
                        className="px-2.5 rounded-lg text-xs text-white/60 hover:text-red-300 border border-white/10 hover:border-red-400/40 bg-black/40"
                        aria-label={`Remove attribute ${i + 1}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addAttr}
                    className="w-full py-2 rounded-lg text-[12px] text-white/70 border border-dashed border-white/20 hover:border-emerald-500/50 hover:text-white bg-black/30 transition-colors"
                  >
                    + Add attribute
                  </button>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-5 mt-4 border-t border-white/10">
              <button
                type="button"
                onClick={onCancel}
                className="px-5 py-2 rounded-lg text-xs text-white/70 hover:text-white border border-white/15 bg-black/30"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                className={`px-6 py-2 rounded-xl text-sm ${BTN_EMERALD}`}
              >
                Save
              </button>
            </div>
          </div>
        </ArtCard>
      </m.div>
    </m.div>
  );
}
