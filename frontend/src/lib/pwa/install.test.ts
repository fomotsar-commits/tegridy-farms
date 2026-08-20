import { describe, it, expect, beforeEach } from 'vitest';
import {
  INSTALL_DISMISSED_KEY,
  isRunningInstalled,
  isSubAppRoute,
  persistInstallDismissed,
  readInstallDismissed,
  shouldOfferInstall,
} from './install';

const OFFERABLE = {
  promptAvailable: true,
  dismissed: false,
  installed: false,
  onSubAppRoute: false,
};

describe('shouldOfferInstall', () => {
  it('offers when the browser has actually given us a prompt to fire', () => {
    expect(shouldOfferInstall(OFFERABLE)).toBe(true);
  });

  it('never offers without a real prompt event', () => {
    // The whole rule. A button labelled Install that cannot install is a
    // capability claim the code cannot honour — the same class of thing as a
    // figure that was never read.
    expect(shouldOfferInstall({ ...OFFERABLE, promptAvailable: false })).toBe(false);
  });

  it('does not offer again after a dismissal', () => {
    expect(shouldOfferInstall({ ...OFFERABLE, dismissed: true })).toBe(false);
  });

  it('does not offer inside the installed app', () => {
    expect(shouldOfferInstall({ ...OFFERABLE, installed: true })).toBe(false);
  });

  it('stands down on the sub-app route, which has a banner of its own', () => {
    expect(shouldOfferInstall({ ...OFFERABLE, onSubAppRoute: true })).toBe(false);
  });
});

describe('isSubAppRoute', () => {
  it('matches the sub-app and its children', () => {
    expect(isSubAppRoute('/nakamigos')).toBe(true);
    expect(isSubAppRoute('/nakamigos/gallery')).toBe(true);
  });

  it('does not match a route that merely starts with the same letters', () => {
    expect(isSubAppRoute('/nakamigos-something')).toBe(false);
    expect(isSubAppRoute('/farm')).toBe(false);
  });
});

describe('dismissal persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips through storage under its own key, not the sub-app\'s', () => {
    expect(readInstallDismissed()).toBe(false);
    persistInstallDismissed();
    expect(readInstallDismissed()).toBe(true);
    expect(INSTALL_DISMISSED_KEY).not.toBe('pwa_install_dismissed');
    expect(window.localStorage.getItem('pwa_install_dismissed')).toBeNull();
  });
});

describe('isRunningInstalled', () => {
  function fakeWindow(over: { standalone?: boolean; matches?: boolean; throws?: boolean }): Window {
    return {
      navigator: { standalone: over.standalone },
      matchMedia: () => {
        if (over.throws) throw new Error('matchMedia unavailable');
        return { matches: over.matches ?? false } as MediaQueryList;
      },
    } as unknown as Window;
  }

  it('reads a Chromium standalone launch from the display-mode query', () => {
    expect(isRunningInstalled(fakeWindow({ matches: true }))).toBe(true);
  });

  it('reads an iOS home-screen launch from the legacy navigator flag', () => {
    // iOS reports display-mode inconsistently across versions, so the legacy
    // flag is not redundant — dropping it re-offers the install inside the
    // installed app.
    expect(isRunningInstalled(fakeWindow({ standalone: true, matches: false }))).toBe(true);
  });

  it('is false in a normal browser tab', () => {
    expect(isRunningInstalled(fakeWindow({ matches: false }))).toBe(false);
  });

  it('does not throw where matchMedia is unavailable', () => {
    expect(isRunningInstalled(fakeWindow({ throws: true }))).toBe(false);
  });

  it('is false with no window at all (SSR / node)', () => {
    expect(isRunningInstalled(undefined)).toBe(false);
  });
});
