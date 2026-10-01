// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../../../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { SolanaProviders } from '../SolanaProviders';
import { feeSplit, solOf } from '../../../lib/solana/cpswap/venue';
import { feeRateText, solText } from '../../../lib/solana/lp/format';
import type { FeeTierRead } from '../../../lib/solana/lp/poolFinder';
import { lpWriteMode, type LpWriteMode } from '../../../lib/launcher/solana/lpWriteFlag';
import { isLpKind } from '../../../lib/launcher/solana/write/lpKinds';
import { Card, Notice, Row } from '../curve/ui';
import { PendingTradeCard } from '../curve/PendingTradeCard';
import type { GateRpc, LpKind, LpWriteApi } from '../curve/ports';
import { PoolFinder } from './PoolFinder';
import { parseMintInput } from '../../../lib/solana/lp/mintInput';
import { YourPositions } from './YourPositions';
import { LpGateBanner } from './LpGateBanner';
import { LpWritesProvider, useLpWrites } from './useLpWrites';
import { browserLpReaders, type LpReaders } from './readers';

/**
 * The Solana LP venue on /pools: a plain disclosure, the fee tiers as they are on chain,
 * the pool finder (token safety, every pool, each pool's health) and the wallet's own
 * positions.
 *
 * Adding and removing liquidity follow LP's own switch (lib/launcher/solana/lpWriteFlag):
 * with it 'off' (the shipped build) this section only reads, no write code is fetched,
 * and nothing on it can sign. Otherwise the cards and rows are wrapped in
 * `LpWritesProvider`, which loads the write code, reads the LP gate and offers Add and
 * Remove where `offers.ts` says so.
 *
 * `?mint=<address>` opens the finder on a token, so a pool list can be linked. Nothing
 * else is ever read from the URL: no amount, side, percent, slippage or open panel.
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

  return (
    <div className="space-y-4 mt-6" data-testid="lp-section" data-lp-mode={mode}>
      <LpDisclosure programId={readers.programId} mode={mode} />
      {mode !== 'off' && <LpWritesTop />}
      <FeeTiers readers={readers} />
      <PoolFinder readers={readers} mint={mint} onMint={onMint} linkError={linkError} reloadKey={reloadKey} />
      <YourPositions readers={readers} owner={publicKey ?? null} reloadKey={reloadKey} />
    </div>
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
  'lp-create': 'opening a pool',
};

/** The section's one sentence about what it can do, by LP's mode (spec 4.3). */
const DISCLOSURE_NOTICE: Record<LpWriteMode, string> = {
  off: 'This section only reads. Adding and removing liquidity here is not switched on yet.',
  on: 'Adding and removing liquidity here sends real transactions. Each one is read again, checked and test-run on the network before your wallet is asked to sign. This page shows no yield, because none has been measured.',
  'withdraw-only':
    'Adding liquidity from this site is paused right now. Removing it still works, and each removal is checked and test-run before your wallet is asked to sign.',
};

export function LpDisclosure({ programId, mode = 'off' }: { programId: string; mode?: LpWriteMode }) {
  return (
    <section data-testid="lp-disclosure" aria-label="Before you provide liquidity">
      <Card title="Before you provide liquidity">
        <p className="text-white/80">
          Our pool program is Raydium’s constant-product pool; we changed only its admin keys (see “The program” below).{' '}
          <strong>Those changes have not had their own independent review yet.</strong> Put in only what you can afford to lose.
        </p>
        <p>
          The team’s shared wallet (a Squads vault, two signatures needed) controls the program. It can switch off deposits,
          withdrawals or swaps on any pool, change the fee rates of a fee tier, and upgrade the program.
        </p>
        <p>
          Anyone can open a pool for any token, at any price. Aggregators such as Jupiter do not send trades to these pools yet, so
          most trades against a pool will be arbitrage bots, which can cost liquidity providers money when the price moves.
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

function FeeTiers({ readers }: { readers: LpReaders }) {
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
                      value={`${feeRateText(t.config.tradeFeeRate)} a trade`}
                      mono={false}
                    />
                    <Row
                      label="Split"
                      value={`LPs ${feeSplit(t.config).lpKeepsPct.toFixed(3)}%, venue ${feeSplit(t.config).venueTakesPct.toFixed(3)}% of each trade${t.config.creatorFeeRate > 0n ? `, creator ${feeRateText(t.config.creatorFeeRate)} on top in launch pools` : ''}`}
                      mono={false}
                    />
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
