import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { useEvmHarvest } from '../../hooks/useEvmHarvest';
import { useSolanaSurface } from '../../lib/solanaSurface';
import type { EvmClaim } from '../../lib/harvest/evm';
import type { SolanaClaim } from '../../lib/harvest/solana';
import { promptCount, runHarvest, runSummary, type SendTogether } from '../../lib/harvest/run';
import { noteStakesChanged, useOnStakesChanged } from '../../lib/harvest/stakesChanged';
import { forgetHeldReads } from '../../lib/wallet/heldReads';
import {
  orderClaims,
  type ClaimResult, type ClaimState, type HarvestChain, type HarvestClaim, type HarvestHeld, type HarvestPlan, type HarvestUnread,
} from '../../lib/harvest/types';
import { HarvestView, type RunRow } from './HarvestView';

/**
 * The connected Solana wallet's harvest. The Earn list has NO Solana connection of its
 * own (lib/solanaSurface.ts: one connection per page, and here it is the top bar's), so
 * this reads with that connection's address and signs with its `signer`. The Solana code
 * loads only once an address is there, as the dashboard's reads do (useWalletBoard).
 */
function useSolanaHarvest(address: string | null, nonce: number): HarvestPlan<SolanaClaim> | null {
  // Kept with the wallet it was read for, so a switched wallet never shows the last one's rewards.
  const [read, setRead] = useState<{ owner: string; plan: HarvestPlan<SolanaClaim> } | null>(null);
  // Bumped by the retry timer below; a read runs again on it.
  const [retry, setRetry] = useState(0);
  const tried = useRef({ key: '', n: 0 });
  useEffect(() => {
    if (!address) return;
    let live = true;
    void import('../../lib/harvest/solana')
      .then((m) => m.readSolanaHarvest(address))
      .catch((e: unknown): HarvestPlan<SolanaClaim> => ({
        claims: [],
        held: [],
        unread: [{ key: 'sol', chain: 'solana', roomId: '', what: 'your Solana pools', detail: e instanceof Error ? e.message : 'the Solana code could not load' }],
      }))
      .then((plan) => {
        if (live) setRead({ owner: address, plan });
      });
    return () => {
      live = false;
    };
  }, [address, nonce, retry]);
  const plan = address && read?.owner === address ? read.plan : null;

  // A read that came back partly unread is asked again, twice, a little later. Quiet (a pool
  // page, a dashboard) hides a card with nothing to claim, so an RPC that turned a burst away,
  // or a page caught mid-deploy, left Harvest hidden until a reload (owner's board, 2026-10-30).
  const unreadNow = Boolean(plan && plan.unread.length > 0);
  useEffect(() => {
    if (!address || !unreadNow) return;
    const key = `${address}:${nonce}`;
    if (tried.current.key !== key) tried.current = { key, n: 0 };
    const wait = HARVEST_RETRY_MS[tried.current.n];
    if (wait === undefined) return;
    const t = setTimeout(() => {
      tried.current.n += 1;
      setRetry((r) => r + 1);
    }, wait);
    return () => clearTimeout(t);
  }, [address, nonce, unreadNow, read]);
  return plan;
}

/** When a partly unread Solana read is asked again: twice, never more, so a dead RPC is not hammered. */
const HARVEST_RETRY_MS: readonly number[] = [20_000, 60_000];

/** The Solana wallet signs several transactions on one prompt (the Buy-all order's test, lib/harvest/solana.ts signsAll). */
const signsAll = (signer: object | null | undefined) =>
  typeof (signer as { signAllTransactions?: unknown } | null | undefined)?.signAllTransactions === 'function';

/**
 * Harvest (owner, 2026-10-24): one press claims the connected wallets' staking rewards
 * from every island pool, instead of opening each pool and claiming there.
 *
 * It reads every pool for the wallets connected (Solana: each lighthouse pool and the
 * lock ladder; Ethereum and Base: each lighthouse pool), lists what each can claim in its
 * own coin, and sends one claim per pool position, each its own transaction. A wallet
 * that can sign a chain's claims together is asked once for them (owner, 2026-10-29);
 * any other once per claim. A pool that could not be read is listed as not read, never
 * as nothing to claim; rewards a pool cannot pay yet are listed and left alone.
 *
 * With no wallet connected it draws nothing: there is nothing of the visitor's to show,
 * and the top bar's Connect is the way in (the list's word budget, e2e/word-budget.spec.ts).
 *
 * It also sits on every pool's page and on the dashboard (owner, 2026-10-30), `quiet`: there
 * it draws only while there is something to claim or a harvest on screen, so a page whose
 * own card already says everything gains no "Reading…" or "Nothing to claim" line. Any page
 * with a Solana connection can hold it: it signs with that page's one connection.
 *
 * This is the reading and the run. What it draws is HarvestView.tsx, which takes plain values
 * (owner, 2026-11-14: "next gen esp the harvest": the claims drawn as plates, HarvestStack.tsx).
 */
export function HarvestCard({ quiet = false, headingLevel = 2, className = 'mb-6' }: {
  quiet?: boolean;
  headingLevel?: 2 | 3;
  /** The card's own spacing, so a quiet card that draws nothing leaves no gap behind. */
  className?: string;
}) {
  const evm = useEvmHarvest();
  const surface = useSolanaSurface().surface;
  const solAddress = surface?.address ?? null;
  const [solNonce, setSolNonce] = useState(0);
  const solPlan = useSolanaHarvest(solAddress, solNonce);
  const [run, setRun] = useState<{ rows: RunRow[]; done: boolean } | null>(null);
  const [me] = useState(() => ({}));

  // Afresh: never a pool read held for this load (lib/wallet/heldReads.ts).
  const reread = () => {
    forgetHeldReads();
    setSolNonce((n) => n + 1);
    void evm.refetch();
  };
  // A claim made by the page's own pool card changes what this lists.
  useOnStakesChanged(me, reread);

  const evmPlan: HarvestPlan<EvmClaim> | null = evm.address ? evm.plan : null;
  const reading = Boolean((solAddress && !solPlan) || (evm.address && !evmPlan));
  const claims: HarvestClaim[] = orderClaims([...(solPlan?.claims ?? []), ...(evmPlan?.claims ?? [])], evm.chain);
  const held: HarvestHeld[] = [...(solPlan?.held ?? []), ...(evmPlan?.held ?? [])];
  const unread: HarvestUnread[] = [...(solPlan?.unread ?? []), ...(evmPlan?.unread ?? [])];
  const running = run !== null && !run.done;
  const canTogether = (chain: HarvestChain) => (chain === 'solana' ? signsAll(surface?.signer) : evm.batchable[chain]);
  const asks = promptCount(claims, evm.chain, canTogether);

  if (!solAddress && !evm.address) return null;
  if (quiet && run === null && claims.length === 0) return null;

  const start = async () => {
    if (running || claims.length === 0) return;
    // The wallet that signs is the one connected when the press was made.
    const signer = (surface?.signer ?? null) as SignerWalletAdapter | null;
    const rows: RunRow[] = claims.map((claim) => ({ claim, state: { kind: 'waiting' } }));
    setRun({ rows, done: false });
    const onState = (key: string, state: ClaimState) =>
      setRun((r) => (r ? { ...r, rows: r.rows.map((x) => (x.claim.key === key ? { ...x, state } : x)) } : r));
    const together = (chain: HarvestChain): SendTogether<HarvestClaim> | null => {
      if (chain !== 'solana') return evm.together(chain) as SendTogether<HarvestClaim> | null;
      if (!signer || !signsAll(signer)) return null;
      return async (cs, settle) => {
        const m = await import('../../lib/harvest/solana');
        const wallet = m.signsAll(signer);
        return wallet ? m.sendClaimsTogether(cs as SolanaClaim[], wallet, settle) : 'one-by-one';
      };
    };
    const states = await runHarvest(claims, evm.chain, {
      together,
      send: (c): Promise<ClaimResult> => {
        if (c.chain === 'solana') {
          return signer
            ? (c as SolanaClaim).send(signer)
            : Promise.resolve({ kind: 'unconfirmed', reason: 'Your Solana wallet is not connected, so nothing was sent.' });
        }
        return evm.send(c as EvmClaim);
      },
      switchTo: evm.switchTo,
      onState,
    });
    setRun((r) => (r ? { ...r, done: true } : r));
    // The page's own pool card and dashboard read again (lib/harvest/stakesChanged.ts).
    noteStakesChanged(me);
    const summary = runSummary(states);
    if (states.some((s) => s.kind === 'claimed')) toast.success(`Harvest: ${summary}`);
    else toast.info(`Harvest: ${summary}`);
    reread();
  };

  let label: string;
  let disabled = true;
  if (running) {
    const at = run!.rows.findIndex((r) => r.state.kind === 'sending' || r.state.kind === 'waiting');
    label = `Claiming ${Math.max(at, 0) + 1} of ${run!.rows.length}…`;
  } else if (run?.done) {
    label = 'Check again';
    disabled = false;
  } else if (reading) label = 'Reading your pools…';
  else if (claims.length === 0) label = 'Nothing to claim';
  else {
    label = `Harvest all · ${claims.length} ${claims.length === 1 ? 'claim' : 'claims'}`;
    disabled = false;
  }
  const press = () => {
    if (run?.done) {
      setRun(null);
      reread();
      return;
    }
    void start();
  };

  return (
    <HarvestView
      className={className}
      headingLevel={headingLevel}
      claims={claims}
      held={held}
      unread={unread}
      run={run}
      reading={reading}
      label={label}
      disabled={disabled}
      asks={asks}
      onPress={press}
      onReread={reread}
    />
  );
}
