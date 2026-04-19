import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CsvRow } from '../../../lib/nftMetadata';
import { matchCsvToFiles } from '../../../lib/nftMetadata';

const COLS = 6;
const ROW_HEIGHT = 120; // px — square thumb + label bar
const OVERSCAN = 10;    // rows above/below viewport
const VIEWPORT_MAX_H = 520;

interface MatchedPair {
  row: CsvRow;
  file: File;
  index: number; // original index in state.rows, preserved for EDIT_ROW dispatch
}

export function MetadataGrid({
  rows,
  files,
  onSelect,
}: {
  rows: CsvRow[];
  files: File[];
  onSelect: (index: number) => void;
}) {
  // matchCsvToFiles returns matched pairs in row order; carry the original
  // index so the TraitEditor can target the right row in wizard state.
  const items = useMemo<MatchedPair[]>(() => {
    const { matched } = matchCsvToFiles(rows, files);
    const byFileName = new Map(matched.map((m) => [m.row.file_name, m]));
    const out: MatchedPair[] = [];
    rows.forEach((row, index) => {
      const hit = byFileName.get(row.file_name);
      if (hit) out.push({ row: hit.row, file: hit.file, index });
    });
    return out;
  }, [rows, files]);

  const rowCount = Math.ceil(items.length / COLS);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  if (items.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      className="relative overflow-auto rounded-lg border border-white/10 bg-black/20"
      style={{ maxHeight: VIEWPORT_MAX_H }}
    >
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vRow) => {
          const start = vRow.index * COLS;
          const slice = items.slice(start, start + COLS);
          return (
            <div
              key={vRow.key}
              className="grid gap-2 p-2"
              style={{
                gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vRow.start}px)`,
                height: vRow.size,
              }}
            >
              {slice.map((pair) => (
                <Cell key={pair.row.file_name} pair={pair} onSelect={onSelect} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Cell({ pair, onSelect }: { pair: MatchedPair; onSelect: (i: number) => void }) {
  // Object URL is cheap, but we revoke on unmount so the GC can free the File
  // reference once a row scrolls out of the virtual window.
  const url = useMemo(() => URL.createObjectURL(pair.file), [pair.file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  return (
    <button
      type="button"
      onClick={() => onSelect(pair.index)}
      className="relative aspect-square rounded-lg overflow-hidden border border-white/10 bg-black/40 group focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
      aria-label={`Edit ${pair.row.name}`}
    >
      <img
        src={url}
        alt=""
        loading="lazy"
        className="absolute inset-0 w-full h-full object-cover transition-transform group-hover:scale-[1.04]"
      />
      <div
        className="absolute bottom-0 left-0 right-0 p-1.5 text-[10px] text-white truncate"
        style={{ background: 'rgba(0,0,0,0.75)' }}
      >
        {pair.row.name}
      </div>
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-emerald-500/10 ring-1 ring-inset ring-emerald-400/60 pointer-events-none" />
    </button>
  );
}
