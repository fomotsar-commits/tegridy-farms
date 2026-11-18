// The city's one canvas (lib/city/scene.ts draws it). A drawing, so it is hidden from screen
// readers and takes no keyboard focus: every plot it shows is also a button in the list under it
// (pages/CityPage.tsx), and its zoom is three buttons there.
//
// One finger scrolls the page past it, as on any page; a sideways drag or two fingers move the
// island. A wheel zooms only with Ctrl or Cmd held (a trackpad pinch sends that), so the page
// still scrolls under the pointer.

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { muralOf } from '../../lib/isoMural';
import { reducedMotion } from '../../lib/heat/ticks';
import { createScene, type Scene, type SceneData } from '../../lib/city/scene';
import type { Plan } from '../../lib/city/plan';
import { useOffScreenPause } from '../dwg/offScreen';

export interface CityHandle {
  /** Zoom about the middle of the sheet by a factor. */
  zoomBy: (factor: number) => void;
  /** Show the whole island. */
  fit: () => void;
  /** Bring a plot to the middle. */
  show: (plotId: string) => void;
}
interface Props {
  plan: Plan;
  data: SceneData;
  selectedId: string | null;
  onSelect: (plotId: string) => void;
  /** The visitor stopped the motion. */
  paused: boolean;
}

export const CityCanvas = forwardRef<CityHandle, Props>(function CityCanvas({ plan, data, selectedId, onSelect, paused }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const offScreen = useOffScreenPause(canvasRef);
  // Read by the frame loop, which outlives any one render.
  const still = useRef(false);
  still.current = paused || offScreen;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    // Each room's own picture, for its walls: the one its house wears on Earn (lib/isoMural.ts).
    const pictures = new Map<string, HTMLImageElement>();
    const monoFont = getComputedStyle(canvas).getPropertyValue('--font-family-mono').trim() || 'monospace';
    const scene = createScene({ ctx, plan, monoFont, mural: (id) => pictures.get(id) ?? null });
    sceneRef.current = scene;
    for (const plot of plan.plots) {
      const src = plot.mural ? muralOf(plot.mural, 480)?.src : undefined;
      if (!src) continue;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        pictures.set(plot.mural!, img);
        scene.markDirty();
      };
      img.src = src;
    }

    const size = (): void => {
      const r = canvas.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (!w || !h) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      scene.resize(w, h, dpr);
      scene.render();
    };
    const sized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(size);
    sized?.observe(canvas);
    size();

    /* pointer: drag to move, two fingers to zoom, a press that did not move picks a plot */
    const down = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let pinch: { d: number; z: number; mx: number; my: number } | null = null;
    const at = (e: PointerEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent): void => {
      down.set(e.pointerId, at(e));
      if (down.size === 1) moved = 0;
      else if (down.size === 2) {
        const [a, b] = [...down.values()] as [{ x: number; y: number }, { x: number; y: number }];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: scene.cam.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        moved = 99;
      }
    };
    const onMove = (e: PointerEvent): void => {
      const prev = down.get(e.pointerId);
      if (!prev) return;
      const p = at(e);
      down.set(e.pointerId, p);
      if (down.size === 1) {
        scene.panBy(p.x - prev.x, p.y - prev.y);
        moved += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
      } else if (down.size === 2 && pinch) {
        const [a, b] = [...down.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        scene.panBy(mx - pinch.mx, my - pinch.my);
        pinch.mx = mx;
        pinch.my = my;
        scene.zoomAt(mx, my, (pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / pinch.d);
      }
    };
    const onUp = (e: PointerEvent): void => {
      if (!down.has(e.pointerId)) return;
      if (down.size === 1 && moved < 8 && e.type === 'pointerup') {
        const p = at(e);
        const plot = scene.hit(p.x, p.y);
        if (plot) onSelectRef.current(plot.id);
      }
      down.delete(e.pointerId);
      if (down.size < 2) pinch = null;
    };
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      scene.zoomAt(e.clientX - r.left, e.clientY - r.top, scene.cam.z * Math.exp(-e.deltaY * 0.01));
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    let frame = 0;
    let last = 0;
    const tick = (now: number): void => {
      frame = requestAnimationFrame(tick);
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      scene.flyStep(now);
      // Reduced motion, a pause, or off screen: the clock stops, and the sheet is redrawn only when something changed.
      const moving = !still.current && !reducedMotion();
      if (moving) scene.advance(dt);
      if (moving || scene.isDirty()) scene.render();
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      sized?.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onUp);
      canvas.removeEventListener('wheel', onWheel);
      sceneRef.current = null;
    };
  }, [plan]);

  useEffect(() => {
    sceneRef.current?.setData(data);
  }, [data, plan]);
  useEffect(() => {
    sceneRef.current?.select(selectedId ? (plan.byId.get(selectedId) ?? null) : null);
  }, [selectedId, plan]);

  useImperativeHandle(ref, () => ({
    zoomBy(factor) {
      const scene = sceneRef.current;
      if (!scene) return;
      const { w, h } = scene.size();
      scene.zoomAt(w / 2, h / 2, scene.cam.z * factor);
    },
    fit() {
      sceneRef.current?.fit();
    },
    show(plotId) {
      const plot = plan.byId.get(plotId);
      if (plot) sceneRef.current?.flyTo(plot, performance.now(), reducedMotion());
    },
  }), [plan]);

  return <canvas ref={canvasRef} className="c01-canvas" aria-hidden="true" data-testid="city-canvas" />;
});
