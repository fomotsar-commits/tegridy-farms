import { Link, useSearchParams } from 'react-router-dom';
import { useAccount, useSwitchChain } from 'wagmi';
import { toast } from 'sonner';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';
// FROM ./registry, NOT the ../../lib/chains barrel — deliberate, and the same
// import the repo already uses in ContractsPage and CurveTokenPage. The barrel
// re-exports viemChains (index.ts:23), which imports `fallback` from wagmi, so
// pulling it into a component drags a viem TRANSPORT into every consumer's
// module graph. That is not theoretical: it broke TradePage.trigger.test.tsx,
// whose wagmi mock has no `fallback` export — and it broke it as a suite that
// would not LOAD, which reports as 'all passed' with one fewer file.
import { getChainConfig } from '../../lib/chains/registry';
import { CHAIN_ID } from '../../lib/constants';

/** The visitor's own query (the open tab) with the swap's chain set to Ethereum. */
function ethereumParams(params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.set('c', String(CHAIN_ID));
  return next.toString();
}

/**
 * Says WHY a trade tab is inert on a chain the app serves.
 *
 * 🔴 THE DEFECT THIS EXISTS FOR. Connect to a chain we serve and a form that does
 * not run there went quietly dead: its reads are gated off, the CTA disables
 * itself, and the global wrong-network banner stays silent because the chain IS
 * configured (AppLayout reads `!isChainConfigured`).
 *
 * TWO CASES since 2026-10-17, when Swap went live on Base and Robinhood Chain:
 *   - a chain whose `ammSwap` is off: the whole surface is empty there;
 *   - a chain that swaps but is not Ethereum: Swap works, and DCA, Limit, TWAP and
 *     Trigger still run on Ethereum only (their hooks pin CHAIN_ID).
 * Ethereum says nothing; an unconfigured chain says nothing (the app-wide banner
 * owns it).
 *
 * IT DOES NOT PROMISE ANYTHING. It says what is true today and what works instead,
 * and stops there.
 */
export function ChainSwapAvailability({ chainId, swapTab = false }: {
  chainId: number | undefined | null;
  /** True while the Swap tab is open (it runs on every chain with `ammSwap`). */
  swapTab?: boolean;
}) {
  const config = getChainConfig(chainId);
  const { isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const [params] = useSearchParams();

  // Unconfigured chain → the app-wide wrong-network banner owns that state, and
  // two banners saying different things about one wallet is worse than one.
  if (!config) return null;
  // Ethereum runs every tab. Nothing to explain.
  if (config.id === CHAIN_ID) return null;
  // The chain swaps and the Swap tab is open. Nothing to explain.
  if (config.capabilities.ammSwap && swapTab) return null;

  const curveHref = `/eth-curve?c=${config.id}`;
  const swaps = config.capabilities.ammSwap;

  return (
    <div
      className="relative isolate mb-4 rounded-xl border p-4"
      style={{
        background: 'rgba(245, 158, 11, 0.08)',
        borderColor: 'rgba(245, 158, 11, 0.30)',
      }}
      role="status"
    >
      <CardArt pageId="trade" idx={5} />
      <p className="text-amber-200 text-[13px] font-semibold mb-1">
        {swaps ? `Only Swap runs on ${config.name}` : `Swapping is not live on ${config.name} yet`}
      </p>
      <p className="text-white/70 text-[12px] leading-relaxed">
        {swaps
          ? 'DCA, Limit, TWAP and Trigger run on Ethereum only.'
          : 'This form reads Ethereum only, so it stays empty here.'}
      </p>
      <div className="mt-3 flex flex-wrap gap-3 text-[12px]">
        <Link to={curveHref} className="text-emerald-300 hover:text-emerald-200 underline">
          Trade on the {config.name} curve &rarr;
        </Link>
        {/* `?c=` picks the swap's chain, wallet or not, so the same tab opens on Ethereum.
            A connected wallet is asked to switch too, as a pick from the drop-down does. */}
        <Link
          to={`/swap?${ethereumParams(params)}`}
          onClick={() => {
            if (!isConnected) return;
            switchChain({ chainId: CHAIN_ID }, {
              onError: () => toast.error('Your wallet did not switch to Ethereum. Switch it in your wallet to use these tabs.'),
            });
          }}
          className="text-white/60 hover:text-white/80 underline"
        >
          Open {swaps ? 'these tabs' : 'swaps'} on Ethereum
        </Link>
      </div>
      {!swaps && (
        <FinePrint summary="Why">
          <p>
            The venue&rsquo;s router and factory are deployed on {config.name}, but the swap does
            not run here, so there is nothing to quote a price against. This form reads Ethereum
            only, which is why it stays empty rather than showing you a number it cannot fill.
          </p>
        </FinePrint>
      )}
    </div>
  );
}
