import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ErrorBoundary as ErrorBoundaryClass } from './ui/ErrorBoundary';
import type { StaleBuildEnv } from '../lib/staleBuild';

// What a visitor sees where a lazily loaded part failed to load. The boundary is the real
// one AppLayout puts around every route; the failure reaches it the way it does in a
// build: Vite reports the error, then the lazy component throws that same error.

const A = '/assets/index-AAAAAAAA.js';
const B = '/assets/index-BBBBBBBB.js';

let failure: Error | null = null;
function LazyPart(): never {
  throw failure ?? new Error('the test set no failure');
}

/** Vite's report of a failed lazy load, as the build's preload helper dispatches it. */
function reportToVite(error: Error) {
  const event = new Event('vite:preloadError', { cancelable: true }) as VitePreloadErrorEvent;
  event.payload = error;
  window.dispatchEvent(event);
}

function tab(over: Partial<StaleBuildEnv> = {}) {
  const data = new Map<string, string>();
  return {
    runningEntry: () => A,
    servedEntry: async () => B as string | null,
    held: () => false,
    storage: () => ({ getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }),
    now: () => 1_000_000,
    reload: vi.fn(),
    ...over,
  };
}

// lib/staleBuild.ts keeps its state for the life of a page, so each test is a new page:
// the boundary and the module it reads are loaded fresh, together.
let ErrorBoundary: typeof ErrorBoundaryClass;
let installStaleBuildReload: typeof import('../lib/staleBuild').installStaleBuildReload;

const realLocation = window.location;
let pageReload: ReturnType<typeof vi.fn>;
let stop: () => void = () => undefined;

beforeEach(async () => {
  vi.resetModules();
  ({ ErrorBoundary } = await import('./ui/ErrorBoundary'));
  ({ installStaleBuildReload } = await import('../lib/staleBuild'));
  pageReload = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { ...realLocation, reload: pageReload } });
  // React logs every error a boundary catches; the tests below throw on purpose.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stop();
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation });
  vi.restoreAllMocks();
});

/** A lazy load fails in this tab, and the boundary around it renders. */
async function failLazyLoad(env: StaleBuildEnv) {
  stop = installStaleBuildReload(env);
  failure = new Error('Failed to fetch dynamically imported module: /assets/SolanaLpPage-old.js');
  reportToVite(failure);
  render(
    <ErrorBoundary>
      <LazyPart />
    </ErrorBoundary>,
  );
  // Let the read of the host's page answer.
  await act(async () => {
    await Promise.resolve();
  });
}

describe('a lazy load failed because the build changed', () => {
  it('reloading: the spinner stays, and "Something went wrong" is never shown', async () => {
    const env = tab();
    await failLazyLoad(env);
    expect(env.reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status', { name: 'Loading page' })).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('while the host is still being read: the spinner, not an error', async () => {
    const env = tab({ servedEntry: () => new Promise<string | null>(() => undefined) });
    await failLazyLoad(env);
    expect(screen.getByRole('status', { name: 'Loading page' })).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it('a transaction is in flight: no reload, and the notice with a Refresh button', async () => {
    const env = tab({ held: () => true });
    await failLazyLoad(env);
    expect(env.reload).not.toHaveBeenCalled();
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('The site was updated');
    expect(notice).toHaveTextContent('Refresh the page to load the new version.');
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    // The reload is the visitor's to start.
    expect(pageReload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(pageReload).toHaveBeenCalledTimes(1);
  });

  it('already reloaded once from this build: the notice, not a second reload', async () => {
    const env = tab({ storage: () => ({ getItem: () => JSON.stringify({ from: A, at: 0 }), setItem: () => undefined }) });
    await failLazyLoad(env);
    expect(env.reload).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('The site was updated');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('the notice has no em dash', async () => {
    await failLazyLoad(tab({ held: () => true }));
    expect(screen.getByRole('alert').textContent).not.toMatch(/—/);
  });
});

describe('not shown to be a new build', () => {
  it('the host names the same build: the boundary keeps its own words and claims no update', async () => {
    const env = tab({ servedEntry: async () => A });
    await failLazyLoad(env);
    expect(env.reload).not.toHaveBeenCalled();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByText('The site was updated')).not.toBeInTheDocument();
  });

  it('an error that is not a failed lazy load is untouched, even while a reload is under way', async () => {
    const env = tab();
    stop = installStaleBuildReload(env);
    reportToVite(new Error('some other chunk'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(env.reload).toHaveBeenCalledTimes(1);
    failure = new TypeError('Cannot read properties of undefined');
    render(
      <ErrorBoundary>
        <LazyPart />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('a boundary with its own small fallback keeps it', async () => {
    const env = tab({ held: () => true });
    stop = installStaleBuildReload(env);
    failure = new Error('chart chunk');
    reportToVite(failure);
    render(
      <ErrorBoundary fallback={<p>Chart unavailable</p>}>
        <LazyPart />
      </ErrorBoundary>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Chart unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
