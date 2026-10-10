// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../../../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { SolanaProviders } from '../SolanaProviders';
import { CREATOR_FEE_SWITCH, chargedCreatorFeeRate, feeSplit, solOf, tradeCost } from '../../../lib/solana/cpswap/venue';
import type { AmmConfigView } from '../../../lib/solana/cpswap/program';
import { feeRateText, solText, tradeCostText } from '../../../lib/solana/lp/format';
import type { FeeTierRead } from '../../../lib/solana/lp/poolFinder';
import { lpWriteMode, type LpWriteMode } from '../../../lib/launcher/solana/lpWriteFlag';
import { isLpKind } from '../../../lib/launcher/solana/write/lpKinds';
import { Card, Notice, Row } from '../curve/ui';
import { PendingTradeCard } from '../curve/PendingTradeCard';
import type { GateRpc, LpKind, LpWriteApi } from '../curve/ports';
import { PoolFinder, type PoolFinderHandle } from './PoolFinder';
import { parseMintInput } from '../../../lib/solana/lp/mintInput';
import { YourPositions } from './YourPositions';
import { HowItPays } from './HowItPays';
import { LpGateBanner } from './LpGateBanner';
import { LpWritesProvider, useLpWrites } from './useLpWrites';
import { browserLpReaders, type LpReaders } from './readers';

/**
 * The Solana LP section on /pools and /solana-lp: a plain disclosure, how a provider and
 * the venue earn, the fee tiers read from the chain, the pool finder and the wallet's own
 * positions. Adding, removing and opening pools follow LP's own switch (lpWriteFlag.ts):
 * with it 'off' no write code is fetched and nothing here can sign; otherwise
 * LpWritesProvider loads it and offers.ts decides each button. `?mint=<address>` opens the
 * finder on a token; nothing else is ever read from the URL (no amount, side, percent,
 * slippage or open panel).
 */
export default function SolanaLpSection({ readers: given, finderFirst = false }: {
  readers?: LpReaders;
  /**
   * /solana-lp: the finder comes first, under a one-line risk notice, then the positions,
   * the two earning cards, the full disclosure and the fee tiers. Without it the order is
   * /pools' own.
   */
  finderFirst?: boolean;
}) {
  const readers = useMemo(() => given ?? browserLpReaders(), [given]);
  if (!readers) return null;
  return (
    <SolanaProviders>
      <LpInner readers={readers} finderFirst={finderFirst} />
    </SolanaProviders>
  );
}

/** For tests: LP's mode, the write-code loader and the gate's reads. A real page passes none of them. */
export interface LpWritesOverrides {
  mode?: LpWriteMode;
  load?: () => Promise<LpWriteApi>;
  gateRpc?: GateRpc;
}

export function LpInner({ readers, writes, finderFirst = false }: { readers: LpReaders; writes?: LpWritesOverrides; finderFirst?: boolean }) {
  // Fixed for the life of a build: a production build reads only the committed constant.
  const mode = writes?.mode ?? lpWriteMode();
  // Bumped when a liquidity flow goes back to idle after an outcome: the finder and the
  // positions read again, keeping what they show until the new answer arrives.
  const [reloadKey, setReloadKey] = useState(0);
  const finished = useCallback(() => setReloadKey((k) => k + 1), []);
  const body = <LpBody readers={readers} mode={mode} reloadKey={reloadKey} finderFirst={finderFirst} />;
  if (mode === 'off') return body;
  return (
    <LpWritesProvider readers={readers} mode={mode} load={writes?.load} gateRpc={writes?.gateRpc} onFinished={finished}>
      {body}
    </LpWritesProvider>
  );
}

function LpBody({ readers, mode, reloadKey, finderFirst }: { readers: LpReaders; mode: LpWriteMode; reloadKey: number; finderFirst: boolean }) {
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

  const disclosure = <LpDisclosure programId={readers.programId} mode={mode} />;
  const writesTop = mode !== 'off' && <LpWritesTop />;
  const tierRead = useFeeTiers(readers);
  const tiers = <FeeTiers read={tierRead} />;
  // How a provider earns and how the venue does, beside the tiers their numbers come from.
  const howItPays = <HowItPays read={tierRead} />;
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
  const finder = (
    <PoolFinder
      ref={finderRef}
      readers={readers}
      mint={mint}
      onMint={onMint}
      linkError={linkError}
      reloadKey={reloadKey}
      wantOutside={mode === 'on'}
      onRemove={toPositions}
    />
  );
  const positions = <YourPositions readers={readers} owner={publicKey ?? null} reloadKey={reloadKey} sectionRef={positionsRef} onAddMore={addMore} />;

  // Finder first sits right under the page's hero, which already leaves the gap above it.
  // The earning cards come straight after the positions, before the long notice.
  if (finderFirst) {
    return (
      <div className="flex flex-col gap-4" data-testid="lp-section" data-lp-mode={mode}>
        <LpRiskLine />
        {writesTop}
        {finder}
        <LpEarnLine />
        {positions}
        {howItPays}
        {disclosure}
        {tiers}
      </div>
    );
  }
  return (
    <div className="space-y-4 mt-6" data-testid="lp-section" data-lp-mode={mode}>
      {disclosure}
      {writesTop}
      {howItPays}
      {tiers}
      {finder}
      {positions}
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
    <p data-testid="lp-risk-line" className="sm:-order-2 rounded-xl px-4 py-2.5 sm:py-3 text-amber-200 text-[13px] leading-snug sm:leading-relaxed" style={RISK_LINE_STYLE}>
      These pools run on a pool program whose admin-key changes have not had their own independent review yet. Put in only what
      you can afford to lose. The full notice is below your positions.
    </p>
  );
}

/**
 * One line saying fees need no claim, and where the earning cards are. From `sm:` up it is
 * drawn above the finder, on the first screen. On a phone it stays under the finder: there
 * the first screen is the finder's three buttons (e2e/tab-target-size.spec.ts pins them),
 * and a line above them would push them under the bottom bar.
 */
function LpEarnLine() {
  return (
    <p data-testid="lp-earn-line" className="sm:-order-1 px-1 text-white/85 text-[13px] leading-snug">
      Trading fees are added to your pool shares as trades happen, so there is nothing to claim. How you earn, and how the venue
      earns, is under your positions.
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

export function LpDisclosure({ programId, mode = 'off' }: { programId: string; mode?: LpWriteMode }) {
  // "The program" (VenueProgramCard) is the last section of every page that mounts this one.
  return (
    <section data-testid="lp-disclosure" aria-label="Before you provide liquidity">
      <Card title="Before you provide liquidity">
        {/* True of the pool program RUNNING on mainnet, built before the source gained create_lp_metadata.
            It goes false the day that program is upgraded: reword it in the same release as the upgrade
            (src/test/poolProgramCopy.test.ts fails that release until you do, and holds the wording). */}
        <p className="text-white/80">
          Our pool program is Raydium’s constant-product pool; we changed only its admin keys (see “The program” below).{' '}
          <strong>Those changes have not had their own independent review yet.</strong> Put in only what you can afford to lose.
        </p>
        <p>
          The team’s shared wallet (a Squads vault, two signatures needed) controls the program. It can switch off deposits,
          withdrawals or swaps on any pool, change the fee rates of a fee tier, and upgrade the program.
        </p>
        <p>
          Anyone can open a pool for any token, at any price. Jupiter does not send trades to these pools yet, so a pool earns fees
          only from trades sent to it by this site’s own swap, or by someone using the pool program directly. When the price moves,
          liquidity providers can end up with less than if they had just held both tokens.
        </p>
        <Row label="Pool program" value={programId} />
        <Notice>{DISCLOSURE_NOTICE[mode]}</Notice>
      </Card>
    </section>
  );
}

/**
 * What opening a pool costs: the tier's fee, plus the account deposits (rent) the pool
 * program takes for the pool, its price record, its LP mint and its vaults, which are
 * never refunded. "No fee" is never "free".
 */
function openingCost(fee: bigint, deposits: bigint | null): string {
  const feeText = fee > 0n ? `${solOf(fee)} SOL fee` : 'No fee';
  return deposits === null
    ? `${feeText}, plus account deposits that are never refunded (their amount could not be read)`
    : `${feeText}, plus about ${solText(deposits)} of account deposits that are never refunded`;
}

/**
 * What a trade on a tier costs. A tier with a creator rate charges it only in the pools
 * whose own switch is on, which are the launch program's (CREATOR_FEE_SWITCH): a launch
 * pool costs both fees, a pool anyone opens costs the trade fee alone. Both are said.
 */
function tierCostText(config: AmmConfigView): string {
  if (config.creatorFeeRate === 0n) return tradeCostText(config, CREATOR_FEE_SWITCH.publicOpen);
  const launch = tradeCost(config, chargedCreatorFeeRate(config, CREATOR_FEE_SWITCH.launchPool));
  return `${feeRateText(launch.totalRate)} a trade in launch pools (${feeRateText(launch.tradeFeeRate)} trade fee, ${feeRateText(launch.creatorFeeRate)} creator fee); ${feeRateText(config.tradeFeeRate)} in a pool anyone opens`;
}

/** The section's one read of the fee tiers: the Fee tiers card and the two earning cards print the same answer. */
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

function FeeTiers({ read }: { read: FeeTierRead | null }) {
  return (
    <section data-testid="fee-tiers" aria-label="Fee tiers">
      <Card title="Fee tiers, read from the chain">
        {!read ? (
          <p>Reading the fee tiers…</p>
        ) : read.kind === 'unread' ? (
          <Notice tone="warn">The fee tiers could not be read ({read.detail}).</Notice>
        ) : (
          <ul className="space-y-2">
            {read.tiers.map((t) => (
              <li key={t.index} data-testid="fee-tier" data-index={t.index} data-state={t.state}>
                {t.state === 'live' && t.config ? (
                  <>
                    <Row
                      label={`Tier ${t.index}${t.index === 0 ? ' (graduated launches)' : t.index === 1 ? ' (public pools)' : ''}`}
                      value={tierCostText(t.config)}
                      mono={false}
                    />
                    <Row
                      label="Split"
                      value={`LPs ${feeSplit(t.config).lpKeepsPct.toFixed(3)}%, venue ${feeSplit(t.config).venueTakesPct.toFixed(3)}% of each trade`}
                      mono={false}
                    />
                    {t.config.creatorFeeRate > 0n && (
                      <Row
                        label="Creator fee"
                        value={`${feeRateText(t.config.creatorFeeRate)} a trade on top of the trade fee, in launch pools only; it goes to the token's creator, not to LPs`}
                        mono={false}
                      />
                    )}
                    <Row
                      label="To open a pool"
                      value={t.config.disableCreatePool ? 'switched off' : openingCost(t.config.createPoolFee, read.openingDeposits)}
                      mono={false}
                    />
                  </>
                ) : (
                  <Row label={`Tier ${t.index}`} value={t.state === 'absent' ? 'not created yet' : 'the account there is not a fee tier'} mono={false} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
