// VENDORED from @rainbow-me/rainbowkit@2.2.11 — the wallet definitions this
// venue adds to the connect modal (phantomWallet, trustWallet) plus the small
// helpers they use (src/wallets/getInjectedConnector.ts and src/utils/
// isMobile.ts), copied verbatim and TypeScript-typed; both icons are the
// package's own data-URI svg modules.
//
// WHY VENDORED, not imported: the only public path to a per-wallet definition
// is the '@rainbow-me/rainbowkit/wallets' barrel (the exports map exposes no
// deeper subpath), and that barrel re-exports every wallet — including
// portoWallet and geminiWallet, whose chunks `import { porto } / { gemini }
// from "wagmi/connectors"`. Those named exports do not exist in the installed
// wagmi 3.7.6, so rolldown fails the PRODUCTION build with MISSING_EXPORT the
// moment anything imports the barrel — while dev, tsc and vitest all stay
// green (the same green-in-dev/dead-in-build family as WALLET-03 and the
// vendored wallet-adapter css).
//
// Nothing here reaches into RainbowKit internals: the injected helper touches
// only public wagmi API (createConnector, injected), and Trust's WalletConnect
// path uses getWalletConnectConnector, which the package exports from its MAIN
// entry — the entry wagmi.ts already imports, and which itself pulls only
// wagmi's public `walletConnect`/`mock` connectors.
//
// On a RainbowKit upgrade: if the barrel becomes importable against the
// installed wagmi (or per-wallet subpath exports appear), delete this file and
// import the wallets from '@rainbow-me/rainbowkit/wallets' instead.
import { createConnector } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { getWalletConnectConnector } from '@rainbow-me/rainbowkit';
import type {
  RainbowKitWalletConnectParameters,
  Wallet,
  WalletDetailsParams,
} from '@rainbow-me/rainbowkit';

type InjectedProviderFlags = { flag?: string; namespace?: string };

function getExplicitInjectedProvider(flag: string) {
  const _window = typeof window !== 'undefined' ? (window as Record<string, any>) : undefined;
  if (typeof _window === 'undefined' || typeof _window.ethereum === 'undefined') return;
  const providers = _window.ethereum.providers;
  return providers
    ? providers.find((provider: Record<string, unknown>) => provider[flag])
    : _window.ethereum[flag]
      ? _window.ethereum
      : undefined;
}

function getWindowProviderNamespace(namespace: string) {
  const providerSearch = (provider: Record<string, any>, ns: string): unknown => {
    const [property, ...path] = ns.split('.');
    const _provider = provider[property!];
    if (_provider) {
      if (path.length === 0) return _provider;
      return providerSearch(_provider, path.join('.'));
    }
  };
  if (typeof window !== 'undefined') return providerSearch(window as unknown as Record<string, any>, namespace);
}

function hasInjectedProvider({ flag, namespace }: InjectedProviderFlags): boolean {
  if (namespace && typeof getWindowProviderNamespace(namespace) !== 'undefined') return true;
  if (flag && typeof getExplicitInjectedProvider(flag) !== 'undefined') return true;
  return false;
}

function getInjectedProvider({ flag, namespace }: InjectedProviderFlags) {
  const _window = typeof window !== 'undefined' ? (window as Record<string, any>) : undefined;
  if (typeof _window === 'undefined') return;
  if (namespace) {
    const windowProvider = getWindowProviderNamespace(namespace);
    if (windowProvider) return windowProvider;
  }
  const providers = _window.ethereum?.providers;
  if (flag) {
    const provider = getExplicitInjectedProvider(flag);
    if (provider) return provider;
  }
  if (namespace || flag) return;
  if (typeof providers !== 'undefined' && providers.length > 0) return providers[0];
  return _window.ethereum;
}

function createInjectedConnector(provider?: unknown): Wallet['createConnector'] {
  return (walletDetails: WalletDetailsParams) => {
    const injectedConfig = provider
      ? {
          target: () => ({
            id: walletDetails.rkDetails.id,
            name: walletDetails.rkDetails.name,
            provider: provider as never,
          }),
        }
      : {};
    return createConnector((config) => ({
      ...injected(injectedConfig)(config),
      ...walletDetails,
    }));
  };
}

function getInjectedConnector({ flag, namespace }: InjectedProviderFlags): Wallet['createConnector'] {
  return createInjectedConnector(getInjectedProvider({ flag, namespace }));
}

// src/utils/isMobile.ts, verbatim. Trust reads this twice — once to pick the
// injected flag (the in-app browser injects `isTrust`, the desktop extension
// `isTrustWallet`), once to choose the deep link over the QR code.
function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
}
function isSmallIOS(): boolean {
  return typeof navigator !== 'undefined' && /iPhone|iPod/.test(navigator.userAgent);
}
function isLargeIOS(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (/iPad/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
  );
}
function isIOS(): boolean {
  return isSmallIOS() || isLargeIOS();
}
function isMobile(): boolean {
  return isAndroid() || isIOS();
}

// The package's own icon module (dist/phantomWallet-*.js), byte-identical.
const PHANTOM_ICON =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2228%22%20height%3D%2228%22%20fill%3D%22none%22%3E%3Cg%20clip-path%3D%22url(%23a)%22%3E%3Cpath%20fill%3D%22%23AB9FF2%22%20d%3D%22M28%200H0v28h28V0Z%22%2F%3E%3Cpath%20fill%3D%22%23FFFDF8%22%20fill-rule%3D%22evenodd%22%20d%3D%22M12.063%2018.128c-1.173%201.796-3.137%204.07-5.75%204.07-1.236%200-2.424-.51-2.424-2.719%200-5.627%207.682-14.337%2014.81-14.337%204.056%200%205.671%202.813%205.671%206.008%200%204.101-2.66%208.79-5.306%208.79-.84%200-1.252-.46-1.252-1.192%200-.19.032-.397.095-.62-.902%201.542-2.645%202.973-4.276%202.973-1.188%200-1.79-.747-1.79-1.797%200-.381.079-.778.222-1.176Zm9.63-7.089c0%20.931-.549%201.397-1.163%201.397-.624%200-1.164-.466-1.164-1.397%200-.93.54-1.396%201.164-1.396.614%200%201.164.465%201.164%201.396Zm-3.49%200c0%20.931-.55%201.397-1.164%201.397-.624%200-1.164-.466-1.164-1.397%200-.93.54-1.396%201.164-1.396.614%200%201.164.465%201.164%201.396Z%22%20clip-rule%3D%22evenodd%22%2F%3E%3C%2Fg%3E%3Cdefs%3E%3CclipPath%20id%3D%22a%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%200h28v28H0z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3C%2Fsvg%3E';

export const phantomWallet = (): Wallet => ({
  id: 'phantom',
  name: 'Phantom',
  rdns: 'app.phantom',
  iconUrl: async () => PHANTOM_ICON,
  iconBackground: '#9A8AEE',
  installed: hasInjectedProvider({ namespace: 'phantom.ethereum' }),
  downloadUrls: {
    android: 'https://play.google.com/store/apps/details?id=app.phantom',
    ios: 'https://apps.apple.com/app/phantom-solana-wallet/1598432977',
    mobile: 'https://phantom.app/download',
    qrCode: 'https://phantom.app/download',
    chrome: 'https://chrome.google.com/webstore/detail/phantom/bfnaelmomeimhlpmgjnjophhpkkoljpa',
    firefox: 'https://addons.mozilla.org/firefox/addon/phantom-app/',
    browserExtension: 'https://phantom.app/download',
  },
  extension: {
    instructions: {
      steps: [
        {
          description: 'wallet_connectors.phantom.extension.step1.description',
          step: 'install',
          title: 'wallet_connectors.phantom.extension.step1.title',
        },
        {
          description: 'wallet_connectors.phantom.extension.step2.description',
          step: 'create',
          title: 'wallet_connectors.phantom.extension.step2.title',
        },
        {
          description: 'wallet_connectors.phantom.extension.step3.description',
          step: 'refresh',
          title: 'wallet_connectors.phantom.extension.step3.title',
        },
      ],
      learnMoreUrl: 'https://help.phantom.app',
    },
  },
  createConnector: getInjectedConnector({ namespace: 'phantom.ethereum' }),
});

// The package's own icon module (dist/trustWallet-*.js), byte-identical.
const TRUST_ICON =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20width%3D%2228%22%20height%3D%2228%22%20viewBox%3D%220%200%2028%2028%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%200h28v28H0z%22%2F%3E%3Cpath%20fill%3D%22%230500FF%22%20d%3D%22M6%207.583%2013.53%205v17.882C8.15%2020.498%206%2015.928%206%2013.345V7.583Z%22%2F%3E%3Cpath%20fill%3D%22url(%23a)%22%20d%3D%22M22%207.583%2013.53%205v17.882c6.05-2.384%208.47-6.954%208.47-9.537V7.583Z%22%2F%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22a%22%20x1%3D%2219.768%22%20x2%3D%2214.072%22%20y1%3D%223.753%22%20y2%3D%2222.853%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20offset%3D%22.02%22%20stop-color%3D%22%2300F%22%2F%3E%3Cstop%20offset%3D%22.08%22%20stop-color%3D%22%230094FF%22%2F%3E%3Cstop%20offset%3D%22.16%22%20stop-color%3D%22%2348FF91%22%2F%3E%3Cstop%20offset%3D%22.42%22%20stop-color%3D%22%230094FF%22%2F%3E%3Cstop%20offset%3D%22.68%22%20stop-color%3D%22%230038FF%22%2F%3E%3Cstop%20offset%3D%22.9%22%20stop-color%3D%22%230500FF%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3C%2Fsvg%3E%0A';

/**
 * Trust Wallet — vendored verbatim from the same 2.2.11 dist.
 *
 * Unlike Phantom this is NOT injected-only: with no Trust provider in the page
 * it connects over WalletConnect (desktop gets the QR, mobile gets the
 * `trust://wc?uri=` deep link into the app). That path needs a projectId,
 * which is exactly why this wallet is only wired into wagmi.ts's
 * getDefaultConfig branch and never the no-projectId fallback.
 *
 * WALLET-03 note: the WalletConnect path's optional peer is
 * `@walletconnect/ethereum-provider`, which walletConnectorDeps.test.ts
 * already declares and guards — Trust adds no new optional peer, so it cannot
 * introduce a new throwing-stub wallet.
 *
 * `installed` deliberately resolves to true-or-undefined and never false:
 * upstream's comment is that the Trust provider falls back to other connection
 * methods when the injected one is absent, so claiming "not installed" would
 * be wrong.
 */
export const trustWallet = ({
  projectId,
  walletConnectParameters,
}: {
  projectId: string;
  walletConnectParameters?: RainbowKitWalletConnectParameters;
}): Wallet => {
  // The in-app browser injects `isTrust`; the desktop extension `isTrustWallet`.
  const isTrustWalletInjected = isMobile()
    ? hasInjectedProvider({ flag: 'isTrust' })
    : hasInjectedProvider({ flag: 'isTrustWallet' });
  const shouldUseWalletConnect = !isTrustWalletInjected;

  return {
    id: 'trust',
    name: 'Trust Wallet',
    rdns: 'com.trustwallet.app',
    iconUrl: async () => TRUST_ICON,
    installed: isTrustWalletInjected || undefined,
    iconAccent: '#3375BB',
    iconBackground: '#fff',
    downloadUrls: {
      android: 'https://play.google.com/store/apps/details?id=com.wallet.crypto.trustapp',
      ios: 'https://apps.apple.com/us/app/trust-crypto-bitcoin-wallet/id1288339409',
      mobile: 'https://trustwallet.com/download',
      qrCode: 'https://trustwallet.com/download',
      chrome: 'https://chrome.google.com/webstore/detail/trust-wallet/egjidjbpglichdcondbcbdnbeeppgdph',
      browserExtension: 'https://trustwallet.com/browser-extension',
    },
    mobile: {
      getUri: shouldUseWalletConnect
        ? (uri: string) => `trust://wc?uri=${encodeURIComponent(uri)}`
        : undefined,
    },
    qrCode: shouldUseWalletConnect
      ? {
          getUri: (uri: string) => uri,
          instructions: {
            learnMoreUrl: 'https://trustwallet.com/',
            steps: [
              {
                description: 'wallet_connectors.trust.qr_code.step1.description',
                step: 'install',
                title: 'wallet_connectors.trust.qr_code.step1.title',
              },
              {
                description: 'wallet_connectors.trust.qr_code.step2.description',
                step: 'create',
                title: 'wallet_connectors.trust.qr_code.step2.title',
              },
              {
                description: 'wallet_connectors.trust.qr_code.step3.description',
                step: 'scan',
                title: 'wallet_connectors.trust.qr_code.step3.title',
              },
            ],
          },
        }
      : undefined,
    extension: {
      instructions: {
        learnMoreUrl: 'https://trustwallet.com/browser-extension',
        steps: [
          {
            description: 'wallet_connectors.trust.extension.step1.description',
            step: 'install',
            title: 'wallet_connectors.trust.extension.step1.title',
          },
          {
            description: 'wallet_connectors.trust.extension.step2.description',
            step: 'create',
            title: 'wallet_connectors.trust.extension.step2.title',
          },
          {
            description: 'wallet_connectors.trust.extension.step3.description',
            step: 'refresh',
            title: 'wallet_connectors.trust.extension.step3.title',
          },
        ],
      },
    },
    createConnector: shouldUseWalletConnect
      ? getWalletConnectConnector({ projectId, walletConnectParameters })
      : getInjectedConnector({ flag: isMobile() ? 'isTrust' : 'isTrustWallet' }),
  };
};

// The package's own icon module (dist/rabbyWallet-GFVPHCTK.js), byte-identical.
const RABBY_ICON = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2028%2028%22%3E%3Cg%20clip-path%3D%22url(%23a)%22%3E%3Cpath%20fill%3D%22%238697FF%22%20d%3D%22M28%200H0v28h28V0Z%22%2F%3E%3Cpath%20fill%3D%22url(%23b)%22%20d%3D%22M22.54%2015.078c.677-1.514-2.673-5.744-5.874-7.506-2.017-1.365-4.12-1.178-4.545-.579-.935%201.316%203.094%202.43%205.788%203.731-.58.252-1.125.703-1.446%201.28-1.004-1.096-3.209-2.04-5.796-1.28-1.743.513-3.191%201.721-3.751%203.546a1.097%201.097%200%201%200-.445%202.1c.112%200%20.463-.075.463-.075l5.612.041c-2.244%203.56-4.018%204.081-4.018%204.698s1.697.45%202.335.22c3.05-1.1%206.327-4.531%206.89-5.519%202.36.295%204.345.33%204.786-.657Z%22%2F%3E%3Cpath%20fill%3D%22url(%23c)%22%20fill-rule%3D%22evenodd%22%20d%3D%22m17.885%2010.713.025.01c.125-.049.105-.233.07-.378-.078-.333-1.438-1.676-2.715-2.277-1.743-.82-3.025-.777-3.212-.398.356.726%201.998%201.408%203.714%202.12.723.3%201.46.606%202.118.923Z%22%20clip-rule%3D%22evenodd%22%2F%3E%3Cpath%20fill%3D%22url(%23d)%22%20fill-rule%3D%22evenodd%22%20d%3D%22M15.701%2018.036a10.296%2010.296%200%200%200-1.2-.37c.482-.862.583-2.138.128-2.945-.639-1.133-1.44-1.736-3.304-1.736-1.024%200-3.783.346-3.832%202.648-.005.242%200%20.464.017.667l5.036.037a17.264%2017.264%200%200%201-1.871%202.483c.669.172%201.221.316%201.728.448.48.125.92.24%201.38.357a21.003%2021.003%200%200%200%201.918-1.59Z%22%20clip-rule%3D%22evenodd%22%2F%3E%3Cpath%20fill%3D%22url(%23e)%22%20d%3D%22M6.848%2016.063c.206%201.75%201.2%202.435%203.232%202.638%202.032.203%203.197.067%204.749.208%201.296.118%202.453.778%202.882.55.386-.205.17-.947-.347-1.423-.67-.617-1.597-1.046-3.229-1.199.325-.89.234-2.138-.27-2.817-.731-.982-2.079-1.426-3.785-1.232-1.782.202-3.49%201.08-3.232%203.275Z%22%2F%3E%3C%2Fg%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22b%22%20x1%3D%2210.464%22%20x2%3D%2222.394%22%20y1%3D%2213.737%22%20y2%3D%2217.12%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%23fff%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23fff%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22c%22%20x1%3D%2220.386%22%20x2%3D%2211.779%22%20y1%3D%2213.509%22%20y2%3D%224.879%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%237258DC%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23797DEA%22%20stop-opacity%3D%220%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22d%22%20x1%3D%2215.94%22%20x2%3D%227.673%22%20y1%3D%2218.337%22%20y2%3D%2213.584%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%237461EA%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23BFC2FF%22%20stop-opacity%3D%220%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22e%22%20x1%3D%2211.177%22%20x2%3D%2216.765%22%20y1%3D%2213.648%22%20y2%3D%2220.749%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%23fff%22%2F%3E%3Cstop%20offset%3D%22.984%22%20stop-color%3D%22%23D5CEFF%22%2F%3E%3C%2FlinearGradient%3E%3CclipPath%20id%3D%22a%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%200h28v28H0z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3C%2Fsvg%3E';

/**
 * Rabby — vendored verbatim from
 * dist/wallets/walletConnectors/chunk-WX5DUHCU.js, same reason as the two above:
 * the /wallets barrel cannot be imported without breaking the production build.
 *
 * INJECTED-ONLY, like Phantom. No projectId, no WalletConnect, so it adds no
 * optional peer and cannot reach the WALLET-03 throwing-stub trap. It is also
 * safe in BOTH branches of wagmi.ts, including the no-projectId fallback.
 *
 * IT COSTS ZERO MOBILE SLOTS, which is the reason it is the only wallet added
 * here. `installed` is a hard boolean, so on a phone it is false, the entry is
 * not "ready", and RainbowKit's MobileOptions filters it out of the ~4-wide
 * strip entirely. On desktop WITH the extension it is deduped against the
 * EIP-6963 announcement by rdns `io.rabby`, so it never doubles a row. The one
 * state it exists for is desktop WITHOUT the extension, where RainbowKit keeps
 * the row for its install path — exactly the case EIP-6963 cannot cover, since
 * there is no provider to announce.
 *
 * NEVER force `installed: true` to make it appear on mobile. That is the
 * documented mobile-modal trap: the row renders and the tap silently does
 * nothing, because there is no injected provider behind it.
 */
export const rabbyWallet = (): Wallet => ({
  id: 'rabby',
  name: 'Rabby Wallet',
  rdns: 'io.rabby',
  iconUrl: async () => RABBY_ICON,
  iconBackground: '#8697FF',
  installed: hasInjectedProvider({ flag: 'isRabby' }),
  downloadUrls: {
    chrome: 'https://chrome.google.com/webstore/detail/rabby-wallet/acmacodkjbdgmoleebolmdjonilkdbch',
    browserExtension: 'https://rabby.io',
  },
  extension: {
    instructions: {
      learnMoreUrl: 'https://rabby.io/',
      steps: [
        {
          description: 'wallet_connectors.rabby.extension.step1.description',
          step: 'install',
          title: 'wallet_connectors.rabby.extension.step1.title',
        },
        {
          description: 'wallet_connectors.rabby.extension.step2.description',
          step: 'create',
          title: 'wallet_connectors.rabby.extension.step2.title',
        },
        {
          description: 'wallet_connectors.rabby.extension.step3.description',
          step: 'refresh',
          title: 'wallet_connectors.rabby.extension.step3.title',
        },
      ],
    },
  },
  createConnector: getInjectedConnector({ flag: 'isRabby' }),
});
