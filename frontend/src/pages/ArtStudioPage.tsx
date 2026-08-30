import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { ART, pageArt, type ArtPiece } from '../lib/artConfig';
import { ART_OVERRIDES, type ArtOverride } from '../lib/artOverrides';
// The surface inventory + small helpers live in lib/artSurfaces so
// /bayla-studio (bungalow skins) reads the exact same list.
import {
  PAGE_ROUTES,
  SURFACES,
  formatPosition,
  groupBy,
  parsePosition,
  surfaceKey,
} from '../lib/artSurfaces';
import { LivePreview } from '../components/studio/LivePreview';

const ART_LIST: ArtPiece[] = Object.values(ART);

const STORAGE_KEY = 'art-studio:draft';

export default function ArtStudioPage() {
  const [overrides, setOverrides] = useState<Record<string, ArtOverride>>(() => {
    try {
      const draft = localStorage.getItem(STORAGE_KEY);
      if (draft) return { ...ART_OVERRIDES, ...JSON.parse(draft) };
    } catch {/* ignore */}
    return { ...ART_OVERRIDES };
  });
  const [selectedKey, setSelectedKey] = useState<string>(surfaceKey(SURFACES[0]!));
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [filterGroup, setFilterGroup] = useState<string>('All');
  const [previewMode, setPreviewMode] = useState<'art' | 'live'>('art');
  // Blows the preview up to the whole window so the crop can actually be
  // judged — a 45vh strip is too small to place art precisely.
  const [zen, setZen] = useState(false);
  // Bumped after each successful save → iframe key changes → forces reload
  // so the live preview reflects what just got written to disk.
  const [iframeNonce, setIframeNonce] = useState(0);
  const [autoSave, setAutoSave] = useState(true);

  // Esc leaves fullscreen. Locking body scroll also drops the page's scrollbar
  // gutter, which otherwise shows a sliver of the grid under the overlay.
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

  // Skip the AppLoader splash inside iframes (it gates on sessionStorage).
  // Same-origin iframes share sessionStorage with this top-level window.
  useEffect(() => {
    try { sessionStorage.setItem('tf_loaded', '1'); } catch {/* ignore */}
  }, []);

  // Persist drafts to localStorage on every change so a refresh doesn't lose work.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch {/* ignore */}
  }, [overrides]);

  // Debounced auto-save: any state change (art pick OR position slider drag)
  // is committed to disk 350ms after activity stops. Skips the initial mount.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!autoSave) return;
    if (!didMountRef.current) { didMountRef.current = true; return; }
    const t = setTimeout(() => { void saveToDisk(overrides, true); }, 350);
    return () => clearTimeout(t);
  }, [overrides, autoSave]);

  const selected = useMemo(
    () => SURFACES.find((s) => surfaceKey(s) === selectedKey) ?? SURFACES[0]!,
    [selectedKey],
  );
  const selectedOverride = overrides[selectedKey];
  const currentArt = pageArtWith(overrides, selected.pageId, selected.idx);
  const [posX, posY] = parsePosition(selectedOverride?.objectPosition ?? currentArt.objectPosition);
  const currentScale = selectedOverride?.scale ?? currentArt.scale ?? 1;

  const groups = useMemo(() => {
    const set = new Set<string>(['All']);
    SURFACES.forEach((s) => set.add(s.group));
    return Array.from(set);
  }, []);
  const visibleSurfaces = useMemo(
    () => filterGroup === 'All' ? SURFACES : SURFACES.filter((s) => s.group === filterGroup),
    [filterGroup],
  );

  // Functional updater so concurrent slider/pick changes merge against the
  // latest state, not a closure-captured snapshot.
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
    updateOverride(selectedKey, (prev) => ({ ...(prev ?? {}), artId }));
  };

  const setPosition = (x: number, y: number) => {
    updateOverride(selectedKey, (prev) => ({
      ...(prev ?? {}),
      artId: prev?.artId ?? fallbackArtId,
      objectPosition: formatPosition(x, y),
    }));
  };

  const setScale = (scale: number) => {
    updateOverride(selectedKey, (prev) => {
      const next: ArtOverride = { ...(prev ?? {}), artId: prev?.artId ?? fallbackArtId };
      if (scale !== 1) next.scale = scale;
      else delete next.scale;
      return next;
    });
  };

  const clearOverride = () => updateOverride(selectedKey, () => null);

  const resetAll = () => {
    if (!confirm('Clear ALL overrides (in-progress drafts and saved picks)? This does not write to disk until you click Save.')) return;
    setOverrides({});
  };

  const saveToDisk = useCallback(async (data: Record<string, ArtOverride>, silent: boolean): Promise<void> => {
    if (!silent) setSaving(true);
    if (!silent) setSaveMsg(null);
    try {
      const res = await fetch('/__art-studio/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json() as { ok: boolean; count: number };
      if (!silent) {
        setSaveMsg(`Saved ${json.count} overrides to src/lib/artOverrides.ts`);
        try { localStorage.removeItem(STORAGE_KEY); } catch {/* ignore */}
      }
      setIframeNonce((n) => n + 1);
    } catch (err) {
      setSaveMsg(`Save failed: ${(err as Error).message}`);
    } finally {
      if (!silent) setSaving(false);
    }
  }, []);

  const save = () => saveToDisk(overrides, false);

  const overrideCount = Object.keys(overrides).length;

  return (
    <div className="min-h-screen bg-[#060c1a] text-white relative z-10">
      {/* Header */}
      <header className="sticky top-0 z-20 backdrop-blur bg-black/60 border-b border-white/10 px-4 py-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">Art Studio</h1>
        <span className="text-xs text-white/60">{overrideCount} override{overrideCount === 1 ? '' : 's'} · {SURFACES.length} surfaces · {ART_LIST.length} pieces</span>
        <label className="text-[11px] text-white/60 flex items-center gap-1 cursor-pointer select-none" title="When on, picking art saves to disk immediately so the Live page reloads.">
          <input
            type="checkbox"
            checked={autoSave}
            onChange={(e) => setAutoSave(e.target.checked)}
            className="accent-emerald-500"
          />
          Auto-save picks
        </label>
        <div className="flex-1" />
        {saveMsg && <span className="text-xs text-emerald-300">{saveMsg}</span>}
        <button
          onClick={resetAll}
          className="text-xs px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10"
        >Reset all</button>
        <button
          onClick={save}
          disabled={saving}
          className="text-xs px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 font-semibold"
        >{saving ? 'Saving…' : 'Save to disk'}</button>
      </header>

      {/* Main split */}
      <div className="flex flex-col lg:flex-row gap-4 p-4">
        {/* Left: surface list */}
        <aside className="lg:w-[360px] flex-shrink-0 bg-white/5 rounded-lg border border-white/10 max-h-[calc(100vh-100px)] overflow-y-auto lg:sticky lg:top-[60px] lg:self-start">
          <div className="sticky top-0 bg-[#0a1424] p-2 border-b border-white/10 z-10">
            <select
              value={filterGroup}
              onChange={(e) => setFilterGroup(e.target.value)}
              // colorScheme:dark makes the browser render the native option popup
              // dark (was light text on the default white popup = unreadable); the
              // per-option colors are an explicit fallback for browsers that ignore it.
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
                const overridden = !!overrides[key];
                const art = pageArtWith(overrides, s.pageId, s.idx);
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
          {/* Preview */}
          <section
            className={
              zen
                // h-[100dvh] rather than inset-0's implied height: the initial
                // containing block is short by the scrollbar gutter, which left
                // a sliver of the picker grid showing under the overlay.
                ? 'fixed inset-0 h-[100dvh] z-50 bg-[#060c1a] flex flex-col overflow-hidden'
                : 'bg-white/5 rounded-lg border border-white/10 overflow-hidden'
            }
          >
            <div className="px-4 py-2 border-b border-white/10 flex items-center gap-3 flex-wrap flex-shrink-0">
              <span className="text-xs font-semibold">{selected.label}</span>
              <code className="text-[10px] text-white/50">pageArt('{selected.pageId}', {selected.idx})</code>
              <div className="flex-1" />
              {/* Mode tabs */}
              <div className="flex rounded border border-white/10 overflow-hidden text-[11px]">
                <button
                  onClick={() => setPreviewMode('art')}
                  className={`px-2.5 py-1 ${previewMode === 'art' ? 'bg-emerald-700/60 text-white' : 'bg-white/5 text-white/60 hover:text-white'}`}
                >🎨 Art</button>
                <button
                  onClick={() => setPreviewMode('live')}
                  className={`px-2.5 py-1 border-l border-white/10 ${previewMode === 'live' ? 'bg-emerald-700/60 text-white' : 'bg-white/5 text-white/60 hover:text-white'}`}
                  title={PAGE_ROUTES[selected.pageId] ? `Loads ${PAGE_ROUTES[selected.pageId]}` : 'No route mapping for this pageId'}
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
                  className={
                    zen
                      ? 'flex-1 min-h-0 bg-black relative overflow-hidden'
                      : 'h-[62vh] min-h-[320px] bg-black relative overflow-hidden'
                  }
                >
                  <img
                    src={currentArt.src}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover"
                    style={{
                      objectPosition: formatPosition(posX, posY),
                      transform: currentScale !== 1 ? `scale(${currentScale})` : undefined,
                      transformOrigin: currentScale !== 1 ? formatPosition(posX, posY) : undefined,
                    }}
                  />
                  {/* Crosshair */}
                  <div
                    className="absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 border-2 border-white/80 rounded-full pointer-events-none mix-blend-difference"
                    style={{ left: `${posX}%`, top: `${posY}%` }}
                  />
                </div>
                {/* Position sliders */}
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
                    X panning only moves when image overflows container — bump <strong>Zoom</strong> above 1.0x to free both axes. Auto-saves to disk.
                  </p>
                </div>
              </>
            ) : (
              <LivePreview
                pageId={selected.pageId}
                surfaceKey={surfaceKey(selected)}
                artSrc={currentArt.src}
                nonce={iframeNonce}
              />
            )}
          </section>

          {/* Art picker grid */}
          <section className="bg-white/5 rounded-lg border border-white/10">
            <div className="px-4 py-2 border-b border-white/10 text-xs font-semibold">
              Pick art ({ART_LIST.length} pieces)
            </div>
            <div className="p-3 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
              {ART_LIST.map((piece) => {
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
        </main>
      </div>
    </div>
  );
}


// pageArt() with a specific overrides map (the live in-memory draft, not the
// imported ART_OVERRIDES from disk). Same resolution semantics as artConfig.
function pageArtWith(overrides: Record<string, ArtOverride>, pageId: string, idx: number): ArtPiece {
  const o = overrides[`${pageId}:${idx}`];
  if (o) {
    const piece = ART_LIST.find((p) => p.id === o.artId);
    if (piece) return o.objectPosition ? { ...piece, objectPosition: o.objectPosition } : piece;
  }
  return pageArt(pageId, idx);
}

