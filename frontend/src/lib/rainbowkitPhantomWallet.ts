// VENDORED from @rainbow-me/rainbowkit@2.2.11 — phantomWallet + the injected-
// connector helper it uses (src/wallets/walletConnectors/phantomWallet/
// phantomWallet.ts and src/wallets/getInjectedConnector.ts, copied verbatim
// and TypeScript-typed; the icon is the package's own data-URI svg module).
//
// WHY VENDORED, not imported: the only public path to phantomWallet is the
// '@rainbow-me/rainbowkit/wallets' barrel (the exports map exposes no deeper
// subpath), and that barrel re-exports every wallet — including portoWallet
// and geminiWallet, whose chunks `import { porto } / { gemini } from
// "wagmi/connectors"`. Those named exports do not exist in the installed
// wagmi 3.7.6, so rolldown fails the PRODUCTION build with MISSING_EXPORT the
// moment anything imports the barrel — while dev, tsc and vitest all stay
// green (the same green-in-dev/dead-in-build family as WALLET-03 and the
// vendored wallet-adapter css). The helper below touches only public wagmi
// API (createConnector, injected), so this file has no private dependency.
//
// On a RainbowKit upgrade: if the barrel becomes importable against the
// installed wagmi (or a phantom subpath export appears), delete this file and
// import { phantomWallet } from '@rainbow-me/rainbowkit/wallets' instead.
import { createConnector } from 'wagmi';
import { injected } from 'wagmi/connectors';
import type { Wallet, WalletDetailsParams } from '@rainbow-me/rainbowkit';

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
