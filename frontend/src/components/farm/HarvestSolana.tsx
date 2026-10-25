// Polyfill MUST load before any @solana/* import, same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { SolanaProviders } from '../solana/SolanaProviders';
import { readSolanaHarvest, type SolanaClaim } from '../../lib/harvest/solana';
import type { ClaimResult, HarvestClaim, HarvestPlan } from '../../lib/harvest/types';

/** What the Solana half tells the Harvest card. No Solana type crosses this line. */
export interface SolanaHarvestReport {
  address: string | null;
  /** Null while this wallet's pools are being read. */
  plan: HarvestPlan | null;
  /** Sends one claim of `plan` with the connected wallet; null when no wallet can sign. */
  send: ((claim: HarvestClaim) => Promise<ClaimResult>) | null;
  reread: () => void;
}

/**
 * Harvest's Solana half: the page's Solana connection on /earn, with nothing to draw.
 * Lazy, like every Solana section (check-dist-graph.mjs keeps @solana out of the entry),
 * and `mixed`, since /earn connects Ethereum too: ONE connection per page, and the top
 * bar borrows this one (lib/solanaSurface.ts).
 */
export default function HarvestSolana({ onReport }: { onReport: (r: SolanaHarvestReport | null) => void }) {
  return (
    <SolanaProviders mixed>
      <Reporter onReport={onReport} />
    </SolanaProviders>
  );
}

function Reporter({ onReport }: { onReport: (r: SolanaHarvestReport | null) => void }) {
  const { publicKey, wallet } = useWallet();
  const { connection } = useConnection();
  const address = publicKey ? publicKey.toBase58() : null;
  // Kept with the wallet it was read for, so a switched wallet never shows the last one's rewards.
  const [read, setRead] = useState<{ owner: string; plan: HarvestPlan<SolanaClaim> } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!address) return;
    let live = true;
    void readSolanaHarvest(address).then((plan) => {
      if (live) setRead({ owner: address, plan });
    });
    return () => {
      live = false;
    };
  }, [address, nonce]);

  const plan = address && read?.owner === address ? read.plan : null;
  const invoker = publicKey ? (wallet?.adapter as SignerWalletAdapter | undefined) : undefined;
  const send = useMemo(() => {
    if (!invoker || !plan) return null;
    return async (claim: HarvestClaim): Promise<ClaimResult> => {
      const c = plan.claims.find((x) => x.key === claim.key);
      if (!c) return { kind: 'unconfirmed', reason: 'This claim is no longer on the list, so nothing was sent.' };
      return c.send(invoker, connection);
    };
  }, [invoker, plan, connection]);
  const reread = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    onReport({ address, plan, send, reread });
  }, [onReport, address, plan, send, reread]);
  useEffect(() => () => onReport(null), [onReport]);
  return null;
}
