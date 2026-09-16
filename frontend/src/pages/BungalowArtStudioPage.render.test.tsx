import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BUNGALOWS } from '../lib/bungalows';
import BungalowArtStudioPage from './BungalowArtStudioPage';

// A RESIDENT WITH NO DROP OF ITS OWN STILL HAS A STUDIO.
//
// `bungalowArtWith` picked its fallback art with
// `pool[((hash % pool.length) + idx) % pool.length]!`. For a bungalow with no
// `artPool` that pool is `[]`, so `hash % 0` is NaN, `pool[NaN]` is undefined,
// and the non-null assertion handed undefined to the caller — which read
// `.objectPosition` off it and threw before first paint. Every studio for a
// pool-less resident died on mount: toweli, qr and nb1, three of the thirteen.
//
// It survived because nothing rendered this page in a test and because the two
// residents anyone opens by hand (bayla, pepe) both have pools. The `!` is what
// made it invisible to the compiler — an index lookup cannot be asserted
// non-null, and this file exists to keep that assertion from coming back.
//
// The assertion is deliberately "it mounts and shows its surface list", not a
// snapshot: the bug was a crash, and any pick-quality assertion would still
// have passed on the broken build for bayla while missing the three that died.

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

// The live-preview pane iframes a real route; irrelevant to mounting.
vi.mock('../components/studio/LivePreview', () => ({ LivePreview: () => <div>live preview</div> }));

const withPool = BUNGALOWS.filter((b) => (b.artPool?.length ?? 0) > 0).map((b) => b.id);
const withoutPool = BUNGALOWS.filter((b) => (b.artPool?.length ?? 0) === 0).map((b) => b.id);

function mount(bungalowId: string) {
  return render(
    <MemoryRouter>
      <BungalowArtStudioPage bungalowId={bungalowId} />
    </MemoryRouter>,
  );
}

describe('every resident has a studio that mounts', () => {
  it('the registry still contains both kinds, so the cases below are not vacuous', () => {
    expect(withPool.length, 'no bungalow has an artPool — the with-pool case is vacuous').toBeGreaterThan(0);
    expect(
      withoutPool.length,
      'no bungalow lacks an artPool — the regression this file pins can no longer be reproduced, ' +
        'so either the registry changed or this test needs a fixture',
    ).toBeGreaterThan(0);
  });

  it.each(BUNGALOWS.map((b) => b.id))('/bungalow-studio/%s mounts without throwing', (id) => {
    expect(() => mount(id)).not.toThrow();
  });

  // The point of the fix is NOT that a pool-less studio becomes editable — the
  // component already decided it should not be, in a `pool.length === 0` guard.
  // The point is that render now REACHES that guard instead of throwing three
  // hooks earlier, so the reader gets the explanation the author wrote for them.
  it.each(withoutPool)('%s explains that it has no pool instead of crashing', (id) => {
    mount(id);
    expect(screen.getByText(/has no art pool of its own/i)).toBeTruthy();
  });

  it('an id that matches no bungalow says so, rather than blaming a missing pool', () => {
    mount('definitely-not-a-resident');
    expect(screen.getByText(/No bungalow matches id/i)).toBeTruthy();
  });

  it.each(withPool)('%s offers its own pool', (id) => {
    mount(id);
    const bungalow = BUNGALOWS.find((b) => b.id === id)!;
    expect(screen.getByText(new RegExp(`${bungalow.name} art \\(${bungalow.artPool!.length} pieces\\)`, 'i'))).toBeTruthy();
  });
});
