/**
 * The island's flame in the receipt card's ring (island answer twenty-nine, §1, the owner's
 * word of 11-06): the confetti was Robinhood's gesture; the venue's own is this. While the card
 * rises the 56 px ring holds an ember, one 6 px gold dot. The moment a buy's or an add's card is
 * up the ember catches: the flame grows out of it, the ring's glow breathes once, the card's edge
 * warms once and the clock line lights last. A sale never catches: the ember sits in the ring,
 * steady. The motion is CSS (index.css, "The flame catches"), keyed on `data-flame`; the card
 * carries the same state for its edge and its clock line. The flame is the one on the island
 * card that Share hands over: one picture on two sites.
 */
export type FlameState =
  /** The card rising, or a sale: the ember, steady. */
  | 'ember'
  /** A buy or an add, the card up: the ember catches, once. */
  | 'catching'
  /** Caught already for this signature (Bayla's Receipt raising the same card): lit, nothing moves. */
  | 'lit';

export function FlameCatch({ state }: { state: FlameState }) {
  return (
    <div aria-hidden="true" className="flame-ring" data-testid="flame-ring" data-flame={state}>
      <span className="flame-ember" />
      {/* Two paths in a 28 by 28 box: the body in the venue's green, the core in its gold. */}
      <svg className="flame-fire" viewBox="0 0 28 28" aria-hidden="true">
        <path d="M14 2 C14 2 7 9 7 15.5 C7 19.6 10.1 23 14 23 C17.9 23 21 19.6 21 15.5 C21 12.8 19.6 10.3 18.2 8.6 C18 11 16.8 12.6 15.6 13.2 C16.4 9.8 15.4 5.6 14 2 Z" fill="#4CAF50" />
        <path d="M14 23 C11.8 23 10.2 21.2 10.2 19 C10.2 16.5 12.6 15 13.2 12.6 C14.9 14.2 17.8 16 17.8 19 C17.8 21.2 16.2 23 14 23 Z" fill="#d4a017" />
      </svg>
    </div>
  );
}
