// A room's picture on its bungalow (components/farm/IsoBungalow.tsx): which copy of it the walls
// take, its size and lightness read once per page load, and how far a bright one is dimmed at
// rest. The choices are pure functions, so they can be tested without a browser; the reads are
// one small store shared by every model on the page.
import { useEffect, useSyncExternalStore } from 'react';
import { derivedUrl, widthsFor } from './artSrcSet';
import { BUNGALOWS } from './bungalows';
import { doorArt } from './doorArt';

/**
 * Which copy of a picture the walls take, from the device pixels it spans across a wall as the
 * drawing is drawn (components/farm/IsoIsland.tsx measures the drawing once, and asks for each
 * picture's widest wall once its shape is known): the built site keeps 128 and 480 pixel copies
 * of every picture heavy enough to copy (lib/artSrcSet.ts). The 128 is sharp wherever the
 * picture spans no more than 128 device pixels, as on a phone or a desktop at one device pixel
 * per CSS pixel; the 480 above that, or where the span is not known.
 */
export function muralWidth(devicePxAcross: number): 128 | 480 {
  return devicePxAcross > 0 && devicePxAcross <= 128 ? 128 : 480;
}

/** The picture's address at that width: its copy where the build made one, else the original. A dev server has only originals. */
export function muralSrc(src: string, want: 128 | 480, prod: boolean): string {
  if (!prod) return src;
  return widthsFor(src).includes(want) ? derivedUrl(src, want) : src;
}

/** The room's door picture and its own crop, at a given copy's width. */
export function muralOf(roomId: string, want: 128 | 480): { src: string; position?: string } | null {
  const room = BUNGALOWS.find((b) => b.id === roomId);
  if (!room) return null;
  const door = doorArt(room);
  if (!door?.src) return null;
  return { src: muralSrc(door.src, want, import.meta.env.PROD), position: door.objectPosition };
}

/** The mean of Rec. 709 luma over RGBA pixels, on their sRGB values, 0 to 1. */
export function meanLuma(rgba: ArrayLike<number>): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 2 < rgba.length; i += 4) {
    sum += (0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!) / 255;
    n += 1;
  }
  return n ? sum / n : 0;
}

/** The lightness the walls rest at: a brighter picture is brought down to about this. */
export const REST_LUMA = 0.47;
/** The page's black, as luma, which the dimming lays over a picture. */
export const BLACK_LUMA = 0.03;

/**
 * How far a picture is dimmed at rest, so a near-white mural does not outshine a dark one until
 * its own turn (rule one of the model: no house brighter at rest). The page's black laid over a
 * picture of mean m at opacity a gives about m (1 - a) + 0.03 a, so a = (m - REST_LUMA) /
 * (m - 0.03) brings it to REST_LUMA: at most about 0.55, for a white picture. Unread, or
 * already as dark: 0.
 */
export function restDim(m: number | null | undefined): number {
  if (m === null || m === undefined || !Number.isFinite(m) || m <= REST_LUMA) return 0;
  return (m - REST_LUMA) / (m - BLACK_LUMA);
}

/* ─────────────── each picture's size and lightness, read once per page load ─────────────── */

export interface PictureFacts {
  w: number;
  h: number;
  /** Null where the browser would not let the page read the picture's pixels. */
  luma: number | null;
}

const PICTURES = new Map<string, PictureFacts | 'failed'>();
const PENDING = new Set<string>();
const LISTENERS = new Set<() => void>();
let version = 0;

function settle(src: string, facts: PictureFacts | 'failed') {
  PENDING.delete(src);
  PICTURES.set(src, facts);
  version += 1;
  for (const listener of LISTENERS) listener();
}

/** The picture's mean luma, from an 8 by 8 copy; null where a canvas cannot be read. */
function sampleLuma(img: HTMLImageElement): number | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 8, 8);
    return meanLuma(ctx.getImageData(0, 0, 8, 8).data);
  } catch {
    return null;
  }
}

function readPicture(src: string) {
  if (!src || PICTURES.has(src) || PENDING.has(src) || typeof Image === 'undefined') return;
  PENDING.add(src);
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => settle(src, img.naturalWidth > 0 && img.naturalHeight > 0
    ? { w: img.naturalWidth, h: img.naturalHeight, luma: sampleLuma(img) }
    : 'failed');
  img.onerror = () => settle(src, 'failed');
  img.src = src;
}

/** A picture's size and lightness, once read: undefined until then, 'failed' where it would not load. */
export function pictureFacts(src: string): PictureFacts | 'failed' | undefined {
  return src ? PICTURES.get(src) : undefined;
}

/** A picture's size and lightness where read; null while it loads, where it failed, or where none was asked for. */
export function readFacts(src: string | undefined): PictureFacts | null {
  const facts = src ? pictureFacts(src) : undefined;
  return facts && facts !== 'failed' ? facts : null;
}

const subscribe = (listener: () => void) => {
  LISTENERS.add(listener);
  return () => {
    LISTENERS.delete(listener);
  };
};
const snapshot = () => version;

/**
 * Each picture's size and lightness, read once per page load and shared by every model on the
 * page. A component re-renders whenever any picture's read lands, including one that landed
 * between its render and its effect (useSyncExternalStore checks the version after it
 * subscribes). A picture that fails to load is marked failed, and its walls stay brick.
 */
export function usePictures(srcs: readonly string[]): ReadonlyMap<string, PictureFacts | 'failed'> {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const key = srcs.join('|');
  useEffect(() => {
    for (const src of key.split('|')) readPicture(src);
  }, [key]);
  return PICTURES;
}

/** For tests: forget every picture read. */
export function resetPicturesForTests(): void {
  PICTURES.clear();
  PENDING.clear();
  version += 1;
}
