import type { Address } from 'viem';
import { CONFIGURED_CHAIN_IDS, getChainConfig } from '../chains/registry';
import { curveLauncherOn } from './curve';

export interface CurveChain {
  chainId: number;
  name: string;
  launcher: Address;
}

/**
 * The chains the Memetics curve is actually deployed on, in registry order.
 *
 * DERIVED, NEVER HAND-LISTED: a fourth deployment appears here the moment its
 * address lands in the chain registry, and a chain whose launcher is absent
 * never gets an entry that leads nowhere.
 *
 * Lifted out of EthCurvePage.tsx on 2026-09-04, where it was a private helper,
 * because the nav now needs the same answer. The menu used to call this rail
 * "Memetics Curve (EVM)" while `soon`/`live` read ONLY the mainnet address —
 * so the launcher that is live on Base (8453) and Robinhood Chain (4663) was
 * named after neither, and a visitor looking for the Robinhood launcher had no
 * string in the product to find it by. Both facts now come from here.
 */
export function deployedCurveChains(): CurveChain[] {
  const out: CurveChain[] = [];
  for (const chainId of CONFIGURED_CHAIN_IDS) {
    const a = curveLauncherOn(chainId);
    if (a.status !== 'deployed') continue;
    out.push({
      chainId,
      name: getChainConfig(chainId)?.name ?? `Chain ${chainId}`,
      launcher: a.address,
    });
  }
  return out;
}

/**
 * "Ethereum · Base · Robinhood Chain" — the deployed chains, for a label.
 *
 * Empty string when nothing is deployed, so a caller building a label must
 * handle that rather than rendering an orphan separator. Callers pair this with
 * `isCurveLive()`, which is the same read.
 */
export function curveChainNames(): string {
  return deployedCurveChains()
    .map((c) => c.name)
    .join(' · ');
}

/**
 * Is the curve launchable anywhere we serve?
 *
 * This is what the nav's SOON/LIVE pill must key on. It used to be
 * `isDeployed(CURVE_LAUNCHER_ADDRESS)` — mainnet alone — which is a strictly
 * narrower claim than the entry makes: with mainnet dark and Base live, the
 * menu would have pilled a launcher that launches.
 */
export function isCurveLive(): boolean {
  return deployedCurveChains().length > 0;
}
