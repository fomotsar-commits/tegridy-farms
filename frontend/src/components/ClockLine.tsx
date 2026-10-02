import { useState } from 'react';
import { peekHeat } from '../lib/heat/heatClient';
import { readLastBuy, markLastBuyPosted } from '../lib/heat/lastBuy';
import { SITE_URL } from '../lib/constants';

/**
 * WAVE SEVEN, element O: THE COMMITMENT LINE, THE MOMENT AFTER A BUY.
 *
 * A stranger who has just bought is handed one sentence about their own clock
 * and a door to post it. The island ruled the shape in answer three and the
 * words in answer eight: a latch rather than a toast, no timer, "Post" then
 * "Posted.", gone on the next submit or on leaving the room.
 *
 * THE BUY PATH GAINS NO NETWORK CALL, EVER. That is the ruling, and it decides
 * everything here: the warm branch may only speak from a reading the venue
 * ALREADY holds, so it peeks at heatClient's cache and never fetches.
 *
 * THREE FORMS, EACH TRUE ON ITS OWN EVIDENCE (answer nine, answer 3).
 *
 * Ruling 10's default was "started today" on anything but a warm reading.
 * That is a false public sentence for a two-year holder whose reading simply
 * is not cached - and on the five Solana rooms it is almost never cached,
 * because the room's card reads the connected EVM address and never the
 * Solana pubkey. Session nine answered that with silence, which the island
 * then overruled too: silence loses the commitment moment on most of O's
 * reach. So the line always speaks, and what it says depends on what the
 * venue actually knows:
 *
 *   cached reading, holding this token   -> "keeps running"
 *   cached reading, not holding it       -> "started today"
 *   no cached reading at all             -> "is running"
 *
 * The third makes no claim about when the clock started, which is the only
 * thing the venue cannot know without a read it is forbidden to make here.
 * The read link carries the real number in every case.
 */
export function ClockLine() {
  const [postedNow, setPostedNow] = useState(false);

  // Read at render rather than in state: the latch is written by the swap's own
  // success effect, which is not this tree, and a buy that lands after mount
  // must not need a second event to be seen. It is one storage read.
  const buy = readLastBuy();
  if (!buy) return null;

  const reading = peekHeat(buy.buyer);

  // The same row rule element D uses (HeatCard's ScopedReading): fold BOTH
  // sides. Folding both is match-safe even for a Solana mint, which is why it
  // differs from the registry finder, where a folded key would be compared
  // against an unfolded canon and quietly name the wrong room.
  const want = buy.tokenAddress.trim().toLowerCase();
  const held = reading
    ? reading.breakdown.some((r) => r.tokenAddress.trim().toLowerCase() === want)
    : false;

  const clock = !reading ? 'is running' : held ? 'keeps running' : 'started today';
  const sentence = `My clock on ${buy.symbol} ${clock}. Held time counts here.`;
  // The number itself lives behind the read link, which unfurls as this
  // buyer's own card (element M). Posting is the buyer's own click, and the
  // link is the only thing in the text besides the sentence.
  const post = `${sentence} ${SITE_URL}/read/${buy.buyer}`;
  const posted = buy.posted || postedNow;

  return (
    <div
      data-element="o-clock-line"
      className="mt-4 rounded-lg p-3 text-[13px]"
      style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid var(--color-kyle-40)' }}
    >
      <p className="text-white/90" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
        {sentence}
      </p>
      {posted ? (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--color-kyle)' }}>
          Posted.
        </p>
      ) : (
        /* The composer only: nothing is published on the buyer's behalf, and
           this opens a window they can close. The text is the sentence above
           plus their own read link, which the island ruled carries the real
           number in every form - the same door element B opens, and the same
           trade: the address is posted because the buyer chose to post it. */
        <a
          href={`https://x.com/intent/post?text=${encodeURIComponent(post)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => {
            markLastBuyPosted();
            setPostedNow(true);
          }}
          className="inline-block mt-2 px-4 py-1.5 text-[12px] font-semibold rounded-lg transition-all hover:brightness-110"
          style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid var(--color-kyle)', color: 'var(--color-kyle)' }}
        >
          Post
        </a>
      )}
    </div>
  );
}
