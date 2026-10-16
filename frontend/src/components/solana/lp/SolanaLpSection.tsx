// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../../../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { SolanaProviders } from '../SolanaProviders';
import type { FeeTierRead } from '../../../lib/solana/lp/poolFinder';
import { lpWriteMode, type LpWriteMode } from '../../../lib/launcher/solana/lpWriteFlag';
import { isLpKind } from '../../../lib/launcher/solana/write/lpKinds';
import { Card, Row } from '../curve/ui';
import { CardArt } from '../../ui/CardArt';
import { FinePrint } from '../../ui/FinePrint';
import { PendingTradeCard } from '../curve/PendingTradeCard';
import type { GateRpc, LpKind, LpWriteApi } from '../curve/ports';
import { PoolFinder, type PoolFinderHandle } from './PoolFinder';
import { parseMintInput } from '../../../lib/solana/lp/mintInput';
import { YourPositions } from './YourPositions';
import { VenuePoolList } from './VenuePoolList';
import { Rates, Routes } from './RatesAndRoutes';
import { LpGateBanner } from './LpGateBanner';
import { RISK_SHORT } from './LpDisclosures';
import { LpWritesProvider, useLpWrites } from './useLpWrites';
import { browserLpReaders, type LpReaders } from './readers';

/**
 * The Solana LP section on /pools and /solana-lp, in one order on both (owner, 2026-10-14:
 * "the actions people need to take spotlighted and their positions and the rates and
 * routes getting the attention"): the risk line and the earn line, the three actions
 * (the finder), every pool, the wallet's positions, the rates read from the chain, where a swap goes,
 * and the full notice last. Adding, removing and opening pools follow LP's own switch (lpWriteFlag.ts):
 * with it 'off' no write code is fetched and nothing here can sign; otherwise
 * LpWritesProvider loads it and offers.ts decides each button. `?mint=<address>` opens the
 * finder on a token; nothing else is ever read from the URL (no amount, side, percent,
 * slippage or open panel).
 */
export default function SolanaLpSection({ readers: given }: { readers?: LpReaders }) {
  const readers = useMemo(() => given ?? browserLpReaders(), [given]);
  if (!readers) return null;
  return (
    <SolanaProviders>
      <LpInner readers={readers} />
    </SolanaProviders>
  );
}

/** For tests: LP's mode, the write-code loader and the gate's reads. A real page passes none of them. */
export interface LpWritesOverrides {
  mode?: LpWriteMode;
  load?: () => Promise<LpWriteApi>;
  gateRpc?: GateRpc;
}

export function LpInner({ readers, writes }: { readers: LpReaders; writes?: LpWritesOverrides }) {
  // Fixed for the life of a build: a production build reads only the committed constant.
  const mode = writes?.mode ?? lpWriteMode();
  // Bumped when a liquidity flow goes back to idle after an outcome: the finder and the
  // positions read again, keeping what they show until the new answer arrives.
  const [reloadKey, setReloadKey] = useState(0);
  const finished = useCallback(() => setReloadKey((k) => k + 1), []);
  const body = <LpBody readers={readers} mode={mode} reloadKey={reloadKey} />;
  if (mode === 'off') return body;
  return (
    <LpWritesProvider readers={readers} mode={mode} load={writes?.load} gateRpc={writes?.gateRpc} onFinished={finished}>
      {body}
    </LpWritesProvider>
  );
}

function LpBody({ readers, mode, reloadKey }: { readers: LpReaders; mode: LpWriteMode; reloadKey: number }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get('mint');
  const parsed = raw ? parseMintInput(raw) : null;
  const mint = parsed?.ok ? parsed.mint : null;
  const linkError = raw && parsed && !parsed.ok ? { raw, reason: parsed.reason } : null;
  const onMint = useCallback(
    (m: string | null) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        if (m) next.set('mint', m);
        else next.delete('mint');
        return next;
      });
    },
    [setParams],
  );
  const { publicKey } = useWallet();

  // The risk line above the actions says RISK_SHORT, so the notice says that risk only in full, in its small print.
  const disclosure = <LpDisclosure programId={readers.programId} mode={mode} riskAbove />;
  const writesTop = mode !== 'off' && <LpWritesTop />;
  const tierRead = useFeeTiers(readers);
  // Remove liquidity (the finder's third button) brings the positions onto the screen:
  // that is where every Remove button is. The section takes focus, so a keyboard and a
  // screen reader land there too.
  const positionsRef = useRef<HTMLElement | null>(null);
  const toPositions = useCallback(() => {
    const el = positionsRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: 'start' });
  }, []);
  // The other way round: Add more liquidity on a position goes to the finder. The
  // positions list does not look pools up or open Add forms; the finder does both, so the
  // press is handed to it with the token and the pool that share is in. The finder then
  // brings its answer onto the screen, as for any lookup the visitor asked for.
  const finderRef = useRef<PoolFinderHandle | null>(null);
  const addMore = useCallback((tokenMint: string, pool: string) => finderRef.current?.addTo(tokenMint, pool), []);
  // Every pool, under the finder: a View there is a lookup in the finder, like a picked token.
  const view = useCallback((tokenMint: string) => finderRef.current?.show(tokenMint), []);
  const allPools = <VenuePoolList readers={readers} reloadKey={reloadKey} onView={view} />;
  const finder = (
    <PoolFinder
      ref={finderRef}
      readers={readers}
      mint={mint}
      onMint={onMint}
      linkError={linkError}
      reloadKey={reloadKey}
      wantOutside={mode === 'on'}
      feeTiers={tierRead}
      onRemove={toPositions}
    />
  );
  const positions = <YourPositions readers={readers} owner={publicKey ?? null} reloadKey={reloadKey} sectionRef={positionsRef} onAddMore={addMore} />;

  // Actions first, under the one risk line and the one line on earning; then every pool;
  // then what you hold; then the rates and the routes; the long notice last.
  return (
    <div className="flex flex-col gap-4" data-testid="lp-section" data-lp-mode={mode}>
      <LpRiskLine />
      <LpEarnLine />
      {writesTop}
      {finder}
      {allPools}
      {positions}
      <Rates read={tierRead} />
      <Routes />
      {disclosure}
    </div>
  );
}

const RISK_LINE_STYLE = { background: 'rgba(28,21,6,0.92)', border: '1px solid rgba(227,179,65,0.45)' } as const;

/**
 * The short form of LpDisclosure, above the finder on a tab that opens on it. It may be
 * short only because the full card is on the same page, below the positions.
 * Set tighter on a phone, where each of its lines pushes the finder's field down.
 */
function LpRiskLine() {
  return (
    <p data-testid="lp-risk-line" className="relative isolate rounded-xl px-4 py-2.5 sm:py-3 text-amber-200 text-[13px] leading-snug sm:leading-relaxed" style={RISK_LINE_STYLE}>
      <CardArt pageId="solana-lp" idx={10} />
      {RISK_SHORT}
    </p>
  );
}

/**
 * One line saying fees need no claim, and where the earning cards are. It stands above the
 * finder at every size, in the page as it is drawn, so it is on the first screen and a
 * screen reader hears it first. The finder's three buttons still fit under it on the
 * shortest phone (e2e/tab-target-size.spec.ts pins both).
 */
function LpEarnLine() {
  return (
    <p data-testid="lp-earn-line" className="px-1 text-white/85 text-[13px] leading-snug">
      Fees grow your pool shares. Nothing to claim.
    </p>
  );
}

/** At the top of the section: why adding and removing are not offered, and any liquidity change still landing. */
function LpWritesTop() {
  const writes = useLpWrites();
  if (!writes) return null;
  const { api, cfg, pending } = writes;
  return (
    <>
      <LpGateBanner writes={writes} />
      {/* The notes hold their pools from the first render; the card needs the write code for its links and checks. */}
      {pending.notes.length > 0 && api && cfg && (
        <PendingTradeCard
          state={pending}
          explorerUrl={(sig) => api.explorerTxUrl(sig, cfg.cluster)}
          title="Your last liquidity change may still be landing"
          testId="lp-pending"
          lead={
            <>
              <p>Sent, not confirmed yet. Adding or removing on that pool stays off until it is checked.</p>
              <p className="text-white/70">
                It may still go through. Sending it again could make you pay twice, or take out more than you meant. Another browser tab
                does not know about it.
              </p>
            </>
          }
          describe={(n) => (
            <>
              <Row label="Pool" value={n.pool ?? 'could not be read back: every pool is held until this is checked'} mono={n.pool !== null} />
              <Row label="What" value={isLpKind(n.kind) ? NOTE_WHAT[n.kind] : 'a liquidity change'} mono={false} />
            </>
          )}
        />
      )}
    </>
  );
}

/** What each liquidity note did, in a person's words. A Record, so a new kind must say. */
const NOTE_WHAT: Record<LpKind, string> = {
  'lp-deposit': 'adding liquidity',
  'lp-withdraw': 'removing liquidity',
  'lp-create': 'opening a pool. Opening another pool stays off until this is checked.',
};

/** The section's one sentence about what it can do, by LP's mode (spec 4.3). */
const DISCLOSURE_NOTICE: Record<LpWriteMode, string> = {
  off: 'This section only reads. Adding and removing liquidity here is not switched on yet.',
  on: 'Opening a pool, adding and removing liquidity here send real transactions. Each one is read again, checked and test-run on the network before your wallet is asked to sign. What this page says a pool or a position earned is measured from the chain, and is never a forecast.',
  'withdraw-only':
    'Adding liquidity from this site is paused right now. Removing it still works, and each removal is checked and test-run before your wallet is asked to sign.',
};

export function LpDisclosure({ programId, mode = 'off', riskAbove = false }: {
  programId: string;
  mode?: LpWriteMode;
  /**
   * The page already shows RISK_SHORT above the finder (LpRiskLine, finder first): the
   * card then does not say it again. Said once per page visibly (owner, 2026-10-14), and
   * once in full, with the addresses, in the small print below.
   */
  riskAbove?: boolean;
}) {
  // "The program" (VenueProgramCard) is the last section of every page that mounts this one.
  return (
    <section data-testid="lp-disclosure" aria-label="Before you provide liquidity">
      <Card title="Before you provide liquidity" art={<CardArt pageId="solana-lp" idx={0} />}>
        {!riskAbove && <p className="text-white/80">{RISK_SHORT}</p>}
        <Row label="Pool program" value={programId} />
        <FinePrint summary="Risks">
          {/* True of the pool program RUNNING on mainnet, built before the source gained create_lp_metadata.
              It goes false the day that program is upgraded: reword it in the same release as the upgrade
              (src/test/poolProgramCopy.test.ts fails that release until you do, and holds the wording). */}
          <p>
            Our pool program is Raydium’s constant-product pool; we changed only its admin keys (see “The program” below).{' '}
            <strong>Those changes have not had their own independent review yet.</strong> Put in only what you can afford to lose.
          </p>
          {/* Read on chain 2026-10-16. The vault's powers are the pool program's admin instructions (update_pool_status,
              update_amm_config, create_amm_config, collect_protocol_fee, collect_fund_fee) and its upgrade authority. */}
          <p>
            Read on chain 2026-10-16: one key is both the admin of pool program{' '}
            <span className="font-mono break-all">EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT</span> and the only key that can replace it.
            That key is the team’s vault <span className="font-mono break-all">GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd</span>, vault 0
            of the Squads multisig <span className="font-mono break-all">EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK</span>. The multisig
            needs 2 of its 2 keys to sign, has no waiting period (a time lock of 0 seconds), and only those 2 keys, together, can change
            its rules.
          </p>
          <p>
            The vault can switch off adding, removing or trading on any pool. It can change any fee tier’s fees, and who collects the
            venue’s share, at once, and that applies to pools already open. It can add fee tiers, collect the venue’s share of trading
            fees, and replace the program. If it switched off removing on a pool, you could not take your money out of that pool until
            it switched removing back on.
          </p>
          <p>
            Anyone can open a pool for any token, at any price. Jupiter does not send trades to these pools yet, so a pool earns fees
            only from trades sent to it by this site’s own swap, or by someone using the pool program directly. When the price moves,
            liquidity providers can end up with less than if they had just held both tokens.
          </p>
          <p>{DISCLOSURE_NOTICE[mode]}</p>
        </FinePrint>
      </Card>
    </section>
  );
}

/** The section's one read of the fee tiers: the Rates card prints it, and the Open a pool card says its account deposits. */
function useFeeTiers(readers: LpReaders): FeeTierRead | null {
  const [read, setRead] = useState<FeeTierRead | null>(null);
  useEffect(() => {
    let live = true;
    readers.feeTiers().then(
      (r) => {
        if (live) setRead(r);
      },
      (e: unknown) => {
        if (live) setRead({ kind: 'unread', detail: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [readers]);
  return read;
}
