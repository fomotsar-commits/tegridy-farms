import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BUNGALOWS } from '../../lib/bungalows';
import { EDITORIAL_BG, EDITORIAL_GRAIN, EDITORIAL_GREEN, EDITORIAL_INK, EDITORIAL_OUTLINE, HEADING_FONT, pad2 } from '../../lib/editorial';
import { getTxUrl } from '../../lib/explorer';
import { fmtAmount } from '../../lib/wallet/walletRows';
import { EVM_CHAIN_IDS } from '../../lib/harvest/evm';
import { runSummary } from '../../lib/harvest/run';
import { harvestTally, type TallyCoin } from '../../lib/harvest/tally';
import { fmtDaily } from '../../lib/ladder/format';
import {
  HARVEST_CHAIN_LABEL,
  type ClaimState, type HarvestClaim, type HarvestEarning, type HarvestHeld, type HarvestUnread,
} from '../../lib/harvest/types';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';
import { HarvestStack, type StackPlate } from './HarvestStack';

/** A claim as the run snapshot keeps it: what was sent, and what it came to. */
export type RunRow = { claim: HarvestClaim; state: ClaimState };

const txUrl = (claim: HarvestClaim, tx: string) =>
  claim.chain === 'solana' ? `https://solscan.io/tx/${tx}` : getTxUrl(EVM_CHAIN_IDS[claim.chain], tx);

/**
 * Harvest as it is drawn: the screen alone, from what HarvestCard.tsx read and ran. No wallet, no
 * chain and no timer here, so every state it can show (reading, ready, mid-run, done, nothing to
 * claim, a pool not read) can be drawn from plain values. What the words and the order mean is
 * HarvestCard's note; what the figure means is HarvestStack's.
 */
export function HarvestView({ className, headingLevel, claims, held, unread, earning = [], run, reading, label, disabled, asks, onPress, onReread }: {
  className: string;
  headingLevel: 2 | 3;
  /** Ready to claim, in run order. */
  claims: readonly HarvestClaim[];
  held: readonly HarvestHeld[];
  unread: readonly HarvestUnread[];
  /** What the stake behind the claims earns a day, per pool whose reader could state it. */
  earning?: readonly HarvestEarning[];
  /** The harvest on screen: its claims and what each has come to. Null before a press. */
  run: { rows: RunRow[]; done: boolean } | null;
  reading: boolean;
  /** The button's words, and whether it can be pressed. */
  label: string;
  disabled: boolean;
  /** How many times the wallet will ask. */
  asks: number;
  onPress: () => void;
  onReread: () => void;
}) {
  // The claim pointed at, in the ledger or on the figure: each lights it on the other.
  const [hot, setHot] = useState<string | null>(null);
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const running = run !== null && !run.done;
  // The figure's plates: the run's claims once there is a run, else what is ready to claim.
  const plates: StackPlate[] = (run ? run.rows.map((r) => ({ claim: r.claim, state: r.state.kind })) : claims.map((claim) => ({ claim, state: null })))
    .map(({ claim, state }) => ({ key: claim.key, chain: claim.chain, accent: accentOf(claim.roomId), state }));
  // Nothing to list (the pools are being read, or there is nothing to claim): the figure takes the
  // ledger's place, so the instrument is a short band instead of a tall one with an empty half.
  const bare = run === null && claims.length === 0 && held.length === 0 && unread.length === 0;
  // The totals bar: the run's claims once there is a run, else what is ready to claim.
  const tally = harvestTally(run ? run.rows.map((r) => r.claim) : claims, earning);
  const figure = (
    <HarvestStack plates={plates} reading={reading && run === null} active={hot} onActive={setHot}
      className={bare ? 'max-h-[8.5rem] @3xl:max-h-[11rem]' : 'max-h-[12rem] @3xl:max-h-[18rem]'} />
  );
  // How much of the run has come to an answer, for the line along the button's foot.
  const settled = run ? run.rows.filter((r) => r.state.kind !== 'waiting' && r.state.kind !== 'sending').length / Math.max(1, run.rows.length) : 0;

  return (
    <section aria-labelledby="harvest-heading" className={className}>
      {/* The editorial look (lib/editorial.ts), as an instrument (owner, 2026-11-14: "next gen esp
          the harvest"): the word, the claims drawn as plates (HarvestStack.tsx), and the ledger.
          It is a size container, so it sets itself out by the room its page gives it: the figure
          beside the ledger from 48rem, above it under that. */}
      <div
        className="relative isolate @container border border-[#22c55e]/45 px-4 py-5 md:px-6 md:py-6"
        style={{ background: EDITORIAL_BG, color: EDITORIAL_INK, textShadow: 'none' }}
      >
        <CardArt pageId="earn" idx={2} scrim="rgba(5,8,15,0.86)" />
        <div aria-hidden="true" className="absolute inset-0 -z-10 pointer-events-none opacity-[0.08] mix-blend-screen" style={{ backgroundImage: EDITORIAL_GRAIN }} />

        <div className="grid gap-x-8 gap-y-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @3xl:grid-rows-[auto_1fr] @3xl:[grid-template-areas:'intro_ledger'_'act_ledger']">
          <div className="min-w-0 @3xl:[grid-area:intro]">
            <Heading id="harvest-heading" className="m-0 font-black leading-[0.86] tracking-[-0.055em] text-[clamp(2.75rem,15cqw,5.5rem)]" style={{ ...HEADING_FONT, textShadow: 'none' }}>
              Har<span style={EDITORIAL_OUTLINE}>vest</span>
            </Heading>
            <p className="mt-3 mb-0 text-[14px] leading-snug text-[#f5e4b8]/85">Claim every pool&rsquo;s rewards at once.</p>
            {/* How money moves, in view (owner, 2026-10-09). */}
            <p className="mt-1 mb-0 text-[12px] leading-relaxed text-[#f5e4b8]/60">
              Each pool pays you from its own reward vault. The venue takes nothing; you pay the network fees.
            </p>
            {!bare && <div className="mt-4 @3xl:mt-6">{figure}</div>}
          </div>

          <div className="min-w-0 @3xl:[grid-area:ledger]">
            {tally.length > 0 && (
              <div className="mb-4 space-y-4" data-testid="harvest-tally">
                {tally.map((coin) => <TallyBar key={coin.key} coin={coin} />)}
              </div>
            )}
            {bare && figure}
            {run ? (
              <ul className={LEDGER} aria-label="This harvest">
                {run.rows.map((r, i) => <ClaimRow key={r.claim.key} n={i + 1} claim={r.claim} state={r.state} hot={hot === r.claim.key} onHot={setHot} />)}
              </ul>
            ) : (
              <>
                {claims.length > 0 && (
                  <ul className={LEDGER} aria-label="Ready to claim">
                    {claims.map((c, i) => <ClaimRow key={c.key} n={i + 1} claim={c} state={null} hot={hot === c.key} onHot={setHot} />)}
                  </ul>
                )}
                {held.length > 0 && (
                  <ul className={`${LEDGER} ${claims.length > 0 ? 'mt-3' : ''}`} aria-label="Left alone">
                    {held.map((h) => <HeldRow key={h.key} held={h} />)}
                  </ul>
                )}
                {unread.length > 0 && (
                  <ul className="list-none p-0 mt-3 mb-0 space-y-1.5" aria-label="Not read">
                    {unread.map((u) => (
                      <li key={u.key} className="text-[12px] leading-relaxed" style={{ color: '#f0b26b' }}>
                        Could not read {u.what} ({u.detail.replace(/\.$/, '')}). Not a zero.{' '}
                        <button type="button" onClick={onReread} className="min-h-[24px] underline underline-offset-2 hover:text-white">Try again</button>
                      </li>
                    ))}
                  </ul>
                )}
                {!reading && claims.length === 0 && held.length === 0 && unread.length === 0 && (
                  <p className="mt-3 mb-0 @3xl:text-center font-mono text-[11px] uppercase tracking-[0.14em] text-[#f5e4b8]/60">Nothing to claim right now.</p>
                )}
              </>
            )}

          </div>

          {/* The press comes after the ledger where they stack, and stands under the figure where they sit side by side. */}
          <div className="min-w-0 @3xl:[grid-area:act] @3xl:self-start">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
              <button type="button" onClick={onPress} disabled={disabled} className={CTA}>
                <span className="min-w-0">{label}</span>
                <span aria-hidden="true" className="flex h-10 w-10 flex-shrink-0 items-center justify-center bg-[#05080f] text-[#22c55e] transition-colors group-disabled/cta:bg-transparent group-disabled/cta:text-[#f5e4b8]/40 group-disabled/cta:border group-disabled/cta:border-white/15">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="transition-transform duration-300 group-enabled/cta:group-hover/cta:translate-y-0.5">
                    <path d="M12 4v15M6 13l6 6 6-6" />
                  </svg>
                </span>
                {running && (
                  <span aria-hidden="true" className="absolute left-0 bottom-0 h-[3px] w-full origin-left bg-[#22c55e] transition-transform duration-500 ease-out" style={{ transform: `scaleX(${settled})` }} />
                )}
              </button>
              {run?.done ? (
                <span className={CTA_NOTE} role="status">Done: {runSummary(run.rows.map((r) => r.state))}.</span>
              ) : claims.length > 1 && !running ? (
                <span className={CTA_NOTE}>{asks === 1 ? 'Your wallet asks once.' : `Your wallet asks ${asks} times.`}</span>
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
                claims into one transaction: then they are paid or refused together. If you cancel in your wallet,
                Harvest stops and sends nothing more. A claim whose outcome could not be read also stops it, so you can
                check before anything is sent twice.
              </p>
              <p>
                The drawing is the claims as plates, one stack per network, every plate the same size whatever it
                pays. A plate stays afloat until its claim is paid, then turns green and comes down on the pad. One
                left afloat was refused, not confirmed, cancelled or not sent, as its row says.
              </p>
              <p>
                The bar over the list adds one coin&rsquo;s claims together; two coins are never added, because no
                price is read here. For a lock ladder on Solana it also says what your locks earn a day and that as
                a yearly rate on what you locked: your weight (each lock times its boost) over all stakers&rsquo;
                weight, times what the pool pays a day. Those two are the same figures as on the pool&rsquo;s own
                page. They hold only at today&rsquo;s rate: they fall when others lock, rise when they leave, and
                stop on the date shown unless the pool is refilled. Where they cannot be worked out they are left
                out, never shown as a zero.
              </p>
            </FinePrint>
          </div>
        </div>
      </div>
    </section>
  );
}

const LEDGER = 'list-none p-0 m-0 border-t border-white/25';

const dateOf = (secs: number) =>
  new Date(secs * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** One figure of the bar: the number in heavy type over its unit, as a drawing letters a measure. */
function Figure({ value, unit, tone = 'ink', size = 'md' }: { value: string; unit: string; tone?: 'ink' | 'green'; size?: 'lg' | 'md' }) {
  return (
    <span className="flex flex-col min-w-0">
      <span
        className={`font-black leading-none tracking-[-0.045em] tabular-nums [overflow-wrap:anywhere] ${size === 'lg' ? 'text-[34px] @md:text-[40px]' : 'text-[24px] @md:text-[28px]'} ${tone === 'green' ? 'text-[#22c55e]' : ''}`}
        style={HEADING_FONT}
      >
        {value}
      </span>
      <span className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#f5e4b8]/65">{unit}</span>
    </span>
  );
}

/**
 * The totals bar for one coin (owner, 2026-11-14: "the bar that adds them all together plus
 * shows % and daily yield"; lib/harvest/tally.ts has the rule). Set out as an overall dimension:
 * the line across the top spans what the figures under it add up, and names it.
 *
 *  - The total is this coin's claims added up, by the same formatter the rows use.
 *  - A day and APR are the pool reader's own figures (HarvestEarning), in the pool page's words.
 *    They are a projection, so their basis stands on the line under them, as it does there;
 *    with no figure stated there is no line, never a zero or a dash.
 */
function TallyBar({ coin }: { coin: TallyCoin }) {
  const span = coin.claims > 0 ? `${coin.symbol} · ${coin.claims} ${coin.claims === 1 ? 'claim' : 'claims'}` : coin.symbol;
  return (
    <div role="group" aria-label={`${coin.symbol} total`} className="min-w-0">
      <p className="m-0 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#f5e4b8]/70">
        <span aria-hidden="true" className="h-2.5 w-px bg-[#f5e4b8]/60" />
        <span aria-hidden="true" className="h-px w-4 bg-[#f5e4b8]/40" />
        <span className="whitespace-nowrap">{span}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-[#f5e4b8]/40" />
        <span aria-hidden="true" className="h-2.5 w-px bg-[#f5e4b8]/60" />
      </p>
      {coin.totalRaw !== null && coin.earning.length <= 1 ? (
        <div className="mt-2.5 flex flex-wrap items-end gap-x-7 gap-y-3">
          <Figure size="lg" value={fmtAmount(coin.totalRaw, coin.decimals)} unit={`${coin.symbol} total`} />
          {coin.earning.map((e) => <Rate key={e.key} e={e} />)}
        </div>
      ) : (
        <>
          {coin.totalRaw !== null && (
            <div className="mt-2.5"><Figure size="lg" value={fmtAmount(coin.totalRaw, coin.decimals)} unit={`${coin.symbol} total`} /></div>
          )}
          {coin.earning.map((e) => (
            <div key={e.key} className="mt-2.5 flex flex-wrap items-end gap-x-7 gap-y-3"><Rate e={e} named={coin.earning.length > 1} /></div>
          ))}
        </>
      )}
      {coin.earning.map((e) => (
        <p key={e.key} className="mt-2 mb-0 font-mono text-[10px] uppercase tracking-[0.12em] leading-snug text-[#f5e4b8]/60">
          {coin.earning.length > 1 ? `${e.where}: ` : ''}at today&rsquo;s rate, funded to {dateOf(e.fundedToSecs)}
        </p>
      ))}
    </div>
  );
}

/** What one pool's stake earns a day, and that as a yearly rate: the two figures of its own page. */
function Rate({ e, named = false }: { e: HarvestEarning; named?: boolean }) {
  return (
    <>
      <Figure tone="green" value={fmtDaily(e.perDayRaw, e.decimals)} unit={`${e.symbol} a day${named ? ` · ${e.where}` : ''}`} />
      <Figure tone="green" value={e.apr} unit="APR" />
    </>
  );
}

// The button: a green slab that lifts off the sheet when pointed at, with the cream under it, and
// sets back down when pressed. Waiting or with nothing to send it is an outline. Colours that
// change by state are classes, never inline style: an inline colour would beat them.
const CTA =
  'group/cta relative inline-flex w-full @md:w-auto @md:min-w-[19rem] min-h-[56px] items-center justify-between gap-4 overflow-hidden pl-5 pr-2 py-2 text-left '
  + 'border border-[#22c55e] bg-[#22c55e] text-[#05080f] font-black uppercase leading-tight tracking-[-0.01em] text-[15px] '
  + 'transition-[transform,box-shadow,background-color,color,border-color] duration-200 ease-out '
  + 'enabled:hover:-translate-x-[3px] enabled:hover:-translate-y-[3px] enabled:hover:shadow-[3px_3px_0_0_#f5e4b8] '
  + 'enabled:active:translate-x-0 enabled:active:translate-y-0 enabled:active:shadow-none '
  + 'disabled:cursor-not-allowed disabled:border-white/20 disabled:bg-transparent disabled:text-[#f5e4b8]/60 '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5e4b8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#05080f]';

const CTA_NOTE = 'font-mono text-[11px] uppercase tracking-[0.12em] text-[#f5e4b8]/70';

/** The room's colour, for a claim's plate and its row's edge; the venue's green for a room the registry does not hold. */
function accentOf(roomId: string): string {
  return BUNGALOWS.find((b) => b.id === roomId)?.accent ?? EDITORIAL_GREEN;
}

function amountText(raw: bigint | null, decimals: number, symbol: string) {
  return raw === null ? symbol : `${fmtAmount(raw, decimals)} ${symbol}`;
}

const STATE_WORDS: Record<ClaimState['kind'], { text: string; color: string }> = {
  waiting: { text: 'Waiting', color: 'rgba(245,228,184,0.55)' },
  sending: { text: 'At your wallet…', color: '#e3b341' },
  claimed: { text: 'Claimed', color: EDITORIAL_GREEN },
  reverted: { text: 'Refused on chain', color: '#f08a6b' },
  unconfirmed: { text: 'Not confirmed', color: '#f0b26b' },
  declined: { text: 'Cancelled', color: 'rgba(245,228,184,0.55)' },
  'not-sent': { text: 'Not sent', color: 'rgba(245,228,184,0.55)' },
};

/** A row's number, drawn by CSS from `data-n`: a mark, not a word, and no part of the row's text. */
function RowNumber({ n }: { n: number }) {
  return (
    <span aria-hidden="true" data-n={pad2(n)}
      className="self-start pt-[5px] font-mono text-[10px] tracking-[0.12em] tabular-nums text-[#f5e4b8]/45 before:content-[attr(data-n)]" />
  );
}

function ClaimRow({ n, claim, state, hot, onHot }: { n: number; claim: HarvestClaim; state: ClaimState | null; hot: boolean; onHot: (key: string | null) => void }) {
  const words = state ? STATE_WORDS[state.kind] : null;
  const tx = state && 'tx' in state ? state.tx : undefined;
  const note = state && 'reason' in state ? state.reason : claim.caution;
  const paid = state?.kind === 'claimed';
  return (
    <li
      onMouseEnter={() => onHot(claim.key)}
      onMouseLeave={() => onHot(null)}
      className="relative grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2 py-2.5 pl-3 border-b border-white/[0.10]"
    >
      {/* The room's colour up the row's edge, as its plate carries it; whole while the row is pointed at. */}
      <span aria-hidden="true" className="absolute left-0 top-0 bottom-0 w-[3px] origin-bottom transition-transform duration-300 ease-out"
        style={{ background: paid ? EDITORIAL_GREEN : accentOf(claim.roomId), transform: hot || paid ? 'scaleY(1)' : 'scaleY(0.38)' }} />
      <RowNumber n={n} />
      <span className="min-w-0">
        <span className="block font-black leading-none tracking-[-0.035em] text-[22px] @md:text-[26px] tabular-nums [overflow-wrap:anywhere] transition-colors duration-500"
          style={{ ...HEADING_FONT, color: paid ? EDITORIAL_GREEN : undefined }}>
          {amountText(claim.amountRaw, claim.decimals, claim.symbol)}
        </span>
        <span className="mt-1.5 block font-mono text-[10.5px] uppercase tracking-[0.1em] leading-snug text-[#f5e4b8]/60">
          {claim.where} · {HARVEST_CHAIN_LABEL[claim.chain]}{claim.detail ? ` · ${claim.detail}` : ''}
        </span>
      </span>
      {words && (
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] whitespace-nowrap" style={{ color: words.color }}>
          {tx ? (
            <a href={txUrl(claim, tx)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4"
              aria-label={`${words.text}: view the transaction (opens in new tab)`}>
              {words.text} ↗
            </a>
          ) : words.text}
        </span>
      )}
      {note && <p className="col-start-2 col-span-2 text-[12px] leading-relaxed mt-1.5 mb-0" style={{ color: '#f0b26b' }}>{note}</p>}
    </li>
  );
}

function HeldRow({ held }: { held: HarvestHeld }) {
  return (
    <li className="relative grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2 py-2.5 pl-3 border-b border-white/[0.10]">
      {/* Left in the ground: a dashed edge, where a claim's is whole. */}
      <span aria-hidden="true" className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ backgroundImage: 'repeating-linear-gradient(to bottom, rgba(245,228,184,0.45) 0 4px, transparent 4px 8px)' }} />
      <span aria-hidden="true" />
      <span className="min-w-0">
        <span className="block font-black leading-none tracking-[-0.035em] text-[18px] @md:text-[20px] tabular-nums text-[#f5e4b8]/75 [overflow-wrap:anywhere]" style={HEADING_FONT}>
          {amountText(held.amountRaw, held.decimals, held.symbol)}
        </span>
        <span className="mt-1.5 block font-mono text-[10.5px] uppercase tracking-[0.1em] leading-snug text-[#f5e4b8]/60">{held.where} · {HARVEST_CHAIN_LABEL[held.chain]}</span>
      </span>
      <Link to={`/earn/${held.roomId}`} aria-label={`The ${held.symbol} pool's page`}
        className="inline-flex min-h-[24px] items-center font-mono text-[11px] uppercase tracking-[0.12em] underline underline-offset-4 text-[#f5e4b8]/80 hover:text-[#22c55e]">
        Its page
      </Link>
      <p className="col-start-2 col-span-2 text-[#f5e4b8]/65 text-[12px] leading-relaxed mt-1.5 mb-0">{held.reason}</p>
    </li>
  );
}
