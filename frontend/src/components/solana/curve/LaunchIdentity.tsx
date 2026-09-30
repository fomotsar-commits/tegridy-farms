import { useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import { formatTokenAmount, type Read } from '../../../lib/launcher/solana/curve';
import { Notice, Row } from './ui';
import { sharePercent } from './uiFormat';
import type { LaunchLinks, MetadataApi, MetadataRead, TokenMetadata } from './ports';
import { identityWarnings, safeImageUrl } from './identity';
import { IpfsImg } from '../../IpfsImg';
import type { Fact } from './facts';

// Who a launch says it is, and the facts that decide whether to believe it.
//
// EVERY string here was written by whoever made the launch, possibly on another
// site, possibly to impersonate a coin people already know. So: every name, symbol
// and description goes through `displaySafe`; the symbol and name are re-checked
// against the reserved list and the lookalike rules on READ, not just on upload;
// a picture is shown only from a content address (IPFS or Arweave); links are re-checked
// and open with no referrer and no follow.

// 'X (Twitter)', not 'X': a one-letter link name means nothing read aloud.
const LINK_LABEL: Record<keyof LaunchLinks, string> = { website: 'Website', twitter: 'X (Twitter)', telegram: 'Telegram' };

export function LaunchImage({ src, size = 64 }: { src: string | null; size?: number }) {
  // The src whose every gateway failed or hung. Keyed on the src, so a new picture
  // gets its own walk down the gateway list instead of inheriting the old failure.
  const [exhausted, setExhausted] = useState<string | null>(null);
  return src && exhausted !== src ? (
    <IpfsImg
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onExhausted={() => setExhausted(src)}
      className="rounded-xl object-cover shrink-0 bg-black/40"
      style={{ width: size, height: size }}
    />
  ) : (
    <div
      aria-hidden="true"
      className="rounded-xl shrink-0 bg-black/40 border border-white/10"
      style={{ width: size, height: size }}
    />
  );
}

export function LaunchIdentity({
  meta,
  mint,
  metadata,
  json,
}: {
  meta: MetadataApi;
  mint: PublicKey;
  /** `null` while loading. */
  metadata: Read<TokenMetadata> | null;
  json: MetadataRead | null;
}) {
  const md = metadata?.kind === 'ok' ? metadata.value : null;
  const name = md ? meta.displaySafe(md.name, 32) : null;
  const symbol = md ? meta.displaySafe(md.symbol, 10) : null;
  const warnings = identityWarnings(meta, metadata, json);
  const image = safeImageUrl(meta, json);
  const description = json?.kind === 'ok' ? meta.displaySafe(json.json.description ?? '', 280) : '';
  const links =
    json?.kind === 'ok'
      ? meta.checkLinks({ website: json.json.website, twitter: json.json.twitter, telegram: json.json.telegram })
      : null;

  return (
    <div className="space-y-2" data-testid="launch-identity">
      <div className="flex items-center gap-3 min-w-0">
        <LaunchImage src={image} />
        <div className="min-w-0">
          <p className="text-white text-[16px] font-semibold break-words">
            {metadata === null
              ? 'Reading…'
              : md
                ? name || 'No name'
                : metadata.kind === 'absent'
                  ? 'No name (made outside this site)'
                  : 'Name could not be read'}
          </p>
          {symbol && <p className="text-white/70 font-mono text-[12px] break-all">{symbol}</p>}
        </div>
      </div>
      <Row label="Token address (mint)" value={mint.toBase58()} />
      <p className="text-amber-200/90 text-[11px]">
        Not endorsed by memetics.finance. A maker at Resident or better can grow a new token through the
        memetics.finance gate: the gate reads the maker&apos;s wallet at create. The program itself accepts any
        wallet, so check the full token address above before you buy.
      </p>
      {warnings.map((w) => (
        <Notice key={w} tone="warn">
          {w}
        </Notice>
      ))}
      {description && <p className="text-white/70 break-words whitespace-pre-line">{description}</p>}
      {json?.kind === 'unreadable' && <Notice>The picture and description could not be loaded right now.</Notice>}
      {links?.ok && (
        // A row of their own, not links in a sentence: each gets a full-size touch target.
        <div className="flex flex-wrap gap-x-1">
          {(Object.keys(LINK_LABEL) as (keyof LaunchLinks)[]).map((k) =>
            links.value[k] ? (
              <a
                key={k}
                href={links.value[k]}
                target="_blank"
                rel="noopener noreferrer nofollow"
                aria-label={`${LINK_LABEL[k]} (opens in a new tab)`}
                className="underline text-white/75 inline-flex items-center min-h-[44px] px-2"
              >
                {LINK_LABEL[k]}
              </a>
            ) : null,
          )}
        </div>
      )}
      {links && !links.ok && <Notice tone="warn">Its links were not shown: they do not pass our link rules.</Notice>}
    </div>
  );
}

/** What any wallet bought in the launch transaction, and what the creator holds now, as shares of the supply. Unread is said, never 0. */
export function CreatorStakeFacts({
  openingBuy,
  holding,
  supply,
  decimals,
}: {
  /** `null` while loading. */
  openingBuy: Fact<bigint> | null;
  holding: Fact<bigint> | null;
  supply: bigint | null;
  decimals: number | null;
}) {
  const fmt = (f: Fact<bigint> | null) => {
    if (f === null) return 'reading…';
    if (f.kind === 'unreadable') return 'could not read';
    const share = supply ? sharePercent(f.value, supply) : null;
    const amount = formatTokenAmount(f.value, decimals);
    return share ? `${share} of supply (${amount.text}${amount.isBaseUnits ? ' base units' : ''})` : amount.text;
  };
  return (
    <div className="space-y-1" data-testid="creator-stake">
      {/* Each reason sits under its own row, so it cannot read as explaining the other. */}
      <Row label="Bought in the launch transaction (any wallet)" value={fmt(openingBuy)} mono={false} />
      {openingBuy?.kind === 'unreadable' && <p className="text-white/40 text-[10px]">{openingBuy.detail}</p>}
      <Row label="Creator's wallet holds now (its usual account)" value={fmt(holding)} mono={false} />
      {holding?.kind === 'unreadable' && <p className="text-white/40 text-[10px]">{holding.detail}</p>}
    </div>
  );
}
