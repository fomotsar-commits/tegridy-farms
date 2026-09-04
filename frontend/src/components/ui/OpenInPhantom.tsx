import { useEffect, useState } from 'react';
import { phantomBrowseUrl, shouldOfferPhantomBrowse } from '../../lib/phantomMobile';

/**
 * "Open in Phantom" — shown only on a mobile browser that is not already
 * Phantom's own.
 *
 * Phantom is deliberately absent from the RainbowKit modal on phones: its EVM
 * provider is injected-only and Phantom ships no WalletConnect for EVM, so the
 * row would render and then do nothing when tapped. See lib/phantomMobile.ts
 * for the sourcing. This is the hop Phantom itself documents instead — reopen
 * the page inside Phantom's in-app browser, where the provider exists and the
 * wallet connects normally.
 *
 * Deliberately a real <a href>, not an onClick: Phantom's docs say browse
 * deeplinks "must either be handled by an app or clicked on by an end user",
 * and a genuine link keeps long-press/open-in-new-tab and keyboard behaviour.
 */
export function OpenInPhantom() {
  // Detection reads navigator, so decide after mount rather than during
  // render — SSR/hydration safety, and it keeps the component render-pure.
  const [offer, setOffer] = useState(false);
  const [href, setHref] = useState('');

  useEffect(() => {
    if (!shouldOfferPhantomBrowse()) return;
    setHref(phantomBrowseUrl(window.location.href, window.location.origin));
    setOffer(true);
  }, []);

  if (!offer) return null;

  return (
    <p className="text-white/70 text-[12px] mt-4 max-w-[420px] mx-auto leading-relaxed">
      Using Phantom?{' '}
      <a
        href={href}
        className="underline font-semibold text-white hover:text-white/80 inline-block px-1 -mx-1 py-2 -my-2"
      >
        Open this page in Phantom
      </a>
      {' '}— on phones Phantom only connects inside its own browser, so it
      won&apos;t appear in the list above.
    </p>
  );
}

export default OpenInPhantom;
