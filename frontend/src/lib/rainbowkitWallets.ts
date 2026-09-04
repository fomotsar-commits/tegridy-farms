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
