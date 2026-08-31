// The bubble is registry-driven since WO-1 — these pins would all FAIL on the
// old component, which hardcoded BAYLA's five lines, the "the muse" byline,
// the teal accent and one GLOBAL dismissal key. A second live bungalow would
// have spoken in her voice, and hushing her would have hushed everyone.

import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MuseBubble } from './MuseBubble';
import type { Bungalow, BungalowIdentity } from '../../lib/bungalows';

function resident(over: Partial<Bungalow & { identity: BungalowIdentity }> = {}) {
  return {
    id: 'frogtown',
    name: 'Frogtown',
    symbol: 'FROG',
    chain: 'base',
    status: 'SETTLED',
    tagline: 'ribbit.',
    accent: '#123456',
    thumb: '/art/x.jpg',
    live: true,
    identity: {
      heroTitle: 'FROG.',
      heroLine: 'ribbit.',
      heroCopy: 'ribbit ribbit.',
      museLine: 'One canon line.',
      museBy: 'The Frog Collective',
      museLines: ['The pond remembers.'],
      museVoice: 'the frog',
    },
    ...over,
  } as Bungalow & { identity: BungalowIdentity };
}

beforeEach(() => sessionStorage.clear());

describe('MuseBubble', () => {
  it("speaks the resident's own lines and byline, not BAYLA's", () => {
    render(<MuseBubble bungalow={resident()} />);
    expect(screen.getByText(/The pond remembers\./)).toBeTruthy();
    expect(screen.getByText(/the frog/)).toBeTruthy();
    expect(screen.queryByText(/The work is yours/)).toBeNull();
    expect(screen.queryByText(/— the muse$/)).toBeNull();
  });

  it('falls back to the identity museLine and museBy when no pool is set', () => {
    const r = resident();
    delete (r.identity as { museLines?: unknown }).museLines;
    delete (r.identity as { museVoice?: unknown }).museVoice;
    render(<MuseBubble bungalow={r} />);
    expect(screen.getByText(/One canon line\./)).toBeTruthy();
    expect(screen.getByText(/The Frog Collective/)).toBeTruthy();
  });

  it('scopes the dismissal to this bungalow alone', () => {
    const { unmount } = render(<MuseBubble bungalow={resident()} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(sessionStorage.getItem('tegridy-muse-dismissed:frogtown')).toBe('1');
    expect(screen.queryByText(/The pond remembers\./)).toBeNull();
    unmount();
    // A DIFFERENT resident still speaks — the old global key silenced all.
    render(
      <MuseBubble
        bungalow={resident({ id: 'toadville', identity: { ...resident().identity, museLines: ['New pond.'] } })}
      />,
    );
    expect(screen.getByText(/New pond\./)).toBeTruthy();
  });

  it('stays dismissed for a resident whose key is already set', () => {
    sessionStorage.setItem('tegridy-muse-dismissed:frogtown', '1');
    render(<MuseBubble bungalow={resident()} />);
    expect(screen.queryByText(/The pond remembers\./)).toBeNull();
  });
});
