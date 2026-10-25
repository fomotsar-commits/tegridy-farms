import { lazy, Suspense, useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useEvmHarvest } from '../../hooks/useEvmHarvest';
import { useSolanaSurface, requestSolanaOpen } from '../../lib/solanaSurface';
import { getTxUrl } from '../../lib/explorer';
import { CONNECT_ETHEREUM_WALLET } from '../../lib/copy';
import { fmtAmount } from '../../lib/wallet/walletRows';
import { EVM_CHAIN_IDS, type EvmClaim } from '../../lib/harvest/evm';
import { runHarvest, runSummary } from '../../lib/harvest/run';
import {
  HARVEST_CHAIN_LABEL, orderClaims,
  type ClaimState, type HarvestClaim, type HarvestHeld, type HarvestPlan, type HarvestUnread,
} from '../../lib/harvest/types';
import type { SolanaHarvestReport } from './HarvestSolana';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';

// The Solana half carries the wallet adapter and the staking SDKs: lazy, and mounted only
// once this visitor has a Solana wallet in play, so a visitor who never touches Solana
// never downloads it (lib/solanaSurface.ts `ownWanted`).
const HarvestSolana = lazy(() => import('./HarvestSolana'));

/** A claim as the run snapshot keeps it: what was sent, and what it came to. */
type RunRow = { claim: HarvestClaim; state: ClaimState };

const txUrl = (claim: HarvestClaim, tx: string) =>
  claim.chain === 'solana' ? `https://solscan.io/tx/${tx}` : getTxUrl(EVM_CHAIN_IDS[claim.chain], tx);

/**
 * Harvest (owner, 2026-10-24): one press claims the connected wallets' staking rewards
 * from every island pool, instead of opening each pool and claiming there.
 *
 * It reads every pool for the wallets connected (Solana: each lighthouse pool and the
 * lock ladder; Ethereum and Base: each lighthouse pool), lists what each can claim in its
 * own coin, and sends one claim per pool position: the pool's own claim, one wallet
 * approval each. A pool that could not be read is listed as not read, never as nothing
 * to claim; rewards a pool cannot pay yet are listed and left alone.
 */
export function HarvestCard() {
  const evm = useEvmHarvest();
  const surface = useSolanaSurface();
  const [solAsked, setSolAsked] = useState(false);
  // Latched: once mounted, the page's Solana connection stays for the page's life. Its
  // own restore briefly reads "no address", and unmounting on that would loop.
  const [solOn, setSolOn] = useState(false);
  if (!solOn && (solAsked || surface.ownWanted || Boolean(surface.surface?.address))) setSolOn(true);
  const [sol, setSol] = useState<SolanaHarvestReport | null>(null);
  const onReport = useCallback((r: SolanaHarvestReport | null) => setSol(r), []);

  const [run, setRun] = useState<{ rows: RunRow[]; done: boolean } | null>(null);

  const solAddress = sol?.address ?? null;
  const solPlan: HarvestPlan | null = solAddress ? sol?.plan ?? null : null;
  const evmPlan: HarvestPlan<EvmClaim> | null = evm.address ? evm.plan : null;
  const reading = Boolean((solAddress && !solPlan) || (evm.address && !evmPlan));
  const claims: HarvestClaim[] = orderClaims([...(solPlan?.claims ?? []), ...(evmPlan?.claims ?? [])], evm.chain);
  const held: HarvestHeld[] = [...(solPlan?.held ?? []), ...(evmPlan?.held ?? [])];
  const unread: HarvestUnread[] = [...(solPlan?.unread ?? []), ...(evmPlan?.unread ?? [])];
  const anyWallet = Boolean(solAddress || evm.address);
  const running = run !== null && !run.done;

  const reread = () => {
    sol?.reread();
    void evm.refetch();
  };

  const start = async () => {
    if (running || claims.length === 0) return;
    const solSend = sol?.send ?? null;
    const rows: RunRow[] = claims.map((claim) => ({ claim, state: { kind: 'waiting' } }));
    setRun({ rows, done: false });
    const onState = (key: string, state: ClaimState) =>
      setRun((r) => (r ? { ...r, rows: r.rows.map((x) => (x.claim.key === key ? { ...x, state } : x)) } : r));
    const states = await runHarvest(claims, evm.chain, {
      send: (c) => {
        if (c.chain === 'solana') {
          return solSend ? solSend(c) : Promise.resolve({ kind: 'unconfirmed' as const, reason: 'Your Solana wallet is not connected, so nothing was sent.' });
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

  const connectSolana = () => {
    // This card's own connection opens its list once it loads (SolanaSurfaceBridge takes the tap).
    setSolAsked(true);
    requestSolanaOpen();
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
      {solOn && (
        <Suspense fallback={null}>
          <HarvestSolana onReport={onReport} />
        </Suspense>
      )}
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

        {!anyWallet ? (
          <p className="text-white/75 text-[13px] mt-3 mb-0">Connect a wallet to see what you can claim.</p>
        ) : run ? (
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

        {anyWallet && (
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <button type="button" onClick={press} disabled={disabled} className="btn-primary px-5 py-2.5 text-[13px] disabled:opacity-60">
              {label}
            </button>
            {run?.done ? (
              <span className="text-white/75 text-[12px]" role="status">Done: {runSummary(run.rows.map((r) => r.state))}.</span>
            ) : claims.length > 1 && !running ? (
              <span className="text-white/60 text-[12px]">Your wallet asks once per claim.</span>
            ) : null}
          </div>
        )}

        {(!solAddress || !evm.address) && !running && (
          <div className="mt-3 flex flex-wrap gap-2">
            {!solAddress && (
              <button type="button" onClick={connectSolana} className="btn-secondary px-4 py-2 text-[12px]">
                {surface.surface?.connecting ? 'Connecting…' : 'Connect Solana wallet'}
              </button>
            )}
            {!evm.address && (
              <ConnectButton.Custom>
                {({ openConnectModal, mounted }) => (
                  <button type="button" onClick={openConnectModal} disabled={!mounted} className="btn-secondary px-4 py-2 text-[12px]">
                    {CONNECT_ETHEREUM_WALLET}
                  </button>
                )}
              </ConnectButton.Custom>
            )}
          </div>
        )}

        <FinePrint summary="How it works">
          <p>
            Harvest reads every island pool for the wallets you have connected: each lighthouse pool and the lock
            ladder on Solana, and each lighthouse pool on Ethereum and Base. It claims every reward it read above
            zero, one transaction per pool position, so your wallet asks once per claim: Solana first, then Ethereum
            and Base, switching network once between them. Claiming moves no stake and changes no lock.
          </p>
          <p>
            A pool it could not read is listed as not read, never as nothing to claim. It leaves alone a reward the
            pool cannot pay yet (its vault is short or empty; nothing is lost, it stays owed), a reward paid in
            another coin, and the TOWELI farm, whose claim can also extend your lock. Claim those on their own page.
          </p>
          <p>
            If you cancel in your wallet, Harvest stops and sends nothing more. A claim whose outcome could not be
            read also stops it, so you can check before anything is sent twice.
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
