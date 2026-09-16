import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InstallPrompt } from './InstallPrompt';
import { persistInstallDismissed } from '../../lib/pwa/install';

// The banner exists only when an install can actually happen. These tests pin
// the silent states as hard as the visible one, because a stuck banner offering
// an install that already happened — or one that no browser can perform — is the
// PWA version of a figure nobody read.

class FakeInstallEvent extends Event {
  prompt = vi.fn(async () => {});
  userChoice = Promise.resolve({ outcome: 'accepted' as const });
  constructor() {
    super('beforeinstallprompt', { cancelable: true });
  }
}

function mount(path = '/farm') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <InstallPrompt />
    </MemoryRouter>,
  );
}

async function offerInstall(): Promise<FakeInstallEvent> {
  const event = new FakeInstallEvent();
  await act(async () => {
    window.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  window.localStorage.clear();
  // The install offer now stands down while the FIRST-RUN consent banner is
  // still unanswered (5513f0ba: "stop the install offer from becoming a third
  // stacked first-run dialog"), and `getConsent()` reads 'pending' on a clean
  // store. Without answering it here every visible-state test renders null and
  // fails for the wrong reason — the suite would be asserting the first-run
  // suppression it already covers separately, not the banner it means to test.
  window.localStorage.setItem('tegridy_telemetry_consent', 'denied');
});

describe('InstallPrompt before any prompt event', () => {
  it('renders nothing — including on the platforms that never fire one', () => {
    // iOS Safari is exactly this case: no beforeinstallprompt, ever. Rendering
    // a button there would advertise an action the page cannot perform.
    const { container } = mount();
    expect(container).toBeEmptyDOMElement();
  });
});

describe('InstallPrompt once the browser offers an install', () => {
  it('appears with the install action', async () => {
    mount();
    await offerInstall();
    expect(screen.getByRole('button', { name: 'Add to home screen' })).toBeInTheDocument();
  });

  it('is a ROW, never a banner over the page', async () => {
    // WAVE SEVEN, element E, and this is the invariant the element exists for.
    // It was `position: fixed`, `z-[9500]`, `role="dialog"`, at bottom-20 —
    // opening itself over the very buttons a visitor was reaching for. Asserted
    // on the rendered DOM rather than on the class string, because a class
    // string can be renamed while the behaviour stays.
    const { container } = mount();
    await offerInstall();

    const action = screen.getByRole('button', { name: 'Add to home screen' });
    expect(action).toBeInTheDocument();

    // Nothing it renders may be a dialog or fixed to the viewport.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    for (const el of Array.from(container.querySelectorAll('*'))) {
      expect(
        getComputedStyle(el as Element).position,
        'the install offer is fixed to the viewport again',
      ).not.toBe('fixed');
    }
  });

  it('never claims the installed app works offline', async () => {
    // WAVE SEVEN, element E: the explanatory line went with the banner -- a row
    // in the footer has no room for a paragraph, and the row promises exactly
    // what it does. The HONESTY half of this test is what mattered and it
    // stays: the installed app reads the chain live, so nothing here may ever
    // suggest it works without a connection.
    mount();
    await offerInstall();
    expect(screen.queryByText(/work offline|use offline|offline access|works offline/i)).toBeNull();
  });

  it('fires the browser prompt and then stands down, since the event is single-use', async () => {
    mount();
    const event = await offerInstall();
    await act(async () => {
      screen.getByRole('button', { name: 'Add to home screen' }).click();
    });
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Add to home screen' })).toBeNull();
  });

  it('honours a dismissal recorded by the old banner', async () => {
    // The row has no dismiss control -- it does not nag, so there is nothing to
    // dismiss. But anyone who dismissed the FIXED banner before wave seven
    // retired it must not be re-offered, and readInstallDismissed still rules.
    persistInstallDismissed();
    mount();
    await offerInstall();
    expect(screen.queryByRole('button', { name: 'Add to home screen' })).toBeNull();
  });

  it('withdraws the offer when the install completes by any route', async () => {
    mount();
    await offerInstall();
    expect(screen.getByRole('button', { name: 'Add to home screen' })).toBeInTheDocument();

    // The browser's own menu can install without ever touching our button.
    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(screen.queryByRole('button', { name: 'Add to home screen' })).toBeNull();
  });

  it('stays silent on the sub-app route, which ships its own banner', async () => {
    mount('/nakamigos');
    await offerInstall();
    expect(screen.queryByRole('button', { name: 'Add to home screen' })).toBeNull();
  });
});
