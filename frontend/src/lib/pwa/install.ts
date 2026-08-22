// The install offer, as a decision rather than as a component.
//
// The rule: the banner appears only when the browser has actually handed us a
// prompt to fire. There is no "install" button that opens instructions, no
// button that does nothing on the platforms that do not support the event, and
// no banner for a window that is already running installed. A button labelled
// Install that cannot install is the same class of thing as a zero that was
// never read — it states a capability the code does not have.
//
// PLATFORM NOTE, so a future editor does not "fix" the gap. iOS Safari fires no
// `beforeinstallprompt` at all: installing there is Share → Add to Home Screen,
// a manual gesture no page can trigger. So iOS users see no banner, exactly as
// in src/nakamigos/components/InstallPrompt.jsx, which has shipped that way.
// Adding a fake button there would make the offer worse, not wider.

import { safeGetItem, safeSetItem } from '../storage';

/**
 * Distinct from the nakamigos key (`pwa_install_dismissed`) on purpose: the two
 * surfaces are installed separately and dismissing one is not a statement about
 * the other.
 */
export const INSTALL_DISMISSED_KEY = 'tegridy_install_dismissed';

export function readInstallDismissed(): boolean {
  return safeGetItem(INSTALL_DISMISSED_KEY) === 'true';
}

export function persistInstallDismissed(): void {
  safeSetItem(INSTALL_DISMISSED_KEY, 'true');
}

/**
 * True when this document is already the installed app.
 *
 * Both checks are needed: `display-mode: standalone` covers Chromium and
 * installed PWAs generally, and the legacy `navigator.standalone` covers an iOS
 * home-screen launch, where the media query is unreliable across versions.
 */
export function isRunningInstalled(win: Window | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  if (!win) return false;
  const legacy = (win.navigator as Navigator & { standalone?: boolean }).standalone;
  if (legacy === true) return true;
  try {
    return win.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

export interface InstallOfferInputs {
  /** A `beforeinstallprompt` event is held and has not been consumed. */
  promptAvailable: boolean;
  dismissed: boolean;
  installed: boolean;
  /**
   * The nakamigos sub-app renders its own install banner. Two banners stacked on
   * one screen is not a worse offer than one, it is a broken-looking page.
   */
  onSubAppRoute: boolean;
}

export function shouldOfferInstall(inputs: InstallOfferInputs): boolean {
  if (!inputs.promptAvailable) return false;
  if (inputs.dismissed) return false;
  if (inputs.installed) return false;
  if (inputs.onSubAppRoute) return false;
  return true;
}

/** The one route whose sub-app already offers its own install banner. */
export function isSubAppRoute(pathname: string): boolean {
  return pathname === '/nakamigos' || pathname.startsWith('/nakamigos/');
}
