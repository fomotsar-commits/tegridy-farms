// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../../../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { SolanaProviders } from '../SolanaProviders';
import { feeSplit, solOf } from '../../../lib/solana/cpswap/venue';
import { feeRateText } from '../../../lib/solana/lp/format';
import type { FeeTierRead } from '../../../lib/solana/lp/poolFinder';
import { Card, Notice, Row } from '../curve/ui';
import { PoolFinder } from './PoolFinder';
import { parseMintInput } from '../../../lib/solana/lp/mintInput';
import { YourPositions } from './YourPositions';
import { browserLpReaders, type LpReaders } from './readers';

/**
 * The read-only half of the Solana LP venue on /pools: a plain disclosure, the fee tiers
 * as they are on chain, the pool finder (token safety, every pool, each pool's health)
 * and the wallet's own positions. Nothing here builds or signs a transaction.
 *
 * `?mint=<address>` opens the finder on a token, so a pool list can be linked.
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

export function LpInner({ readers }: { readers: LpReaders }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get('mint');
  const parsed = raw ? parseMintInput(raw) : null;
  const mint = parsed?.ok ? parsed.mint : null;
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
    <div className="space-y-4 mt-6" data-testid="lp-section">
      <LpDisclosure programId={readers.programId} />
      <FeeTiers readers={readers} />
      <PoolFinder readers={readers} mint={mint} onMint={onMint} />
      <YourPositions readers={readers} owner={publicKey ?? null} />
    </div>
  );
}

export function LpDisclosure({ programId }: { programId: string }) {
  return (
    <section data-testid="lp-disclosure" aria-label="Before you provide liquidity">
      <Card title="Before you provide liquidity">
        <p className="text-white/80">
          Our pool program is Raydium’s constant-product pool with our own admin keys. <strong>The changes we made to it have not had
          their own independent review yet.</strong> Put in only what you can afford to lose.
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
        <Notice>This section only reads. Adding and removing liquidity here is not switched on yet.</Notice>
      </Card>
    </section>
  );
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
                      value={t.config.disableCreatePool ? 'switched off' : t.config.createPoolFee > 0n ? `${solOf(t.config.createPoolFee)} SOL` : 'free'}
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
