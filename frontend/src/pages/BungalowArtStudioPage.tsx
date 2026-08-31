import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { ART, type ArtPiece } from '../lib/artConfig';
import type { ArtOverride } from '../lib/artOverrides';
import { BUNGALOW_ART_OVERRIDES, bungalowOverrideKey } from '../lib/bungalowArtOverrides';
import { BUNGALOWS, BUNGALOW_STORAGE_KEY } from '../lib/bungalows';
import {
  SURFACES,
  formatPosition,
  groupBy,
  parsePosition,
  surfaceKey,
} from '../lib/artSurfaces';
import { LivePreview } from '../components/studio/LivePreview';

/**
 * The bungalow art studio — /bayla-studio.
 *
 * Same tool as /art-studio, aimed at a bungalow SKIN instead of the classic
 * art system. The difference that makes a second page necessary:
 *
 *   When a bungalow with an `artPool` is active, pageArt() short-circuits into
 *   that pool. Before this tool existed the only thing deciding which piece
 *   landed on which surface was a hash of the pageId — there was no way to
 *   pick, pan, or zoom a single Bayla image. Picks made here are written to
 *   src/lib/bungalowArtOverrides.ts keyed `bungalowId|pageId:idx`, so the two
 *   skins never overwrite each other.
 *
 * Two surfaces (nav-logo, loader) are SHARED — bungalows never repaint them —
 * so they're shown disabled rather than silently doing nothing.
 */

const STORAGE_KEY = 'bungalow-art-studio:draft';

/**
 * ISLAND ORDER 2026-08-31: the studio ships to PROD as an unlisted,
 * export-only room. The dev middleware (`/__bungalow-studio/save`, which
 * writes source) exists only under vite dev; on the live venue the same
 * Save action instead EXPORTS the complete `bungalowArtOverrides.ts`
 * module as a download, so a non-technical curator can place art with
 * their own eye in a real browser and hand one file back to the repo.
 * Server-side the prod studio touches nothing.
 */
const HAS_SAVE_MIDDLEWARE = import.meta.env.DEV;

/**
 * Client-side render of the overrides module — KEEP IN LOCK-STEP with
 * `bungalowStudioPlugin` in vite.config.ts (same header, same sorted-key
 * entry shape) so an exported file and a middleware-written file are
 * byte-identical for identical picks.
 */
function renderOverridesModule(data: Record<string, ArtOverride>): string {
  const entries = Object.keys(data).sort().map((k) => {
    const v = data[k]!;
    const pos = v.objectPosition ? `, objectPosition: ${JSON.stringify(v.objectPosition)}` : '';
    const scale = v.scale && v.scale !== 1 ? `, scale: ${v.scale}` : '';
    return `  ${JSON.stringify(k)}: { artId: ${JSON.stringify(v.artId)}${pos}${scale} },`;
  }).join('\n');
  return `/**
 * Per-bungalow, per-surface art overrides — written by /bayla-studio.
 *
 * Key format: \`\${bungalowId}|\${pageId}:\${idx}\`.
 *   e.g. "bayla|farm:0" — the /farm page background, in the Bayla skin.
 *
 * Why a second file instead of reusing ART_OVERRIDES: a bungalow paints every
 * surface from its OWN pool (see bungalows.ts \`artPool\`), so the classic art
 * ids in ART_OVERRIDES don't exist in that pool. Keying by bungalow keeps the
 * two skins from overwriting each other — the classic picks stay exactly as
 * they are while a bungalow gets its own placement.
 *
 * \`artId\` resolves against the active bungalow's pool first, then falls back to
 * the classic ART map (so a bungalow may deliberately borrow a classic piece).
 * Unresolvable ids fall through to the deterministic rotation, same as classic.
 *
 * Do not hand-edit during a studio session — the studio overwrites this file on save.
 */
import type { ArtOverride } from './artOverrides';

export type { ArtOverride };

export const BUNGALOW_ART_OVERRIDES: Record<string, ArtOverride> = {
${entries}
};

/** Key builder — keep in lock-step with the studio and the vite save endpoint. */
export function bungalowOverrideKey(bungalowId: string, pageId: string, idx: number): string {
  return \`\${bungalowId}|\${pageId}:\${idx}\`;
}
`;
}

/** bungalows.ts keeps these on the classic art system in every skin. */
const SHARED_PAGE_IDS = new Set(['nav-logo', 'loader']);

const CLASSIC_LIST: ArtPiece[] = Object.values(ART);

/**
 * pageArt()'s bungalow branch, reimplemented against an explicit overrides map
 * and an explicit bungalow. The real one reads localStorage to find the active
 * skin; the studio must render a skin it is not itself wearing, so it resolves
 * deterministically instead. Keep the two in lock-step (artConfig.ts).
 */
function bungalowArtWith(
  overrides: Record<string, ArtOverride>,
  bungalowId: string,
  pool: ArtPiece[],
  pageId: string,
  idx: number,
): ArtPiece {
  const o = overrides[bungalowOverrideKey(bungalowId, pageId, idx)];
  if (o) {
    const picked = pool.find((p) => p.id === o.artId)
      ?? CLASSIC_LIST.find((p) => p.id === o.artId);
    if (picked) {
      if (o.objectPosition || o.scale) {
        return {
          ...picked,
          ...(o.objectPosition ? { objectPosition: o.objectPosition } : {}),
          ...(o.scale ? { scale: o.scale } : {}),
        };
      }
      return picked;
    }
  }
  let hash = 5381;
  for (let i = 0; i < pageId.length; i++) {
    hash = ((hash * 33) ^ pageId.charCodeAt(i)) >>> 0;
  }
  return pool[((hash % pool.length) + idx) % pool.length]!;
}

export default function BungalowArtStudioPage({ bungalowId = 'bayla' }: { bungalowId?: string }) {
  const bungalow = useMemo(() => BUNGALOWS.find((b) => b.id === bungalowId), [bungalowId]);
  const pool = bungalow?.artPool ?? [];

  // The draft holds EVERY bungalow's overrides, not just this one — saving
  // rewrites the whole file, so dropping other bungalows' keys would delete
  // their picks. Only keys for `bungalowId` are ever mutated here.
  const [overrides, setOverrides] = useState<Record<string, ArtOverride>>(() => {
    try {
      const draft = localStorage.getItem(STORAGE_KEY);
      if (draft) return { ...BUNGALOW_ART_OVERRIDES, ...JSON.parse(draft) };
    } catch {/* ignore */}
    return { ...BUNGALOW_ART_OVERRIDES };
  });

  const editableSurfaces = useMemo(
    () => SURFACES.filter((s) => !SHARED_PAGE_IDS.has(s.pageId)),
    [],
  );
  const [selectedKey, setSelectedKey] = useState<string>(surfaceKey(editableSurfaces[0]!));
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [filterGroup, setFilterGroup] = useState<string>('All');
  const [previewMode, setPreviewMode] = useState<'art' | 'live'>('art');
  const [zen, setZen] = useState(false);
  const [iframeNonce, setIframeNonce] = useState(0);
  const [autoSave, setAutoSave] = useState(HAS_SAVE_MIDDLEWARE);
  // Browse the classic art map too — the resolver falls back to it, so a
  // bungalow surface may deliberately borrow a classic piece.
  const [showClassic, setShowClassic] = useState(false);

  useEffect(() => {
    if (!zen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZen(false); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [zen]);

  // Skip the AppLoader splash inside the preview iframes (same-origin, so they
  // share this window's sessionStorage).
  useEffect(() => {
    try { sessionStorage.setItem('tf_loaded', '1'); } catch {/* ignore */}
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch {/* ignore */}
  }, [overrides]);

  const saveToDisk = useCallback(async (data: Record<string, ArtOverride>, silent: boolean): Promise<void> => {
    if (!silent) { setSaving(true); setSaveMsg(null); }
    // PROD (no dev middleware): Save = export the module as a download.
    // The curator DMs the file back; it lands in the repo as-is.
    if (!HAS_SAVE_MIDDLEWARE) {
      if (silent) { setSaving(false); return; } // nothing to auto-save against in prod
      try {
        const file = renderOverridesModule(data);
        const blob = new Blob([file], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bungalowArtOverrides.ts';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        setSaveMsg(`Exported ${Object.keys(data).length} placements — send the downloaded file back to the island.`);
      } catch (err) {
        setSaveMsg(`Export failed: ${(err as Error).message}`);
      } finally {
        setSaving(false);
      }
      return;
    }
    try {
      const res = await fetch('/__bungalow-studio/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json() as { ok: boolean; count: number };
      if (!silent) {
        setSaveMsg(`Saved ${json.count} overrides to src/lib/bungalowArtOverrides.ts`);
        try { localStorage.removeItem(STORAGE_KEY); } catch {/* ignore */}
      }
      setIframeNonce((n) => n + 1);
    } catch (err) {
      setSaveMsg(`Save failed: ${(err as Error).message}`);
    } finally {
      if (!silent) setSaving(false);
    }
  }, []);

  // Debounced auto-save, same contract as /art-studio: any pick or slider drag
  // lands on disk 350ms after activity stops. Skips the initial mount.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!autoSave) return;
    if (!didMountRef.current) { didMountRef.current = true; return; }
    const t = setTimeout(() => { void saveToDisk(overrides, true); }, 350);
    return () => clearTimeout(t);
  }, [overrides, autoSave, saveToDisk]);

  const selected = useMemo(
    () => editableSurfaces.find((s) => surfaceKey(s) === selectedKey) ?? editableSurfaces[0]!,
    [editableSurfaces, selectedKey],
  );
  const fullKey = bungalowOverrideKey(bungalowId, selected.pageId, selected.idx);
  const selectedOverride = overrides[fullKey];
  const currentArt = bungalowArtWith(overrides, bungalowId, pool, selected.pageId, selected.idx);
  const [posX, posY] = parsePosition(selectedOverride?.objectPosition ?? currentArt.objectPosition);
  const currentScale = selectedOverride?.scale ?? currentArt.scale ?? 1;

  const groups = useMemo(() => {
    const set = new Set<string>(['All']);
    editableSurfaces.forEach((s) => set.add(s.group));
    return Array.from(set);
  }, [editableSurfaces]);
  const visibleSurfaces = useMemo(
    () => filterGroup === 'All' ? editableSurfaces : editableSurfaces.filter((s) => s.group === filterGroup),
    [editableSurfaces, filterGroup],
  );

  const updateOverride = useCallback((key: string, fn: (prev: ArtOverride | undefined) => ArtOverride | null) => {
    setOverrides((prevOverrides) => {
      const next = fn(prevOverrides[key]);
      if (next === null) {
        const { [key]: _removed, ...rest } = prevOverrides;
        return rest;
      }
      return { ...prevOverrides, [key]: next };
    });
  }, []);

  const fallbackArtId = currentArt.id;

  const pickArt = (artId: string) => {
    updateOverride(fullKey, (prev) => ({ ...(prev ?? {}), artId }));
  };

  const setPosition = (x: number, y: number) => {
    updateOverride(fullKey, (prev) => ({
      ...(prev ?? {}),
      artId: prev?.artId ?? fallbackArtId,
      objectPosition: formatPosition(x, y),
    }));
  };

  const setScale = (scale: number) => {
    updateOverride(fullKey, (prev) => {
      const next: ArtOverride = { ...(prev ?? {}), artId: prev?.artId ?? fallbackArtId };
      if (scale !== 1) next.scale = scale;
      else delete next.scale;
      return next;
    });
  };

  const clearOverride = () => updateOverride(fullKey, () => null);

  // Scoped to THIS bungalow — other bungalows' picks in the same file survive.
  const resetThisBungalow = () => {
    if (!confirm(`Clear all ${bungalowId} overrides? Other bungalows are untouched. Writes on the next save.`)) return;
    setOverrides((prev) => Object.fromEntries(
      Object.entries(prev).filter(([k]) => !k.startsWith(`${bungalowId}|`)),
    ));
  };

  const save = () => saveToDisk(overrides, false);

  // Drag anywhere on the preview to place the focal point — the whole reason
  // this tool exists is placement, and 1%-step sliders are a slow way to do it.
  const stageRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  // Plain function on purpose: wrapping it in useCallback would depend on
  // setPosition, which is re-created every render, so the memo never held and
  // the React Compiler bailed out of optimizing the whole component.
  const placeFromEvent = (clientX: number, clientY: number) => {
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const x = Math.round(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
    const y = Math.round(Math.max(0, Math.min(100, ((clientY - r.top) / r.height) * 100)));
    setPosition(x, y);
  };

  const mine = Object.keys(overrides).filter((k) => k.startsWith(`${bungalowId}|`)).length;

  if (!bungalow || pool.length === 0) {
    return (
      <div className="min-h-screen bg-[#060c1a] text-white p-8">
        <h1 className="text-lg font-bold mb-2">Bungalow Art Studio</h1>
        <p className="text-sm text-white/60">
          No bungalow with an art pool matches id <code className="px-1 bg-white/10 rounded">{bungalowId}</code>.
          Give it an <code className="px-1 bg-white/10 rounded">artPool</code> in <code className="px-1 bg-white/10 rounded">lib/bungalows.ts</code> first.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060c1a] text-white relative z-10">
      <header className="sticky top-0 z-20 backdrop-blur bg-black/60 border-b border-white/10 px-4 py-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">{bungalow.name} Studio</h1>
        <span className="text-xs text-white/60">
          {mine} override{mine === 1 ? '' : 's'} · {editableSurfaces.length} surfaces · {pool.length} pieces
        </span>
        {HAS_SAVE_MIDDLEWARE && (
          <label className="text-[11px] text-white/60 flex items-center gap-1 cursor-pointer select-none" title="When on, every pick and drag saves to disk so the Live page reloads.">
            <input
              type="checkbox"
              checked={autoSave}
              onChange={(e) => setAutoSave(e.target.checked)}
              className="accent-emerald-500"
            />
            Auto-save picks
          </label>
        )}
        {HAS_SAVE_MIDDLEWARE && (
          <a href="/art-studio" className="text-[11px] text-white/50 hover:text-white underline">classic studio →</a>
        )}
        <div className="flex-1" />
        {saveMsg && <span className="text-xs text-emerald-300">{saveMsg}</span>}
        <button
          onClick={resetThisBungalow}
          className="text-xs px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10"
        >Reset {bungalowId}</button>
        <button
          onClick={save}
          disabled={saving}
          className="text-xs px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 font-semibold"
        >{saving ? 'Saving…' : HAS_SAVE_MIDDLEWARE ? 'Save to disk' : 'Export placements'}</button>
      </header>

      <div className="flex flex-col lg:flex-row gap-4 p-4">
        {/* Left: surface list */}
        <aside className="lg:w-[360px] flex-shrink-0 bg-white/5 rounded-lg border border-white/10 max-h-[calc(100vh-100px)] overflow-y-auto lg:sticky lg:top-[60px] lg:self-start">
          <div className="sticky top-0 bg-[#0a1424] p-2 border-b border-white/10 z-10">
            <select
              value={filterGroup}
              onChange={(e) => setFilterGroup(e.target.value)}
              style={{ colorScheme: 'dark' }}
              className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white"
            >
              {groups.map((g) => (
                <option key={g} value={g} style={{ backgroundColor: '#0f1524', color: '#e5e7eb' }}>{g}</option>
              ))}
            </select>
          </div>
          {Object.entries(groupBy(visibleSurfaces, (s) => s.group)).map(([group, surfaces]) => (
            <div key={group}>
              <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-white/50 font-semibold">{group}</div>
              {surfaces.map((s) => {
                const key = surfaceKey(s);
                const isSel = key === selectedKey;
                const overridden = !!overrides[bungalowOverrideKey(bungalowId, s.pageId, s.idx)];
                const art = bungalowArtWith(overrides, bungalowId, pool, s.pageId, s.idx);
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedKey(key)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-white/5 ${isSel ? 'bg-emerald-900/40 border-l-2 border-emerald-400' : ''}`}
                  >
                    <img src={art.src} alt="" loading="lazy" className="w-8 h-8 object-cover rounded flex-shrink-0" />
                    <span className="flex-1 truncate">{s.label}</span>
                    {overridden && <span className="text-[9px] text-emerald-400">●</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </aside>

        {/* Right: editor */}
        <main className="flex-1 min-w-0 space-y-4">
          <section
            className={
              zen
                ? 'fixed inset-0 h-[100dvh] z-50 bg-[#060c1a] flex flex-col overflow-hidden'
                : 'bg-white/5 rounded-lg border border-white/10 overflow-hidden'
            }
          >
            <div className="px-4 py-2 border-b border-white/10 flex items-center gap-3 flex-wrap flex-shrink-0">
              <span className="text-xs font-semibold">{selected.label}</span>
              <code className="text-[10px] text-white/50">{fullKey}</code>
              <div className="flex-1" />
              <div className="flex rounded border border-white/10 overflow-hidden text-[11px]">
                <button
                  onClick={() => setPreviewMode('art')}
                  className={`px-2.5 py-1 ${previewMode === 'art' ? 'bg-emerald-700/60 text-white' : 'bg-white/5 text-white/60 hover:text-white'}`}
                >🎨 Art</button>
                <button
                  onClick={() => setPreviewMode('live')}
                  className={`px-2.5 py-1 border-l border-white/10 ${previewMode === 'live' ? 'bg-emerald-700/60 text-white' : 'bg-white/5 text-white/60 hover:text-white'}`}
                  title={`Loads the real route in ?bungalow=${bungalowId}`}
                >📱 Live page</button>
              </div>
              <span className="text-[10px] text-white/40">{currentArt.title}</span>
              <button
                onClick={() => setZen((z) => !z)}
                title={zen ? 'Exit fullscreen (Esc)' : 'Fill the window — for precise crop placement'}
                className="text-[10px] px-2 py-1 rounded bg-white/5 border border-white/10 hover:bg-white/10"
              >{zen ? '⤡ Exit fullscreen' : '⛶ Fullscreen'}</button>
              {selectedOverride && (
                <button
                  onClick={clearOverride}
                  className="text-[10px] px-2 py-1 rounded bg-red-900/40 hover:bg-red-900/60 border border-red-500/30"
                >Clear override</button>
              )}
            </div>

            {previewMode === 'art' ? (
              <>
                <div
                  ref={stageRef}
                  onPointerDown={(e) => {
                    draggingRef.current = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    placeFromEvent(e.clientX, e.clientY);
                  }}
                  onPointerMove={(e) => { if (draggingRef.current) placeFromEvent(e.clientX, e.clientY); }}
                  onPointerUp={(e) => {
                    draggingRef.current = false;
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }}
                  onPointerCancel={() => { draggingRef.current = false; }}
                  className={
                    zen
                      ? 'flex-1 min-h-0 bg-black relative overflow-hidden cursor-crosshair touch-none'
                      : 'h-[62vh] min-h-[320px] bg-black relative overflow-hidden cursor-crosshair touch-none'
                  }
                >
                  <img
                    src={currentArt.src}
                    alt=""
                    draggable={false}
                    className="absolute inset-0 w-full h-full object-cover select-none"
                    style={{
                      objectPosition: formatPosition(posX, posY),
                      transform: currentScale !== 1 ? `scale(${currentScale})` : undefined,
                      transformOrigin: currentScale !== 1 ? formatPosition(posX, posY) : undefined,
                    }}
                  />
                  <div
                    className="absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 border-2 border-white/80 rounded-full pointer-events-none mix-blend-difference"
                    style={{ left: `${posX}%`, top: `${posY}%` }}
                  />
                </div>
                <div className={`p-4 space-y-2 flex-shrink-0 ${zen ? 'border-t border-white/10 bg-black/40' : ''}`}>
                  <div className="flex items-center gap-3 text-xs">
                    <label className="w-12 text-white/60">X</label>
                    <input
                      type="range" min={0} max={100} value={posX}
                      onChange={(e) => setPosition(parseInt(e.target.value, 10), posY)}
                      className="flex-1"
                    />
                    <span className="w-12 text-right tabular-nums">{posX}%</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <label className="w-12 text-white/60">Y</label>
                    <input
                      type="range" min={0} max={100} value={posY}
                      onChange={(e) => setPosition(posX, parseInt(e.target.value, 10))}
                      className="flex-1"
                    />
                    <span className="w-12 text-right tabular-nums">{posY}%</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <label className="w-12 text-white/60" title="Zoom in to free up X/Y panning. With cover, panning only works in the axis where the image overflows the container — zoom > 1 gives both axes overflow.">Zoom</label>
                    <input
                      type="range" min={100} max={300} step={5} value={Math.round(currentScale * 100)}
                      onChange={(e) => setScale(parseInt(e.target.value, 10) / 100)}
                      className="flex-1"
                    />
                    <span className="w-12 text-right tabular-nums">{currentScale.toFixed(2)}x</span>
                  </div>
                  <p className="text-[10px] text-white/40 italic">
                    <strong>Drag on the image</strong> to place the focal point, or use the sliders. X panning only
                    moves once the image overflows its container — bump <strong>Zoom</strong> above 1.0x to free both axes.
                  </p>
                </div>
              </>
            ) : (
              <LivePreview
                pageId={selected.pageId}
                surfaceKey={surfaceKey(selected)}
                artSrc={currentArt.src}
                nonce={iframeNonce}
                query={{ bungalow: bungalowId }}
              />
            )}
          </section>

          {/* Art picker */}
          <section className="bg-white/5 rounded-lg border border-white/10">
            <div className="px-4 py-2 border-b border-white/10 text-xs font-semibold flex items-center gap-3 flex-wrap">
              <span>{bungalow.name} art ({pool.length} pieces)</span>
              <label className="text-[11px] font-normal text-white/60 flex items-center gap-1 cursor-pointer select-none" title="The resolver falls back to the classic ART map, so a bungalow surface can deliberately borrow a classic piece.">
                <input
                  type="checkbox"
                  checked={showClassic}
                  onChange={(e) => setShowClassic(e.target.checked)}
                  className="accent-emerald-500"
                />
                also show classic art
              </label>
            </div>
            <div className="p-3 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
              {(showClassic ? [...pool, ...CLASSIC_LIST] : pool).map((piece) => {
                const isPicked = (selectedOverride?.artId ?? currentArt.id) === piece.id;
                return (
                  <button
                    key={piece.id}
                    onClick={() => pickArt(piece.id)}
                    title={`${piece.title} (${piece.id})`}
                    className={`relative aspect-square overflow-hidden rounded border-2 transition ${isPicked ? 'border-emerald-400 ring-2 ring-emerald-400/40' : 'border-white/10 hover:border-white/40'}`}
                  >
                    <img src={piece.src} alt={piece.title} loading="lazy" className="w-full h-full object-cover" />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1">
                      <div className="text-[9px] truncate text-white/90">{piece.id}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <SkinFootnote bungalowId={bungalowId} />
        </main>
      </div>
    </div>
  );
}

/**
 * The Live-page iframe loads `?bungalow=<id>`, and getActiveBungalow() persists
 * that deep link to localStorage — which this window shares with the iframe.
 * So using the studio quietly puts your own browsing into the skin. Say so, and
 * offer the one click that undoes it.
 */
function SkinFootnote({ bungalowId }: { bungalowId: string }) {
  const [cleared, setCleared] = useState(false);
  return (
    <p className="text-[11px] text-white/40 px-1 pb-4">
      Heads up: previewing a live page sets this browser's skin to <strong>{bungalowId}</strong> (the
      deep link persists). {' '}
      <button
        onClick={() => {
          try { localStorage.removeItem(BUNGALOW_STORAGE_KEY); } catch {/* ignore */}
          setCleared(true);
        }}
        className="underline hover:text-white"
      >Reset my skin to classic</button>
      {cleared && <span className="text-emerald-400"> — cleared, reload the app to see it.</span>}
    </p>
  );
}
