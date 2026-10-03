// The page's Solana connection as the top bar sees it (lib/solanaSurface.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelSolanaOpenRequest,
  getSolanaSurfaceState,
  requestSolanaOpen,
  setSolanaSurface,
  shortSolanaAddress,
  subscribeSolanaSurface,
  takeSolanaOpenRequest,
  type SolanaSurface,
} from './solanaSurface';

const surface = (over: Partial<SolanaSurface> = {}): SolanaSurface => ({
  open: vi.fn(),
  address: null,
  connecting: false,
  ...over,
});

const owners: object[] = [];
const owner = () => {
  const o = {};
  owners.push(o);
  return o;
};

afterEach(() => {
  for (const o of owners.splice(0)) setSolanaSurface(o, null);
  cancelSolanaOpenRequest();
});

describe('solanaSurface: who answers', () => {
  it('is empty with no Solana section on the page', () => {
    expect(getSolanaSurfaceState()).toEqual({ surface: null, openPending: false });
  });

  it('answers with the provider mounted last, and falls back as each one leaves', () => {
    const a = owner();
    const b = owner();
    const sa = surface();
    const sb = surface();
    setSolanaSurface(a, sa);
    setSolanaSurface(b, sb);
    expect(getSolanaSurfaceState().surface).toBe(sb);
    // A re-report keeps its mount order: A stays first.
    const sa2 = surface({ address: 'A' });
    setSolanaSurface(a, sa2);
    expect(getSolanaSurfaceState().surface).toBe(sb);
    setSolanaSurface(b, null);
    expect(getSolanaSurfaceState().surface).toBe(sa2);
    setSolanaSurface(a, null);
    expect(getSolanaSurfaceState().surface).toBeNull();
  });

  it('tells subscribers about every change, and only until they unsubscribe', () => {
    const listener = vi.fn();
    const off = subscribeSolanaSurface(listener);
    const a = owner();
    setSolanaSurface(a, surface());
    setSolanaSurface(a, surface({ address: 'X' }));
    setSolanaSurface(a, null);
    expect(listener).toHaveBeenCalledTimes(3);
    off();
    setSolanaSurface(a, surface());
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('withdrawing a provider that never reported changes nothing and tells no one', () => {
    const listener = vi.fn();
    const off = subscribeSolanaSurface(listener);
    const before = getSolanaSurfaceState();
    setSolanaSurface(owner(), null);
    expect(listener).not.toHaveBeenCalled();
    expect(getSolanaSurfaceState()).toBe(before);
    off();
  });

  it('hands out the same snapshot object until something changes (useSyncExternalStore)', () => {
    setSolanaSurface(owner(), surface());
    expect(getSolanaSurfaceState()).toBe(getSolanaSurfaceState());
  });
});

describe('solanaSurface: a top-bar tap', () => {
  it('opens the page list at once when the page has one, and remembers nothing', () => {
    const s = surface();
    setSolanaSurface(owner(), s);
    requestSolanaOpen();
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(getSolanaSurfaceState().openPending).toBe(false);
    expect(takeSolanaOpenRequest()).toBe(false);
  });

  it('is remembered while the page has no Solana section yet, and used exactly once', () => {
    requestSolanaOpen();
    requestSolanaOpen();
    expect(getSolanaSurfaceState().openPending).toBe(true);
    expect(takeSolanaOpenRequest()).toBe(true);
    expect(getSolanaSurfaceState().openPending).toBe(false);
    expect(takeSolanaOpenRequest()).toBe(false);
  });

  it('is dropped by a cancel (the visitor left the page)', () => {
    requestSolanaOpen();
    cancelSolanaOpenRequest();
    expect(getSolanaSurfaceState().openPending).toBe(false);
    expect(takeSolanaOpenRequest()).toBe(false);
  });
});

describe('solanaSurface', () => {
  it('shortens a Solana address the house way', () => {
    expect(shortSolanaAddress('Bq6jovnQfVTFjmxL4dPt9xNNNnDBgvdhaXy3D4YqXTXV')).toBe('Bq6j…XTXV');
  });

  // TopNav is in the entry chunk; check-dist-graph.mjs B fails the BUILD if any
  // of these pulls the Solana stack in. This says so in the unit run, sooner.
  it.each(['lib/solanaSurface.ts', 'lib/routeVoice.ts', 'components/layout/TopNav.tsx'])(
    '%s, which the top bar loads up front, imports no Solana code',
    (file) => {
      const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
      const imports = source.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]|^\s*import\s+['"][^'"]+['"]|import\(\s*['"][^'"]+['"]\s*\)/gm) ?? [];
      expect(imports.length).toBeGreaterThan(0);
      for (const statement of imports) {
        expect(statement, `${file}: ${statement}`).not.toMatch(/@solana\/|solanaPolyfill|solanaWallet|components\/solana\/|\.\.\/solana\//);
      }
    },
  );
});
