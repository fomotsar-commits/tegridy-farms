/**
 * Phantom on a mobile browser — the one path Phantom actually supports.
 *
 * Phantom's EVM provider is injected-only, and Phantom ships NO WalletConnect
 * support for EVM: their deeplink docs say "Currently only Solana is supported
 * for deeplinks", and their own support article says "On mobile, connecting
 * only works inside Phantom's in-app browser. You can't connect from Safari,
 * Chrome, or other mobile browsers." Reown (the WalletConnect company) says the
 * same from the other side — Phantom does not speak the WC protocol, and its
 * link mechanism is Solana-only.
 *
 * That is why Phantom cannot appear as a working row in the RainbowKit modal on
 * mobile Safari. RainbowKit filters the mobile list to `wallet.ready`
 * (installed ?? true), and our Phantom correctly reports installed:false there
 * — forcing the row to show would produce a tap that does NOTHING (the mobile
 * handler bails on a missing WC uri, then swallows the connect error in a bare
 * catch). A row that silently does nothing is worse than no row.
 *
 * So instead we offer the hop Phantom documents: open THIS page inside
 * Phantom's in-app browser, where window.phantom.ethereum exists. Once there,
 * `installed` flips true, the modal lists Phantom by itself, and connecting
 * works normally. This is the same universal link @solana/wallet-adapter-phantom
 * uses on our Solana surface, so the shape is copied, not invented.
 */

/** Phantom's documented in-app-browser universal link. Both params required. */
export function phantomBrowseUrl(href: string, origin: string): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}`;
}

/** Same UA test RainbowKit uses to decide it should render its mobile modal. */
export function isMobileBrowser(ua: string, platform: string, maxTouchPoints: number): boolean {
  const android = /android/i.test(ua);
  const smallIOS = /iPhone|iPod/.test(ua);
  // Modern iPadOS Safari reports a Macintosh UA; touch points are what give it
  // away, and it is the reason an iPad hits the mobile modal at all.
  const largeIOS = /iPad/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
  return android || smallIOS || largeIOS;
}

/**
 * Should we offer the "open in Phantom" hop? Only on a mobile browser that is
 * NOT already inside Phantom (where the provider exists and the normal modal
 * row works). Never on desktop, where the extension is the supported path.
 */
export function shouldOfferPhantomBrowse(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const w = window as unknown as { phantom?: { ethereum?: unknown } };
  if (w.phantom?.ethereum) return false;
  return isMobileBrowser(navigator.userAgent, navigator.platform, navigator.maxTouchPoints ?? 0);
}
