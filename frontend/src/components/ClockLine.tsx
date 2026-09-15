import { useState } from 'react';
import { peekHeat } from '../lib/heat/heatClient';
import { readLastBuy, markLastBuyPosted } from '../lib/heat/lastBuy';

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
 * WHERE THIS DEPARTS FROM THE RULING'S DEFAULT, AND WHY. The island ruled the
 * default "My clock on <SYMBOL> started today", reading "keeps running" only on
 * a warm scoped reading. But a cache MISS is not a cold wallet: it means the
 * venue has not read this buyer. On the five Solana rooms it will almost always
 * miss, because the room's own card reads the connected EVM address and never
 * the Solana pubkey, so the ruled default would print "started today" to a
 * holder of two years' standing - a claim the venue cannot support, in a
 * sentence built to be posted. So:
 *
 *   reading, with a row for this token   -> "keeps running"   (the venue read it)
 *   reading, with no row for this token  -> "started today"   (the venue read it)
 *   no reading at all                    -> nothing renders   (the venue has not read it)
 *
 * The third case is element P's own rule applied here - "instrument
 * unreachable: the line is absent; never a zero" - and the venue's standing
 * one, that an unread value must never read as a fact. Reported to the island.
 */
export function ClockLine() {
  const [postedNow, setPostedNow] = useState(false);

  // Read at render rather than in state: the latch is written by the swap's own
  // success effect, which is not this tree, and a buy that lands after mount
  // must not need a second event to be seen. It is one storage read.
  const buy = readLastBuy();
  if (!buy) return null;

  const reading = peekHeat(buy.buyer);
  if (!reading) return null;

  // The same row rule element D uses (HeatCard's ScopedReading): fold BOTH
  // sides. Folding both is match-safe even for a Solana mint, which is why it
  // differs from the registry finder, where a folded key would be compared
  // against an unfolded canon and quietly name the wrong room.
  const want = buy.tokenAddress.trim().toLowerCase();
  const held = reading.breakdown.some((r) => r.tokenAddress.trim().toLowerCase() === want);

  const sentence = `My clock on ${buy.symbol} ${held ? 'keeps running' : 'started today'}.`;
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
        /* The composer only. Nothing is published on the buyer's behalf, and
           the text is the sentence above and nothing else: no address, no
           balance, no link the buyer did not ask to hand over. */
        <a
          href={`https://x.com/intent/post?text=${encodeURIComponent(sentence)}`}
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
