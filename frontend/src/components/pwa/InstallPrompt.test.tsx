import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InstallPrompt } from './InstallPrompt';

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
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
  });

  it('does not claim the installed app works offline', async () => {
    mount();
    await offerInstall();
    // The installed app reads the chain live and shows nothing when it cannot.
    // "Use it offline" would be a promise of cached prices.
    expect(screen.getByText(/still needs a connection to read anything on-chain/i)).toBeInTheDocument();
    expect(screen.queryByText(/work offline|use offline|offline access/i)).toBeNull();
  });

  it('fires the browser prompt and then stands down, since the event is single-use', async () => {
    mount();
    const event = await offerInstall();
    await act(async () => {
      screen.getByRole('button', { name: 'Install' }).click();
    });
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('stays gone after a dismissal, across a remount', async () => {
    const first = mount();
    await offerInstall();
    await act(async () => {
      screen.getByRole('button', { name: 'Dismiss install prompt' }).click();
    });
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();

    first.unmount();
    mount();
    await offerInstall();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('withdraws the offer when the install completes by any route', async () => {
    mount();
    await offerInstall();
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();

    // The browser's own menu can install without ever touching our button.
    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('stays silent on the sub-app route, which ships its own banner', async () => {
    mount('/nakamigos');
    await offerInstall();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });
});
