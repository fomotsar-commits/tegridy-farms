/**
 * WAVE SEVEN, answer ten, rulings 3 and 4, on the venue's own hero.
 *
 * NOTHING RENDERED THIS HERO IN A TEST BEFORE, which is how a period after
 * FINANCE stood on the largest words of the venue for sixteen days. The e2e
 * checks used toContainText('MEMETICS.FINANCE'), a substring that passes with
 * the period and without it, so they could never have seen it.
 *
 * RULING 3. The H1 is title, <br />, line. A <br> is not text, so with the
 * period gone the H1's text reads "MEMETICS.FINANCEHeld time counts here." to
 * anything that reads text rather than pixels: a screen reader, a search engine,
 * a link unfurl. So the test reads textContent, which sees the join exactly, and
 * not an accessible-name helper, some of which pad a <br> with spaces and would
 * pass the defect.
 *
 * RULING 4. The launch floor is read (heatLaunchFloor) and the tier word beside
 * it must be derived from it, never typed: at 123 no tier is named, at 150 the
 * sentence says Builder. The island's own mutation for this is "retype Resident
 * and the 150 fixture goes red".
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Suspense } from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The instrument is element B's and has its own suite; here it would only drag
// in wagmi and a network read that this test is not about. It records what the
// hero hands it, which is the half of the first-frame handoff that lives here.
const card = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock('./HeatCard', () => ({
  HeatCard: (props: Record<string, unknown>) => {
    card.props = props;
    return null;
  },
}));

const { VenueHero } = await import('./VenueHero');
const { setFirstFrameDraft, setFirstFrameFocus, peekFirstFrameDraft, clearFirstFrameDraft } = await import(
  '../lib/firstFrameDraft'
);

function mount(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <VenueHero />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearFirstFrameDraft();
  card.props = null;
});

describe('the title (ruling 3)', () => {
  it('reads MEMETICS.FINANCE with no period, and a real space before the line', () => {
    mount();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('MEMETICS.FINANCE Held time counts here.');
  });

  it('keeps the sentence its own period: only the domain lost one', () => {
    mount();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent?.endsWith('Held time counts here.')).toBe(true);
    expect(h1.textContent).not.toContain('FINANCE.');
  });
});

describe('the launch floor sentence (ruling 4)', () => {
  it('names no tier when the floor sits between rungs', () => {
    vi.stubEnv('VITE_HEAT_LAUNCH_FLOOR', '123');
    const { container } = mount();
    expect(screen.getByText('The launch door opens at 123 degrees.')).toBeTruthy();
    // tierFor(123) is Resident, because a floor BETWEEN rungs still sits above
    // one. That is exactly the word that must not appear beside 123.
    expect(container.textContent).not.toMatch(/you reach/);
  });

  it('names the tier the floor sits exactly on, derived and never typed', () => {
    vi.stubEnv('VITE_HEAT_LAUNCH_FLOOR', '150');
    const { container } = mount();
    expect(
      screen.getByText('At 150 degrees you reach Builder, the tier that may plant a launch here.'),
    ).toBeTruthy();
    expect(container.textContent).not.toContain('reach Resident');
  });

  it('reads today’s sentence at the default floor', () => {
    mount();
    expect(
      screen.getByText('At 80 degrees you reach Resident, the tier that may plant a launch here.'),
    ).toBeTruthy();
  });
});

// ANSWER TEN, RULING 2: WHAT WAS TYPED BEFORE THE HERO EXISTED.
//
// The first version took the draft inside a useState initializer and was covered only
// by a test of the store itself. In a production build it never worked once: the home
// page's first render suspends, React throws that render away, and the retry found
// the draft already taken. The first test below is that failure, reproduced.
describe('the address typed before the hero arrived (ruling 2)', () => {
  it('reaches the field even when the first render is thrown away by a suspension', async () => {
    setFirstFrameDraft('0xd71caf9f');
    setFirstFrameFocus(true);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let ready = false;
    function SuspendsOnce() {
      if (!ready) throw pending.then(() => { ready = true; });
      return null;
    }
    render(
      <MemoryRouter>
        <Suspense fallback={<p>fallback</p>}>
          <VenueHero />
          <SuspendsOnce />
        </Suspense>
      </MemoryRouter>,
    );
    await act(async () => { release(); await pending; });
    await screen.findByRole('heading', { level: 1 });

    expect(card.props?.initialDraft, 'the typed address did not survive the discarded render').toBe('0xd71caf9f');
    expect(card.props?.focusField).toBe(true);
    // Put in the field, never read: nobody submitted it.
    expect(card.props?.initialAddress).toBeNull();
    // And gone once the hero has it, so no later visit brings it back.
    expect(peekFirstFrameDraft().value).toBeNull();
  });

  it('reads a shared ?heat= link on arrival, which a draft is not', () => {
    mount('/?heat=0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a');
    expect(card.props?.initialAddress).toBe('0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a');
    expect(card.props?.initialDraft).toBeNull();
    expect(card.props?.focusField).toBe(false);
  });
});
