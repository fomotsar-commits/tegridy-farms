import { Fragment, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { BUNGALOWS } from '../../lib/bungalows';
import { EDITORIAL_BG, EDITORIAL_GRAIN, EDITORIAL_GREEN, EDITORIAL_INK, EDITORIAL_OUTLINE, HEADING_FONT, mixHex, pad2 } from '../../lib/editorial';
import { getTxUrl } from '../../lib/explorer';
import { muralOf } from '../../lib/isoMural';
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
import { HarvestGranary, type GranaryStorey } from './HarvestGranary';

/** A claim as the run snapshot keeps it: what was sent, and what it came to. */
export type RunRow = { claim: HarvestClaim; state: ClaimState };

/** A claim this harvest sends, and where it stands: null before a press. */
type Sent = { claim: HarvestClaim; state: ClaimState | null };

const txUrl = (claim: HarvestClaim, tx: string) =>
  claim.chain === 'solana' ? `https://solscan.io/tx/${tx}` : getTxUrl(EVM_CHAIN_IDS[claim.chain], tx);

/**
 * Harvest as it is drawn, from what HarvestCard.tsx read and ran: no wallet, chain or timer here, so
 * every state (reading, ready, mid-run, done, nothing to claim, not read) draws from plain values.
 * One DOM order: heading and money line, drawing, totals, button, list, How it works. index.css sets
 * it out by the card's width (the `hv` rules): on a wide card with one or two rows those rows stand
 * under the money line and the button under them; everywhere else the button comes before the list.
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
  // A harvest put away by Check again is drawn afresh, so its kit explodes again; never during a run.
  const [figure, setFigure] = useState({ ran: run !== null, round: 0 });
  if (figure.ran !== (run !== null)) setFigure({ ran: run !== null, round: figure.round + (figure.ran ? 1 : 0) });
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const running = run !== null && !run.done;
  // What this harvest sends, in run order: the run's rows once there is a run, else what is ready to claim.
  const sent: readonly Sent[] = run ? run.rows : claims.map((claim) => ({ claim, state: null }));
  const storeys: GranaryStorey[] = sent.map(({ claim, state }, i) => ({
    key: claim.key, n: i + 1, chain: claim.chain, roomId: claim.roomId, symbol: claim.symbol,
    accent: accentOf(claim.roomId), caution: claim.caution !== null, state: state?.kind ?? null,
  }));
  const tally = harvestTally(sent.map((s) => s.claim), earning);
  // Pressing it harvests: the arrow key marks that press alone, never Check again or a disabled button.
  const harvests = !disabled && run === null && claims.length > 0;
  // Nothing to list (the pools are being read, or there is nothing to claim): the figure stays a short band.
  const bare = run === null && claims.length === 0 && held.length === 0 && unread.length === 0;
  const nothing = bare && !reading;
  // No claim and a pool not read: nothing is drawn at all, so nothing reads as a zero or as nothing to claim.
  const undrawn = storeys.length === 0 && !reading && unread.length > 0;
  // One or two rows and no totals bar: on a wide card they stand in the band, under the money line.
  const short = !bare && tally.length === 0 && sent.length + held.length + unread.length <= 2;

  return (
    <section aria-labelledby="harvest-heading" className={className}>
      <div
        className="relative isolate @container/harvest border border-[#22c55e]/45 px-4 py-5 md:px-6 md:py-6"
        style={{ background: EDITORIAL_BG, color: EDITORIAL_INK, textShadow: 'none' }}
      >
        <CardArt pageId="earn" idx={2} scrim="rgba(5,8,15,0.86)" />
        <div aria-hidden="true" className="absolute inset-0 -z-10 pointer-events-none opacity-[0.08] mix-blend-screen" style={{ backgroundImage: EDITORIAL_GRAIN }} />
        <SheetFrame />

        <div className="hv" data-short={short ? '' : undefined} data-bare={bare ? '' : undefined} data-quiet={headingLevel === 3 ? '' : undefined}
          data-undrawn={undrawn ? '' : undefined}>
          <div className="hv-head">
            <Heading id="harvest-heading" className="m-0 font-black leading-[0.86] tracking-[-0.055em] text-[clamp(2.75rem,15cqw,5.5rem)]" style={{ ...HEADING_FONT, textShadow: 'none' }}>
              Har<span style={EDITORIAL_OUTLINE}>vest</span>
            </Heading>
            {/* How money moves, in view: the card's one line of prose. */}
            <p className="hv-money">Each pool pays you from its own reward vault. The venue takes nothing; you pay the network fees.</p>
          </div>

          {/* With no storey to build (reading, nothing to claim) the drawing is kept small. */}
          {!undrawn && (
            <div className="hv-fig" data-empty={storeys.length === 0 ? '' : undefined}>
              {/* The model turns as this element's transform, never the svg's own (index.css). */}
              <div className="hv-turn">
                <HarvestGranary key={figure.round} storeys={storeys} reading={reading && run === null} active={hot} onActive={setHot} />
              </div>
              {storeys.length > 0 && <ViewTitle />}
            </div>
          )}

          {tally.length > 0 && (
            <div className="hv-tally" data-testid="harvest-tally">
              {tally.map((coin) => (
                <TallyBar key={coin.key} coin={coin} segs={segmentsOf(coin, sent)} paid={run?.done ? paidOf(coin, sent) : null}
                  atMost={mayPayLess(coin, sent, run?.done === true)} hot={hot} />
              ))}
            </div>
          )}

          <div className="hv-act">
            <div className="hv-actrow">
              <button type="button" onClick={onPress} disabled={disabled} className="hv-cta">
                <span className="min-w-0">{label}</span>
                {harvests && (
                  <span aria-hidden="true" className="hv-key">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <path d="M12 4v15M6 13l6 6 6-6" />
                    </svg>
                  </span>
                )}
                {/* While it runs: a course of bricks along its foot, one per claim, every brick the same size. */}
                {run && !run.done && (
                  <span aria-hidden="true" className="hv-course">
                    {run.rows.map((r) => <i key={r.claim.key} data-s={r.state.kind} />)}
                  </span>
                )}
              </button>
              {run?.done ? (
                <span className="hv-cta-note" role="status">Done: {runSummary(run.rows.map((r) => r.state))}.</span>
              ) : claims.length > 1 && !running ? (
                <span className="hv-cta-note">{asks === 1 ? 'Your wallet asks once.' : `Your wallet asks ${asks} times.`}</span>
              ) : null}
              {/* By the button, so "Harvest all" and "Done" never read as every pool: the list says which. */}
              {unread.length > 0 && <span className="hv-cta-note hv-cta-gap">Not every pool was read.</span>}
            </div>
          </div>

          {(!bare || nothing) && (
            <div className="hv-list @container/ledger">
              {run ? (
                <ul className="hv-ledger" aria-label="This harvest">
                  {run.rows.map((r, i) => <ClaimRow key={r.claim.key} n={i + 1} claim={r.claim} state={r.state} hot={hot === r.claim.key} onHot={setHot} />)}
                </ul>
              ) : claims.length > 0 && (
                <ul className="hv-ledger" aria-label="Ready to claim">
                  {claims.map((c, i) => <ClaimRow key={c.key} n={i + 1} claim={c} state={null} hot={hot === c.key} onHot={setHot} />)}
                </ul>
              )}
              {/* Listed before, during and after a run, so the list never says less than it did before the press. */}
              {held.length > 0 && (
                <ul className="hv-ledger" aria-label="Left alone">
                  {held.map((h) => <HeldRow key={h.key} held={h} live={running} />)}
                </ul>
              )}
              {unread.length > 0 && (
                <ul className="hv-unread" aria-label="Not read">
                  {notReadLines(unread).map((l) => (
                    <li key={l.key}>
                      Could not read {listed(l.whats)} ({l.detail.replace(/\.$/, '')}).{/not a zero/i.test(l.detail) ? '' : ' Not a zero.'}{' '}
                      <button type="button" onClick={onReread}>Try again</button>
                    </li>
                  ))}
                </ul>
              )}
              {nothing && <p className="hv-nothing">Nothing to claim right now.</p>}
            </div>
          )}

          <div className="hv-fine">
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
                The drawing is this harvest as a street: one building for each room with something to claim, its
                ticker on its footing, in the order the claims are sent, and each network&rsquo;s name on the ground
                where its buildings begin. Each claim is one storey in its room&rsquo;s colours, with its row&rsquo;s
                number. A caution mark on its front is its row&rsquo;s caution: it may pay less than shown, or nothing.
                A room&rsquo;s storeys stand in stacks of up to four, side by side on its footing, in the order the
                claims are sent. Every storey is the same size whatever it pays, so more storeys means more claims,
                never more money. From its building each claim has one lane to the glass building marked YOUR WALLET;
                every lane is the same width, and no lane goes anywhere else. Before you press, the storeys hang above
                their footing in the order they will be sent, and the lanes are empty. The one at your wallet lifts
                clear, ringed in amber, and its lane turns amber. A storey comes down onto its stack, its windows
                light, its lane turns green and one plate is set down in your wallet, only once its claim is paid;
                every plate is the same size. One drawn in dashes was refused, not confirmed, cancelled or not sent, as
                its row says: it is never part of the building, and nothing of it enters your wallet. Once every claim
                on a network was paid, refused or cancelled, a roof goes on each of its stacks that holds a paid
                storey, and a flag goes up; over a stack where none was paid the roof stays hung, in dashes. Until
                then every roof stays hung. A pool that could not be read, or a reward left alone, is not drawn; its
                row stays in the list.
              </p>
              <p>
                The totals bar adds one coin&rsquo;s claims together; two coins are never added, because no price is
                read here. The line above its total is divided between that coin&rsquo;s claims to scale, the one place
                an amount is drawn to size, which is fair because they are the same coin; it fills green as each claim
                goes through, in stripes where its row has a caution. After a run the total counts only the claims that
                went through. For a lock ladder on Solana the bar also says what your locks earn a day and that as a
                yearly rate on what you locked: your weight (each lock times its boost) over all stakers&rsquo; weight,
                times what the pool pays a day. Those two are the same figures as on the pool&rsquo;s own page. They hold
                only at today&rsquo;s rate: they fall when others lock, rise when they leave, and stop on the date
                shown unless the pool is refilled. Where they cannot be worked out they are left out, never shown as
                a zero.
              </p>
            </FinePrint>
          </div>
        </div>
      </div>
    </section>
  );
}

const pct = (f: number) => `${Math.round(f * 100000) / 1000}%`;

/**
 * The sheet's frame: a hairline inside the card's edge, its zones numbered 1 to 6 across and lettered
 * A to D down, with ticks at the zone lines. Marks drawn by CSS from data-z, no part of the card's
 * words; index.css shows it only on a card 35rem wide and up.
 */
function SheetFrame() {
  return (
    <span aria-hidden="true" className="hv-frame" data-frame="">
      {[1, 2, 3, 4, 5, 6].map((z) => (
        <Fragment key={z}>
          <i className="zt" data-z={z} style={{ left: pct((z - 0.5) / 6) }} />
          <i className="zb" data-z={z} style={{ left: pct((z - 0.5) / 6) }} />
        </Fragment>
      ))}
      {['A', 'B', 'C', 'D'].map((z, i) => (
        <Fragment key={z}>
          <i className="zl" data-z={z} style={{ top: pct((i + 0.5) / 4) }} />
          <i className="zr" data-z={z} style={{ top: pct((i + 0.5) / 4) }} />
        </Fragment>
      ))}
      {[1, 2, 3, 4, 5].map((z) => (
        <Fragment key={z}>
          <i className="zs" style={{ left: pct(z / 6) }} />
          <i className="zs b" style={{ left: pct(z / 6) }} />
        </Fragment>
      ))}
    </span>
  );
}

/** Under the drawing, its title and its key: a detail bubble (marks drawn from data-a and data-b), a rule, and what one storey stands for. */
function ViewTitle() {
  return (
    <p aria-hidden="true" className="hv-vt" data-view-title="">
      <span className="hv-vt-bub" data-a="1" data-b="H-01" />
      <span className="hv-vt-rule" />
      <span className="hv-vt-key">1 storey = 1 claim</span>
    </p>
  );
}

/** Pools not read for one reason, as one line: each pool's words in the order read, and the reason once. */
function notReadLines(unread: readonly HarvestUnread[]): { key: string; whats: string[]; detail: string }[] {
  const out: { key: string; whats: string[]; detail: string }[] = [];
  for (const u of unread) {
    const line = out.find((l) => l.detail === u.detail);
    if (line) line.whats.push(u.what);
    else out.push({ key: u.key, whats: [u.what], detail: u.detail });
  }
  return out;
}

/** Names as a list: "a", "a and b", "a, b and c". */
const listed = (names: readonly string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** A no-break space: "on" keeps to its figure, and a middle dot to the word before it, so no line starts with a dot. */
const NBSP = String.fromCharCode(0xa0);

const dateOf = (secs: number) =>
  new Date(secs * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** One figure of the bar: the number in heavy type over its unit, as a drawing letters a measure. */
function Figure({ value, unit, tone = 'ink', size = 'md' }: { value: string; unit: string; tone?: 'ink' | 'green'; size?: 'lg' | 'md' }) {
  return (
    <span className="flex flex-col min-w-0">
      <span className={`hv-v${size === 'lg' ? ' hv-lg' : ''}${tone === 'green' ? ' hv-g' : ''}`}>{value}</span>
      <span className="hv-u">{unit}</span>
    </span>
  );
}

/** One claim on the bar's line: its row's number, where it stands, its share of its coin's total in ten-thousandths, its caution. */
type Seg = { key: string; n: number; share: number; state: ClaimState['kind'] | 'ready'; caution: boolean };

const sameCoin = (claim: HarvestClaim, coin: TallyCoin) =>
  claim.chain === coin.chain && claim.roomId === coin.roomId && claim.symbol === coin.symbol && claim.decimals === coin.decimals;

/** The line of one coin's total, divided between that coin's claims in run order, each by its raw amount. */
function segmentsOf(coin: TallyCoin, sent: readonly Sent[]): Seg[] {
  const total = coin.totalRaw;
  if (total === null || total <= 0n) return [];
  return sent.flatMap(({ claim, state }, i) => (sameCoin(claim, coin)
    ? [{ key: claim.key, n: i + 1, share: Number((claim.amountRaw * 10_000n) / total), state: state?.kind ?? 'ready', caution: claim.caution !== null }]
    : []));
}

/** After a run, one coin's claims that came to Claimed: how many, and their sum. */
function paidOf(coin: TallyCoin, sent: readonly Sent[]): { raw: bigint; count: number } {
  const paid = sent.filter((s) => sameCoin(s.claim, coin) && s.state?.kind === 'claimed');
  return { raw: paid.reduce((sum, s) => sum + s.claim.amountRaw, 0n), count: paid.length };
}

/** A claim the coin's big figure counts (every one, or after a run those that came to Claimed) carries a caution: it may pay less. */
const mayPayLess = (coin: TallyCoin, sent: readonly Sent[], done: boolean) =>
  sent.some((s) => sameCoin(s.claim, coin) && (!done || s.state?.kind === 'claimed') && s.claim.caution !== null);

/**
 * The totals bar for one coin (lib/harvest/tally.ts has the rule): a line divided between the coin's
 * claims to scale, the one amount drawn to size (fair: every part is the same coin), its numbers CSS
 * marks from data-n; the total, or after a run what came to Claimed, "at most" where a claim it counts
 * may pay less; then the pool reader's own day and APR figures (HarvestEarning), a projection, so their
 * pool, stake and date stand under them. With no figure stated there is no line, never a zero or a dash.
 */
function TallyBar({ coin, segs, paid, atMost, hot }: {
  coin: TallyCoin;
  segs: readonly Seg[];
  paid: { raw: bigint; count: number } | null;
  atMost: boolean;
  hot: string | null;
}) {
  const n = coin.claims;
  const span = n === 0 ? coin.symbol
    : paid && paid.count < n ? `${coin.symbol} · ${paid.count} of ${n} claimed`
      : `${coin.symbol} · ${n} ${n === 1 ? 'claim' : 'claims'}`;
  const total = coin.totalRaw === null ? null
    : <Figure size="lg" value={fmtPayout(paid ? paid.raw : coin.totalRaw, coin.decimals)} unit={`${coin.symbol} ${paid ? 'claimed' : 'total'}${atMost ? ', at most' : ''}`} />;
  return (
    <div role="group" aria-label={`${coin.symbol} total`} className="min-w-0">
      <p className="hv-cap">{span}</p>
      {segs.length > 0 && (
        <div aria-hidden="true" className="hv-dims">
          {segs.map((s) => (
            <span key={s.key} className="hv-seg" style={{ flexGrow: s.share / 10_000 }} data-seg={s.key} data-s={s.state}
              data-caution={s.caution ? '' : undefined} data-hot={s.key === hot ? '' : undefined}>
              <i />
              <b />
              {s.share > 450 && <em data-n={pad2(s.n)} />}
            </span>
          ))}
        </div>
      )}
      {total && coin.earning.length <= 1 ? (
        <div className="hv-figs">
          {total}
          {coin.earning.map((e) => <Rate key={e.key} e={e} />)}
        </div>
      ) : (
        <>
          {total && <div className="hv-figs">{total}</div>}
          {coin.earning.map((e) => (
            <div key={e.key} className="hv-figs"><Rate e={e} named={coin.earning.length > 1} /></div>
          ))}
        </>
      )}
      {coin.earning.map((e) => (
        <p key={e.key} className="hv-basis">
          {e.where} · on{NBSP}{fmtAmount(e.principalRaw, e.decimals)} {e.symbol} · <span>at today&rsquo;s rate, funded to {dateOf(e.fundedToSecs)}</span>
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

/** The room's colour, for a claim's storey and its row's edge; the venue's green for a room the registry does not hold. */
function accentOf(roomId: string): string {
  return BUNGALOWS.find((b) => b.id === roomId)?.accent ?? EDITORIAL_GREEN;
}

const GROUPED = new Intl.NumberFormat('en-US');

/**
 * An amount a claim pays, in whole coins: up to two decimals from one coin up, three significant
 * digits below it, CUT, never rounded, so the card never promises more than a claim pays (fmtAmount
 * rounds half up, and prints whole coins from 1,000). Worked on the raw integer, so no float drifts.
 */
function fmtPayout(raw: bigint, decimals: number): string {
  if (raw <= 0n) return fmtAmount(raw, decimals);
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = BigInt(decimals > 0 ? s.slice(0, -decimals) : s);
  const digits = decimals > 0 ? s.slice(-decimals) : '';
  const keep = whole > 0n ? 2 : digits.search(/[1-9]/) + 3;
  const frac = digits.slice(0, keep).replace(/0+$/, '');
  return frac ? `${GROUPED.format(whole)}.${frac}` : GROUPED.format(whole);
}

function amountText(raw: bigint | null, decimals: number, symbol: string) {
  return raw === null ? symbol : `${fmtPayout(raw, decimals)} ${symbol}`;
}

const STATE_WORDS: Record<ClaimState['kind'], { text: string; color: string }> = {
  waiting: { text: 'Waiting', color: 'rgba(245,228,184,0.55)' },
  sending: { text: 'Check your wallet…', color: '#e3b341' },
  claimed: { text: 'Claimed', color: EDITORIAL_GREEN },
  reverted: { text: 'Refused on chain', color: '#f08a6b' },
  unconfirmed: { text: 'Not confirmed', color: '#f0b26b' },
  declined: { text: 'Cancelled', color: 'rgba(245,228,184,0.55)' },
  'not-sent': { text: 'Not sent', color: 'rgba(245,228,184,0.55)' },
};

/** The room's door card, the picture its storey wears, at the small copy and the room's own crop; brick in its colour where it has none. */
function DoorCard({ roomId }: { roomId: string }) {
  const door = muralOf(roomId, 128);
  return (
    <span aria-hidden="true" className="hv-door">
      {door
        ? <img src={door.src} alt="" loading="lazy" decoding="async" style={{ objectPosition: door.position }} />
        : <i style={{ background: mixHex(EDITORIAL_BG, accentOf(roomId), 0.42) }} />}
    </span>
  );
}

function ClaimRow({ n, claim, state, hot, onHot }: { n: number; claim: HarvestClaim; state: ClaimState | null; hot: boolean; onHot: (key: string | null) => void }) {
  const words = state ? STATE_WORDS[state.kind] : null;
  const tx = state && 'tx' in state ? state.tx : undefined;
  const note = state && 'reason' in state ? state.reason : claim.caution;
  const point = () => onHot(claim.key);
  const leave = () => onHot(null);
  return (
    <li className="hv-row" data-state={state?.kind ?? 'ready'} data-hot={hot ? '' : undefined} data-caution={claim.caution !== null ? '' : undefined}
      style={{ '--accent': accentOf(claim.roomId) } as CSSProperties} onMouseEnter={point} onMouseLeave={leave} onFocus={point} onBlur={leave}>
      {/* The room's colour up the row's edge, as its storey wears it: whole while pointed at, green once paid. */}
      <span aria-hidden="true" className="hv-edge" />
      {/* The plaque its storey carries: the row's number drawn by CSS from data-n, a mark and no part of the row's words. */}
      <span aria-hidden="true" className="hv-num" data-n={pad2(n)} />
      <DoorCard roomId={claim.roomId} />
      <span className="hv-amt">{amountText(claim.amountRaw, claim.decimals, claim.symbol)}</span>
      {/* "on" keeps to its figure, and each dot to the word before it, so a narrow row never breaks between them. */}
      <span className="hv-where">
        {claim.where}{NBSP}· {HARVEST_CHAIN_LABEL[claim.chain]}{claim.detail ? `${NBSP}· ${claim.detail.replace(/^on /, `on${NBSP}`)}` : ''}
      </span>
      {words && (
        <span className="hv-st" style={{ color: words.color }}>
          {tx ? (
            <a href={txUrl(claim, tx)} target="_blank" rel="noopener noreferrer" aria-label={`${words.text}: view the transaction (opens in new tab)`}>
              {words.text} ↗
            </a>
          ) : words.text}
        </span>
      )}
      {note && <p className="hv-note">{note}</p>}
    </li>
  );
}

function HeldRow({ held, live }: { held: HarvestHeld; live: boolean }) {
  return (
    <li className="hv-row" data-held="" style={{ '--accent': accentOf(held.roomId) } as CSSProperties}>
      {/* Left in the ground: a dashed edge and an empty plaque, where a claim's are whole, and its door card greyed. */}
      <span aria-hidden="true" className="hv-edge" />
      <span aria-hidden="true" className="hv-num" />
      <DoorCard roomId={held.roomId} />
      <span className="hv-amt">{amountText(held.amountRaw, held.decimals, held.symbol)}</span>
      <span className="hv-where">{held.where}{NBSP}· {HARVEST_CHAIN_LABEL[held.chain]}</span>
      {/* No link while a run goes on: leaving would take the card off screen with the wallet still asking. */}
      {live ? <span className="hv-st hv-page">Its page</span> : (
        <Link to={`/earn/${held.roomId}`} aria-label={`The ${held.symbol} pool's page`} className="hv-st hv-page">
          Its page
        </Link>
      )}
      <p className="hv-note">{held.reason}</p>
    </li>
  );
}
