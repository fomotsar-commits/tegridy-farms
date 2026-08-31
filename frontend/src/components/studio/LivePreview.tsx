import { useState, useEffect, useCallback, useRef } from 'react';
import { PAGE_ROUTES } from '../../lib/artSurfaces';

// Viewport presets for the live preview. The iframe is rendered at these exact
// pixel dimensions and then CSS-scaled down to fit the studio pane, so the page
// lays out like a real device instead of like a short, squashed panel.
type PreviewDevice = { id: string; label: string; w: number; h: number };
const PREVIEW_DEVICES: PreviewDevice[] = [
  { id: 'desktop', label: 'Desktop', w: 1440, h: 900 },
  { id: 'ipad', label: 'iPad', w: 820, h: 1180 },
  { id: 'iphone', label: 'iPhone', w: 390, h: 844 },
];

// In-context preview — iframes the actual app route where the surface lives.
// Reflects what's currently saved to disk (drafts apply only after Save).
export function LivePreview({ pageId, surfaceKey: key, artSrc, nonce, query }: {
  pageId: string;
  surfaceKey: string;
  artSrc: string;
  nonce: number;
  /**
   * Extra query params for the iframed route — the bungalow studio passes
   * `bungalow=<id>` so the preview renders in that skin instead of whatever
   * skin this browser last chose.
   */
  query?: Record<string, string>;
}) {
  const route = PAGE_ROUTES[pageId];
  const [deviceId, setDeviceId] = useState('desktop');
  const [located, setLocated] = useState<'pending' | 'exact' | 'byArt' | 'missing'>('pending');
  const [fullPage, setFullPage] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  // Measured scrollHeight of the iframe's document — drives "Full page" height.
  const [docH, setDocH] = useState(0);
  const [paneW, setPaneW] = useState(0);
  const [maxH, setMaxH] = useState(() =>
    typeof window === 'undefined' ? 600 : Math.max(320, Math.round(window.innerHeight * 0.72)),
  );
  const paneRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Latest render's fit-scale, read by focusSurface without making it a dep.
  const scaleRef = useRef(1);

  const device = PREVIEW_DEVICES.find((d) => d.id === deviceId) ?? PREVIEW_DEVICES[0]!;

  // Track how much width the pane actually has, plus a sane max height that
  // follows the window (a short window gets a short — but still fitted — pane).
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setPaneW(entry!.contentRect.width));
    ro.observe(el);
    setPaneW(el.clientWidth);
    const onResize = () => setMaxH(Math.max(320, Math.round(window.innerHeight * 0.72)));
    window.addEventListener('resize', onResize);
    return () => { ro.disconnect(); window.removeEventListener('resize', onResize); };
  }, []);

  // Same-origin iframe → we can read the real document height and grow the
  // frame to it, so "Full page" genuinely shows the whole route.
  const measureDoc = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (doc?.documentElement) setDocH(doc.documentElement.scrollHeight);
  }, []);

  // Measure ONLY while the frame is at the device viewport height. In full-page
  // mode the frame's height *is* docH, so any section sized to 100vh grows with
  // it — re-measuring there feeds back on itself and the page inflates without
  // bound (scale collapses to ~1%). So we freeze the last viewport-mode value.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || fullPage) return;
    let ro: ResizeObserver | undefined;
    const onLoad = () => {
      measureDoc();
      const el = frame.contentDocument?.documentElement;
      if (el) { ro = new ResizeObserver(measureDoc); ro.observe(el); }
    };
    frame.addEventListener('load', onLoad);
    if (frame.contentDocument?.readyState === 'complete') onLoad();
    return () => { frame.removeEventListener('load', onLoad); ro?.disconnect(); };
  }, [measureDoc, fullPage, route, nonce, reloadNonce, deviceId]);

  // Jump the preview to the surface being edited. ArtImg stamps every surface
  // with data-art-surface="pageId:idx"; surfaces rendered through components
  // that take a resolved ArtPiece (not pageId/idx) have no stamp, so we fall
  // back to matching the image file — same picture, right spot on the page.
  const focusSurface = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.body) return false;

    doc.querySelectorAll<HTMLElement>('[data-studio-focus]').forEach((prev) => {
      prev.removeAttribute('data-studio-focus');
      prev.style.outline = '';
      prev.style.outlineOffset = '';
    });

    let hit = doc.querySelector<HTMLElement>(`[data-art-surface="${key}"]`);
    let how: 'exact' | 'byArt' = 'exact';
    if (!hit) {
      const file = artSrc.split('/').pop();
      if (file) {
        hit = [...doc.querySelectorAll<HTMLImageElement>('img')]
          .find((img) => (img.getAttribute('src') ?? '').endsWith(file)) ?? null;
        how = 'byArt';
      }
    }
    if (!hit) { setLocated('missing'); return false; }

    // Outline the card, not the bare <img> — the image is usually a full-bleed
    // background inside the thing you actually recognise on the page.
    const target = (hit.closest<HTMLElement>('[class*="rounded"], section') ?? hit);
    target.setAttribute('data-studio-focus', '');
    target.style.outline = '3px solid #34d399';
    target.style.outlineOffset = '2px';
    hit.scrollIntoView({ block: 'center', inline: 'center' });

    // Full-page mode gives the frame the document's own height, so nothing
    // scrolls inside it — the outer pane has to do the scrolling instead.
    const pane = paneRef.current;
    if (pane) {
      const top = hit.getBoundingClientRect().top + (doc.defaultView?.scrollY ?? 0);
      pane.scrollTop = Math.max(0, top * scaleRef.current - pane.clientHeight / 2);
    }
    setLocated(how);
    return true;
  }, [key, artSrc]);

  // Content streams in (lazy images, async data), so retry a few times rather
  // than trusting a single post-load query.
  useEffect(() => {
    setLocated('pending');
    const timers = [80, 400, 1200, 2500].map((ms) => window.setTimeout(focusSurface, ms));
    return () => timers.forEach(window.clearTimeout);
  }, [focusSurface, route, nonce, reloadNonce, deviceId, fullPage]);

  // Hard ceiling on the full-page height so a runaway measurement can never
  // shrink the preview into an unusable sliver.
  const frameH = fullPage && docH > 0 ? Math.min(docH, device.h * 8) : device.h;
  // Fit to WIDTH, never upscale — shrinking the whole page to fit the pane's
  // height too would render it as an unreadable thumbnail, so the pane scrolls
  // through the full-page frame instead.
  const fitW = paneW > 0 ? paneW / device.w : 1;
  const scale = Math.max(0.15, Math.min(1, fitW) || 1);
  const scaledH = Math.round(frameH * scale);

  useEffect(() => { scaleRef.current = scale; }, [scale]);

  if (!route) {
    return (
      <div className="h-[55vh] flex items-center justify-center text-xs text-white/50 p-4 text-center">
        No route mapping for <code className="mx-1 px-1 bg-white/10 rounded">{pageId}</code> yet.
        Add it to <code className="mx-1 px-1 bg-white/10 rounded">PAGE_ROUTES</code> in lib/artSurfaces.ts.
      </div>
    );
  }

  // Cache-bust the iframe URL on each save so it reloads with fresh overrides.
  const extra = new URLSearchParams({ ...query, _studio: `${nonce}-${reloadNonce}` }).toString();
  const url = `${route}?${extra}`;

  return (
    <div className="bg-black relative">
      <div className="px-3 py-1.5 border-b border-white/10 flex items-center gap-2 text-[10px] text-white/60 flex-wrap">
        <span>{route}</span>
        <span className="text-white/30">·</span>
        <span>Save your pick to see it land here</span>

        <div className="flex rounded border border-white/10 overflow-hidden ml-2">
          {PREVIEW_DEVICES.map((d) => (
            <button
              key={d.id}
              onClick={() => setDeviceId(d.id)}
              title={`${d.w}×${d.h}`}
              className={`px-2 py-0.5 ${d.id !== PREVIEW_DEVICES[0]!.id ? 'border-l border-white/10' : ''} ${
                deviceId === d.id ? 'bg-emerald-700/60 text-white' : 'bg-white/5 hover:text-white'
              }`}
            >{d.label}</button>
          ))}
        </div>

        <label
          className="flex items-center gap-1 cursor-pointer select-none"
          title="Grow the frame to the page's real scroll height and shrink it to fit — the whole route at once. Note: sections sized to 100vh stretch with it."
        >
          <input
            type="checkbox"
            checked={fullPage}
            onChange={(e) => setFullPage(e.target.checked)}
            className="accent-emerald-500"
          />
          Full page
        </label>

        <span className="tabular-nums text-white/40">{Math.round(scale * 100)}%</span>

        <span
          className={
            located === 'exact' ? 'text-emerald-400'
              : located === 'byArt' ? 'text-amber-400'
                : located === 'missing' ? 'text-red-400' : 'text-white/40'
          }
          title={
            located === 'exact' ? 'Scrolled to this exact surface and outlined it'
              : located === 'byArt' ? 'This surface has no data-art-surface stamp — matched by art file instead, so it may land on another card using the same piece'
                : located === 'missing' ? 'Not on the rendered page — it may be behind a wallet connection, a tab, or a feature flag'
                  : 'Looking for this surface…'
          }
        >
          {located === 'exact' ? '◎ located'
            : located === 'byArt' ? '◎ matched by art'
              : located === 'missing' ? '◎ not found' : '◎ …'}
        </span>

        <button
          onClick={() => focusSurface()}
          className="px-2 py-0.5 rounded bg-white/5 border border-white/10 hover:text-white"
        >Jump to it</button>

        <button
          onClick={() => setReloadNonce((n) => n + 1)}
          className="px-2 py-0.5 rounded bg-white/5 border border-white/10 hover:text-white"
        >Reload</button>

        <a
          href={query && Object.keys(query).length ? `${route}?${new URLSearchParams(query).toString()}` : route}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-emerald-400 hover:underline"
        >Open in new tab ↗</a>
      </div>

      {/* Outer pane scrolls; inner box reserves the *scaled* footprint so the
          scrollbars match what you actually see. */}
      <div
        ref={paneRef}
        className="overflow-auto bg-black"
        style={{ height: Math.min(scaledH, maxH) }}
      >
        <div
          style={{
            width: Math.round(device.w * scale),
            height: scaledH,
            marginInline: 'auto',
            position: 'relative',
          }}
        >
          <iframe
            ref={frameRef}
            key={`${route}-${extra}`}
            src={url}
            title={`Live preview: ${route}`}
            style={{
              width: device.w,
              height: frameH,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              position: 'absolute',
              top: 0,
              left: 0,
              border: 0,
              background: '#000',
            }}
          />
        </div>
      </div>
    </div>
  );
}
