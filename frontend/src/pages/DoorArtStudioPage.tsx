import { useState, useMemo, useEffect, useCallback } from 'react';
import type { ArtPiece } from '../lib/artConfig';
import { BUNGALOWS } from '../lib/bungalows';
import { DOOR_ART_OVERRIDES, type DoorArtOverride } from '../lib/bungalowDoorArt';
import { resolveDoorArt, islandArtList } from '../lib/doorArt';
import { artSrcSet } from '../lib/artSrcSet';

/**
 * The door studio — /door-studio.
 *
 * The two surface studios aim at cards INSIDE one bungalow. This one aims at
 * the island's front page: the thirteen door tiles in VenueDoors and the rows
 * in BungalowPicker, which are the first picture anyone sees of a resident.
 *
 * Why it draws from every pool at once. A door is a shop window, not a surface
 * belonging to the resident behind it — the right picture for the QR card may
 * come from another resident's drop or from classic art. So the picker is the
 * whole island's art, filterable by which folder it came from, rather than one
 * pool. That is also why this is a separate page instead of a tab in the
 * bungalow studio: there, the pool IS the bungalow, and here it must not be.
 *
 * Doors were unreachable from any studio before this — `thumb` and
 * `thumbPosition` are hand-written on the registry entry in bungalows.ts, and
 * nothing read an override for them.
 *
 * SCALE IS DELIBERATELY ABSENT. The door tiles render object-cover with an
 * object-position and nothing else; a zoom slider here would accept a value
 * that no card applies. The surface studios have one because their surfaces
 * honour it.
 */

const STORAGE_KEY = 'door-art-studio:draft';
const HAS_SAVE_MIDDLEWARE = import.meta.env.DEV;

/** Which folder a piece came from — the picker's filter, and its caption. */
function sourceOf(piece: ArtPiece): string {
  const m = /^\/art\/([a-z0-9-]+)\//.exec(piece.src);
  return m ? m[1]! : 'classic';
}

function parsePosition(pos: string | undefined): [number, number] {
  if (!pos) return [50, 50];
  const m = /^\s*(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*$/.exec(pos);
  return m ? [Number(m[1]), Number(m[2])] : [50, 50];
}
const formatPosition = (x: number, y: number) => `${x}% ${y}%`;

/**
 * Client-side render of the overrides module — KEEP IN LOCK-STEP with
 * `doorStudioPlugin` in vite.config.ts, so an exported file and a
 * middleware-written file are byte-identical for identical picks.
 */
function renderDoorModule(data: Record<string, DoorArtOverride>): string {
  const entries = Object.keys(data).sort().map((k) => {
    const v = data[k]!;
    const pos = v.objectPosition ? `, objectPosition: ${JSON.stringify(v.objectPosition)}` : '';
    return `  ${JSON.stringify(k)}: { artId: ${JSON.stringify(v.artId)}${pos} },`;
  }).join('\n');
  return `/**
 * Per-bungalow DOOR art overrides — written by /door-studio.
 *
 * Key format: the bungalow id alone (e.g. "qr"). One door per resident.
 *
 * \`artId\` resolves against EVERY bungalow's pool and then the classic ART map,
 * because a door is the island's own shop window: the right picture for the QR
 * card may well come from another resident's drop, or from classic art. See
 * doorArt.ts for the resolver and the id-uniqueness guarantee it relies on.
 *
 * Surfaces NOT listed here fall back to the \`thumb\` / \`thumbPosition\` written on
 * the registry entry in bungalows.ts, which is where every door started.
 *
 * Do not hand-edit during a studio session — the studio overwrites this file on save.
 */
export type DoorArtOverride = {
  artId: string;
  objectPosition?: string;
};

export const DOOR_ART_OVERRIDES: Record<string, DoorArtOverride> = {
${entries}
};
`;
}

export default function DoorArtStudioPage() {
  const art = useMemo(() => islandArtList(), []);
  const sources = useMemo(() => {
    const set = new Set<string>(['All']);
    art.forEach((p) => set.add(sourceOf(p)));
    return Array.from(set);
  }, [art]);

  const [overrides, setOverrides] = useState<Record<string, DoorArtOverride>>(() => {
    try {
      const draft = localStorage.getItem(STORAGE_KEY);
      if (draft) return { ...DOOR_ART_OVERRIDES, ...JSON.parse(draft) as Record<string, DoorArtOverride> };
    } catch { /* ignore a corrupt draft */ }
    return { ...DOOR_ART_OVERRIDES };
  });
  const [selectedId, setSelectedId] = useState<string>(BUNGALOWS[0]?.id ?? '');
  const [filter, setFilter] = useState('All');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch { /* quota */ }
  }, [overrides]);

  const selected = useMemo(
    () => BUNGALOWS.find((b) => b.id === selectedId) ?? BUNGALOWS[0]!,
    [selectedId],
  );

  // What the door shows RIGHT NOW under the working draft, resolved exactly the
  // way the island resolves it — including the fall back to the registry thumb
  // when a pick does not resolve. The preview must not be more forgiving than
  // the page it is previewing.
  const current = useMemo(
    () => resolveDoorArt(selected, overrides),
    [overrides, selected],
  );

  const [posX, posY] = parsePosition(current.objectPosition);

  const setPosition = useCallback((x: number, y: number) => {
    setOverrides((prev) => {
      const existing = prev[selected.id];
      // Framing a door that has no pick yet means keeping the registry thumb and
      // only moving it — but an override must name an artId. Only surfaces whose
      // thumb is a piece the island knows can be framed without picking first.
      const artId = existing?.artId ?? art.find((p) => p.src === selected.thumb)?.id;
      if (!artId) return prev;
      return { ...prev, [selected.id]: { artId, objectPosition: formatPosition(x, y) } };
    });
  }, [selected, art]);

  const pick = useCallback((piece: ArtPiece) => {
    setOverrides((prev) => ({
      ...prev,
      [selected.id]: { artId: piece.id, objectPosition: prev[selected.id]?.objectPosition },
    }));
  }, [selected]);

  const clear = useCallback(() => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[selected.id];
      return next;
    });
  }, [selected]);

  const canFrame = Boolean(overrides[selected.id] ?? art.find((p) => p.src === selected.thumb));

  const saveToDisk = useCallback(async (data: Record<string, DoorArtOverride>) => {
    setSaving(true);
    setSaveMsg(null);
    if (!HAS_SAVE_MIDDLEWARE) {
      try {
        const blob = new Blob([renderDoorModule(data)], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bungalowDoorArt.ts';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        setSaveMsg(`Exported ${Object.keys(data).length} doors — send the downloaded file back to the island.`);
      } catch (err) {
        setSaveMsg(`Export failed: ${(err as Error).message}`);
      } finally {
        setSaving(false);
      }
      return;
    }
    try {
      const res = await fetch('/__door-studio/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json() as { count: number };
      setSaveMsg(`Saved ${json.count} doors to src/lib/bungalowDoorArt.ts`);
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    } catch (err) {
      setSaveMsg(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, []);

  const visibleArt = useMemo(
    () => filter === 'All' ? art : art.filter((p) => sourceOf(p) === filter),
    [art, filter],
  );
  const placed = Object.keys(overrides).length;

  return (
    <div className="min-h-screen bg-[#060c1a] text-white">
      <header className="flex items-center gap-3 flex-wrap px-4 py-2 border-b border-white/10">
        <h1 className="text-sm font-bold">Door Studio</h1>
        <span className="text-[11px] text-white/50">
          {placed} of {BUNGALOWS.length} doors repicked · {art.length} pieces from every bungalow
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={clear}
            className="text-[11px] px-2 py-1 rounded bg-white/10 hover:bg-white/20"
          >
            Reset {selected.name}
          </button>
          <button
            type="button"
            onClick={() => void saveToDisk(overrides)}
            disabled={saving}
            className="text-[11px] px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 font-semibold"
          >
            {saving ? 'Saving…' : HAS_SAVE_MIDDLEWARE ? 'Save to disk' : 'Export doors'}
          </button>
        </div>
      </header>
      {saveMsg && <div className="px-4 py-1 text-[11px] text-emerald-300 bg-emerald-500/10">{saveMsg}</div>}

      <div className="flex flex-col md:flex-row">
        {/* The doors */}
        <nav className="md:w-64 border-b md:border-b-0 md:border-r border-white/10 max-h-[40vh] md:max-h-none overflow-y-auto">
          {BUNGALOWS.map((b) => {
            const d = overrides[b.id]
              ? art.find((p) => p.id === overrides[b.id]!.artId)
              : undefined;
            const thumb = d?.src ?? b.thumb;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelectedId(b.id)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-[11px] border-l-2 ${
                  b.id === selected.id ? 'bg-white/10 border-emerald-500' : 'border-transparent hover:bg-white/5'
                }`}
              >
                <img src={thumb} alt="" width={40} height={24} loading="lazy" className="w-10 h-6 object-cover rounded" />
                <span className="flex-1 truncate">{b.name}</span>
                {overrides[b.id] && <span className="text-emerald-400 text-[9px]">picked</span>}
              </button>
            );
          })}
        </nav>

        <main className="flex-1 p-3 min-w-0">
          {/* Door preview, rendered at the real card's aspect. */}
          <div className="mb-2 text-[11px] text-white/60">
            {selected.name} — door tile preview
          </div>
          <div className="w-full max-w-[420px] rounded-lg overflow-hidden border border-white/15">
            <div className="h-32 w-full overflow-hidden bg-black">
              <img
                src={current.src}
                {...(artSrcSet(current.src)
                  ? { srcSet: artSrcSet(current.src), sizes: '420px' }
                  : {})}
                alt=""
                className="w-full h-full object-cover"
                style={current.objectPosition ? { objectPosition: current.objectPosition } : undefined}
              />
            </div>
            <div className="p-2.5 bg-white/5">
              <div className="text-[13px] font-semibold">{selected.name}</div>
              <div className="text-[10px] text-white/50">{selected.tagline}</div>
            </div>
          </div>

          <div className="mt-3 max-w-[420px] space-y-1">
            <label className="flex items-center gap-2 text-[11px]">
              <span className="w-4">X</span>
              <input
                type="range" min={0} max={100} value={posX} disabled={!canFrame}
                onChange={(e) => setPosition(Number(e.target.value), posY)}
                className="flex-1 accent-emerald-500 disabled:opacity-40"
              />
              <span className="w-10 text-right tabular-nums">{posX}%</span>
            </label>
            <label className="flex items-center gap-2 text-[11px]">
              <span className="w-4">Y</span>
              <input
                type="range" min={0} max={100} value={posY} disabled={!canFrame}
                onChange={(e) => setPosition(posX, Number(e.target.value))}
                className="flex-1 accent-emerald-500 disabled:opacity-40"
              />
              <span className="w-10 text-right tabular-nums">{posY}%</span>
            </label>
            {!canFrame && (
              <p className="text-[10px] text-white/40">
                This door still shows its registry thumb, which is not a piece in any pool — pick a
                picture below before framing it.
              </p>
            )}
          </div>

          {/* Picker — the whole island's art. */}
          <div className="mt-4 border-t border-white/10 pt-3">
            <div className="flex items-center gap-2 flex-wrap text-[11px] mb-2">
              <span className="font-semibold">Island art ({visibleArt.length})</span>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="bg-white/10 rounded px-2 py-0.5 text-[11px]"
              >
                {sources.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-8 gap-1.5 max-h-[46vh] overflow-y-auto">
              {visibleArt.map((piece) => (
                <button
                  key={piece.id}
                  type="button"
                  onClick={() => pick(piece)}
                  title={`${piece.id} — ${sourceOf(piece)}`}
                  className={`aspect-[3/2] overflow-hidden rounded border ${
                    overrides[selected.id]?.artId === piece.id
                      ? 'border-emerald-500'
                      : 'border-white/10 hover:border-white/40'
                  }`}
                >
                  <img
                    src={piece.src}
                    {...(artSrcSet(piece.src) ? { srcSet: artSrcSet(piece.src), sizes: '120px' } : {})}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
