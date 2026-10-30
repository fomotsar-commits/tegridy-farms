import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { useEvmHarvest } from '../../hooks/useEvmHarvest';
import { useSolanaSurface } from '../../lib/solanaSurface';
import { getTxUrl } from '../../lib/explorer';
import { fmtAmount } from '../../lib/wallet/walletRows';
import { EVM_CHAIN_IDS, type EvmClaim } from '../../lib/harvest/evm';
import type { SolanaClaim } from '../../lib/harvest/solana';
import { promptCount, runHarvest, runSummary, type SendTogether } from '../../lib/harvest/run';
import {
  HARVEST_CHAIN_LABEL, orderClaims,
  type ClaimResult, type ClaimState, type HarvestChain, type HarvestClaim, type HarvestHeld, type HarvestPlan, type HarvestUnread,
} from '../../lib/harvest/types';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';

/** A claim as the run snapshot keeps it: what was sent, and what it came to. */
type RunRow = { claim: HarvestClaim; state: ClaimState };

const txUrl = (claim: HarvestClaim, tx: string) =>
  claim.chain === 'solana' ? `https://solscan.io/tx/${tx}` : getTxUrl(EVM_CHAIN_IDS[claim.chain], tx);

/**
 * The connected Solana wallet's harvest. The Earn list has NO Solana connection of its
 * own (lib/solanaSurface.ts: one connection per page, and here it is the top bar's), so
 * this reads with that connection's address and signs with its `signer`. The Solana code
 * loads only once an address is there, as the dashboard's reads do (useWalletBoard).
 */
function useSolanaHarvest(address: string | null, nonce: number): HarvestPlan<SolanaClaim> | null {
  // Kept with the wallet it was read for, so a switched wallet never shows the last one's rewards.
  const [read, setRead] = useState<{ owner: string; plan: HarvestPlan<SolanaClaim> } | null>(null);
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
  }, [address, nonce]);
  return address && read?.owner === address ? read.plan : null;
}

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
 */
export function HarvestCard() {
  const evm = useEvmHarvest();
  const surface = useSolanaSurface().surface;
  const solAddress = surface?.address ?? null;
  const [solNonce, setSolNonce] = useState(0);
  const solPlan = useSolanaHarvest(solAddress, solNonce);
  const [run, setRun] = useState<{ rows: RunRow[]; done: boolean } | null>(null);

  const evmPlan: HarvestPlan<EvmClaim> | null = evm.address ? evm.plan : null;
  const reading = Boolean((solAddress && !solPlan) || (evm.address && !evmPlan));
  const claims: HarvestClaim[] = orderClaims([...(solPlan?.claims ?? []), ...(evmPlan?.claims ?? [])], evm.chain);
  const held: HarvestHeld[] = [...(solPlan?.held ?? []), ...(evmPlan?.held ?? [])];
  const unread: HarvestUnread[] = [...(solPlan?.unread ?? []), ...(evmPlan?.unread ?? [])];
  const running = run !== null && !run.done;
  const canTogether = (chain: HarvestChain) => (chain === 'solana' ? signsAll(surface?.signer) : evm.batchable[chain]);
  const asks = promptCount(claims, evm.chain, canTogether);

  if (!solAddress && !evm.address) return null;

  const reread = () => {
    setSolNonce((n) => n + 1);
    void evm.refetch();
  };

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
    <section aria-labelledby="harvest-heading" className="mb-6">
      <div
        className="relative isolate rounded-2xl overflow-hidden px-4 py-4"
        style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
      >
        <CardArt pageId="earn" idx={2} />
        <h2 id="harvest-heading" className="heading-luxury text-xl text-white mb-1">Harvest</h2>
        <p className="text-white/80 text-[13px] leading-relaxed m-0">Claim every pool&rsquo;s rewards at once.</p>
        {/* How money moves, in view (owner, 2026-10-09). */}
        <p className="text-white/60 text-[12px] leading-relaxed mt-1 mb-0">
          Each pool pays you from its own reward vault. The venue takes nothing; you pay the network fees.
        </p>

        {run ? (
          <ul className="list-none p-0 mt-3 mb-0 space-y-1.5" aria-label="This harvest">
            {run.rows.map((r) => <ClaimRow key={r.claim.key} claim={r.claim} state={r.state} />)}
          </ul>
        ) : (
          <>
            {claims.length > 0 && (
              <ul className="list-none p-0 mt-3 mb-0 space-y-1.5" aria-label="Ready to claim">
                {claims.map((c) => <ClaimRow key={c.key} claim={c} state={null} />)}
              </ul>
            )}
            {held.length > 0 && (
              <ul className="list-none p-0 mt-2 mb-0 space-y-1.5" aria-label="Left alone">
                {held.map((h) => <HeldRow key={h.key} held={h} />)}
              </ul>
            )}
            {unread.length > 0 && (
              <ul className="list-none p-0 mt-2 mb-0 space-y-1.5" aria-label="Not read">
                {unread.map((u) => (
                  <li key={u.key} className="text-[12px] leading-relaxed" style={{ color: '#f0b26b' }}>
                    Could not read {u.what} ({u.detail}). Not a zero.{' '}
                    <button type="button" onClick={reread} className="underline underline-offset-2 hover:text-white">Try again</button>
                  </li>
                ))}
              </ul>
            )}
            {!reading && claims.length === 0 && held.length === 0 && unread.length === 0 && (
              <p className="text-white/70 text-[13px] mt-3 mb-0">Nothing to claim right now.</p>
            )}
          </>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" onClick={press} disabled={disabled} className="btn-primary px-5 py-2.5 text-[13px] disabled:opacity-60">
            {label}
          </button>
          {run?.done ? (
            <span className="text-white/75 text-[12px]" role="status">Done: {runSummary(run.rows.map((r) => r.state))}.</span>
          ) : claims.length > 1 && !running ? (
            <span className="text-white/60 text-[12px]">{asks === 1 ? 'Your wallet asks once.' : `Your wallet asks ${asks} times.`}</span>
          ) : null}
        </div>

        <FinePrint summary="How it works">
          <p>
            Harvest reads every island pool for the wallets you have connected: each lighthouse pool and the lock
            ladder on Solana, and each lighthouse pool on Ethereum and Base. It claims every reward it read above
            zero, one transaction per pool position: Solana first, then Ethereum and Base, switching network once
            between them. A wallet that can sign several at once is asked once per network; any other, once per
            claim. Claiming moves no stake and changes no lock.
          </p>
          <p>
            A pool it could not read is listed as not read, never as nothing to claim. It leaves alone a reward the
            pool cannot pay yet (its vault is short or empty; nothing is lost, it stays owed), a reward paid in
            another coin, and the classic farm, whose claim can also extend a lock. Claim those on their own page.
          </p>
          <p>
            On Solana each claim is test-run first, and one its pool would refuse is not put to your wallet. A claim
            paid stays paid if another one does not go through, unless your wallet bundles the Ethereum or Base
            claims into one transaction: then they go through or fail together. If you cancel in your wallet,
            Harvest stops and sends nothing more. A claim whose outcome could not be read also stops it, so you can
            check before anything is sent twice.
          </p>
        </FinePrint>
      </div>
    </section>
  );
}

function amountText(raw: bigint | null, decimals: number, symbol: string) {
  return raw === null ? symbol : `${fmtAmount(raw, decimals)} ${symbol}`;
}

const STATE_WORDS: Record<ClaimState['kind'], { text: string; color: string }> = {
  waiting: { text: 'Waiting', color: 'rgba(255,255,255,0.55)' },
  sending: { text: 'At your wallet…', color: '#e3b341' },
  claimed: { text: 'Claimed', color: 'var(--color-kyle)' },
  reverted: { text: 'Refused on chain', color: '#f08a6b' },
  unconfirmed: { text: 'Not confirmed', color: '#f0b26b' },
  declined: { text: 'Cancelled', color: 'rgba(255,255,255,0.55)' },
  'not-sent': { text: 'Not sent', color: 'rgba(255,255,255,0.55)' },
};

function ClaimRow({ claim, state }: { claim: HarvestClaim; state: ClaimState | null }) {
  const words = state ? STATE_WORDS[state.kind] : null;
  const tx = state && 'tx' in state ? state.tx : undefined;
  const note = state && 'reason' in state ? state.reason : claim.caution;
  return (
    <li className="rounded-lg px-3 py-2" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-white text-[14px] font-semibold tabular-nums">{amountText(claim.amountRaw, claim.decimals, claim.symbol)}</span>
        <span className="text-white/60 text-[12px]">
          {claim.where} · {HARVEST_CHAIN_LABEL[claim.chain]}{claim.detail ? ` · ${claim.detail}` : ''}
        </span>
        {words && (
          <span className="ml-auto text-[12px] font-semibold" style={{ color: words.color }}>
            {tx ? (
              <a href={txUrl(claim, tx)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2"
                aria-label={`${words.text}: view the transaction (opens in new tab)`}>
                {words.text} ↗
              </a>
            ) : words.text}
          </span>
        )}
      </div>
      {note && <p className="text-[12px] leading-relaxed mt-1 mb-0" style={{ color: '#f0b26b' }}>{note}</p>}
    </li>
  );
}

function HeldRow({ held }: { held: HarvestHeld }) {
  return (
    <li className="rounded-lg px-3 py-2" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-white/75 text-[13px] font-semibold tabular-nums">{amountText(held.amountRaw, held.decimals, held.symbol)}</span>
        <span className="text-white/50 text-[12px]">{held.where} · {HARVEST_CHAIN_LABEL[held.chain]}</span>
        <Link to={`/earn/${held.roomId}`} aria-label={`The ${held.symbol} pool's page`}
          className="ml-auto text-[12px] underline underline-offset-2 text-white/75 hover:text-white">
          Its page
        </Link>
      </div>
      <p className="text-white/60 text-[12px] leading-relaxed mt-1 mb-0">{held.reason}</p>
    </li>
  );
}
