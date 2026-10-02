import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import {
  readCurveCreateBuy,
  readDopplerPlates,
  type CurveCreateBuy,
  type DopplerPlates,
  type PlatesRead,
  type PlatesReadClient,
} from '../../lib/launcher/birthPlates';
import { getTxUrl } from '../../lib/explorer';
import {
  ALLOCATION_READING,
  ALLOCATION_UNREADABLE,
  CREATE_BUY_UNREADABLE,
  CURVE_NO_LOCK,
  CURVE_READING,
  MAKER_IS_SENDER,
  NOT_DOPPLER,
  curveCreateBuyLines,
  dopplerPlatesLines,
} from './makerPlatesCopy';

// The maker's plates on the Ethereum rails (island rulings 3 and 4): on /eth-curve the maker's
// create-buy, on /launch the maker's allocation and its vesting lock. Each block loads on its
// own, above anything a visitor can trade, and an unread value says so, never 0.

const curveCard = { border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' } as const;

function TxLink({ chainId, tx }: { chainId: number; tx: string }) {
  return (
    <a
      href={getTxUrl(chainId, tx)}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 hover:text-white"
    >
      its launch transaction
    </a>
  );
}

/** /eth-curve: the maker's create-buy and the curve's lock line. `read` null = still reading. */
export function CurveMakerCreateBuyView({
  chainId,
  creator,
  read,
  onRetry,
}: {
  chainId: number;
  /** The launch's creator as getLaunch read it; shown in every state, like the Solana block. */
  creator: Address;
  read: PlatesRead<CurveCreateBuy> | null;
  onRetry?: () => void;
}) {
  const lines = read?.kind === 'ok' ? curveCreateBuyLines(read.value) : null;
  return (
    <div className="rounded-2xl p-4 space-y-1.5 text-[12.5px] leading-relaxed" style={curveCard} data-testid="curve-maker-create-buy">
      {read === null && <p className="text-white/60 animate-pulse">{CURVE_READING}</p>}
      {read?.kind === 'unreadable' && (
        <>
          <p className="text-white/75">{CREATE_BUY_UNREADABLE}</p>
          <p className="text-white/40 text-[10px] break-words">{read.detail}</p>
          {onRetry && (
            <button type="button" onClick={onRetry} className="btn-secondary px-3 py-1.5 text-[12px]">
              Read again
            </button>
          )}
        </>
      )}
      {read?.kind === 'ok' && lines && (
        <>
          <p className="text-white/80">{lines.maker}</p>
          {lines.others && <p className="text-white/75">{lines.others}</p>}
          <p className="text-white/40 text-[11px]">
            Read from <TxLink chainId={chainId} tx={read.value.tx} />.
          </p>
        </>
      )}
      <p className="text-white/45 text-[11px]">Maker&apos;s wallet</p>
      <p className="text-white/80 font-mono text-[12px] break-all">{creator}</p>
      <p className="text-white/75">{CURVE_NO_LOCK}</p>
    </div>
  );
}

/** Reads the create-buy on the launch's own chain, once per launch, and again on "Read again". */
export function CurveMakerCreateBuy({
  chainId,
  launcher,
  token,
  creator,
}: {
  chainId: number;
  launcher: Address;
  token: Address;
  creator: Address;
}) {
  const client = usePublicClient({ chainId }) as PlatesReadClient | undefined;
  const [attempt, setAttempt] = useState(0);
  // An answer counts only for the launch and attempt it was read for, so "reading" needs no reset.
  const key = `${chainId}:${launcher}:${token}:${creator}:${attempt}`;
  const [done, setDone] = useState<{ key: string; read: PlatesRead<CurveCreateBuy> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readCurveCreateBuy(client, { chainId, launcher, token, creator }).then((read) => {
      if (!cancelled) setDone({ key, read });
    });
    return () => {
      cancelled = true;
    };
  }, [client, chainId, launcher, token, creator, key]);
  const read = done?.key === key ? done.read : null;
  return <CurveMakerCreateBuyView chainId={chainId} creator={creator} read={read} onRetry={() => setAttempt((n) => n + 1)} />;
}

/** /launch: the maker's allocation, its lock, and what the launch transaction bought. null = reading. */
export function MakerPlatesView({ plates, onRetry }: { plates: DopplerPlates | null; onRetry?: () => void }) {
  const lines = plates?.kind === 'read' ? dopplerPlatesLines(plates) : null;
  return (
    <section className="glass-card rounded-xl p-5 mb-4" data-testid="maker-plates">
      <h2 className="text-[14px] font-semibold text-text-primary">The maker&apos;s allocation</h2>
      <div className="mt-2 space-y-1.5 text-[12.5px] text-text-secondary leading-relaxed">
        {plates === null && <p className="animate-pulse">{ALLOCATION_READING}</p>}
        {plates?.kind === 'not-doppler' && <p>{NOT_DOPPLER}</p>}
        {plates?.kind === 'unreadable' && (
          <>
            <p>{ALLOCATION_UNREADABLE}</p>
            <p className="text-[11px] text-text-muted break-words">{plates.detail}</p>
            {onRetry && (
              <button type="button" onClick={onRetry} className="btn-secondary text-[12px] px-3 py-1.5">
                Read again
              </button>
            )}
          </>
        )}
        {plates?.kind === 'read' && lines && (
          <>
            <p className="break-words">{lines.allocation}</p>
            {lines.others && <p>{lines.others}</p>}
            {lines.bought && <p>{lines.bought}</p>}
            <p className="text-[11px] text-text-muted">
              {plates.birth.maker && `${MAKER_IS_SENDER} `}Read from <TxLink chainId={1} tx={plates.birth.tx} />.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/** Loaded on its own, so the slow dossier reads below never hold the maker's plates. */
export function MakerPlatesCard({ client, token }: { client: PlatesReadClient | undefined | null; token: Address }) {
  const [attempt, setAttempt] = useState(0);
  const key = `${token}:${attempt}`;
  const [done, setDone] = useState<{ key: string; plates: DopplerPlates } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readDopplerPlates(client, token).then((plates) => {
      if (!cancelled) setDone({ key, plates });
    });
    return () => {
      cancelled = true;
    };
  }, [client, token, key]);
  return <MakerPlatesView plates={done?.key === key ? done.plates : null} onRetry={() => setAttempt((n) => n + 1)} />;
}
