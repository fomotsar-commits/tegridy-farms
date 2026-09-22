/**
 * The venue's own hero. The H1 is title, <br />, line, and a <br> is not text, so the H1
 * test reads textContent: it sees the join exactly, as a screen reader or an unfurl does.
 * The launch floor is read (heatLaunchFloor) and the tier word beside it derived, never
 * typed: at 123 no tier is named, at 365 the sentence says Builder.
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
    // tierFor(123) is Observer, because a floor BETWEEN rungs still sits above
    // one. That is exactly the word that must not appear beside 123.
    expect(container.textContent).not.toMatch(/you reach/);
  });

  it('names the tier the floor sits exactly on, derived and never typed', () => {
    vi.stubEnv('VITE_HEAT_LAUNCH_FLOOR', '365');
    const { container } = mount();
    expect(
      screen.getByText('At 365 degrees you reach Builder, the tier that may plant a launch here.'),
    ).toBeTruthy();
    expect(container.textContent).not.toContain('reach Resident');
  });

  it('reads today’s sentence at the default floor', () => {
    mount();
    expect(
      screen.getByText('At 180 degrees you reach Resident, the tier that may plant a launch here.'),
    ).toBeTruthy();
  });
});

describe('the explainer is the island sentence', () => {
  it('explains heat in the island words, with no formula', () => {
    const { container } = mount();
    expect(
      screen.getByText(
        'Heat counts the days you have held each token. It is read per token and added together across everything you hold. Size can raise what a day is worth, it cannot buy a day, and price never enters it.',
      ),
    ).toBeTruthy();
    expect(container.textContent).not.toMatch(/as a share of its supply|a fresh bag starts cold/);
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
