/**
 * "What is a liquidity pool, and why does this venue need one?"
 *
 * The operator asked for a surface "teaching people what they are, why they are
 * needed". This is that, and its shape is the argument:
 *
 *  · COLLAPSED BY DEFAULT. A primer that pushes the form below the fold taxes
 *    every returning LP to serve a first-timer once. `<details>` costs a
 *    first-timer one click and everyone else nothing, needs no JavaScript, and
 *    is keyboard- and screen-reader-native without a single ARIA attribute.
 *
 *  · FOUR QUESTIONS, IN THE ORDER THEY OCCUR. What is it / why does it exist /
 *    how do I get paid / what do I risk. The fourth deliberately hands off to
 *    the IL calculator further down the page rather than restating it: a number
 *    you can move beats a paragraph about a number.
 *
 *  · NO NUMBERS THAT CAN ROT. Every figure here is a protocol constant (the
 *    0.3% fee) or a formula, never a rate, an APR or a TVL. Teaching copy is the
 *    easiest place in an app for a stale number to hide, because nobody
 *    re-reads it — so it carries none. The live figures are in the table above,
 *    where they are read on chain and have an unreadable state.
 */
export function LiquidityPrimer() {
  return (
    <details
      className="group rounded-2xl overflow-hidden"
      style={{ background: 'rgba(4,9,18,0.6)', border: '1px solid var(--color-purple-25)' }}
    >
      <summary
        className="cursor-pointer list-none px-4 py-3.5 min-h-[48px] flex items-center justify-between gap-3 text-white text-[14px] font-semibold"
      >
        <span>New to this? What a liquidity pool is, in four answers</span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          className="opacity-60 flex-shrink-0 transition-transform group-open:rotate-180"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>

      <div className="px-4 pb-5 pt-1 space-y-4 text-[13px] leading-relaxed text-white/75">
        <div>
          <h3 className="text-white text-[13px] font-semibold mb-1">What is a liquidity pool?</h3>
          <p>
            Two tokens, held together in a contract, that anyone can trade against. There is no
            order book and nobody on the other side of your trade — the pool quotes a price from
            the ratio of what it holds, and that ratio moves as people trade. Put both tokens in
            and you own a share of the pool; take your share out and you get whatever the pool
            holds at that moment, in that proportion.
          </p>
        </div>

        <div>
          <h3 className="text-white text-[13px] font-semibold mb-1">Why does a venue need them?</h3>
          <p>
            A token with no pool cannot be bought. Every swap on this venue is executed against a
            pool, so liquidity is not a feature sitting beside trading — it is the thing trading
            runs on. A deeper pool moves its price less for the same size of trade, which is what
            people mean by slippage. Providing liquidity is how a community makes its own token
            tradeable without asking anyone&apos;s permission.
          </p>
        </div>

        <div>
          <h3 className="text-white text-[13px] font-semibold mb-1">How do I get paid?</h3>
          <p>
            Every swap through the pool pays a 0.3% fee, and that fee stays in the pool. It is not
            claimed and not distributed — the pool simply grows, so the share you hold is
            redeemable for slightly more than you put in. You are paid in proportion to your share
            and for as long as you hold it. Nothing is locked; you can withdraw at any block.
          </p>
        </div>

        <div>
          <h3 className="text-white text-[13px] font-semibold mb-1">What do I risk?</h3>
          <p>
            Two things, and they are different. The first is the tokens themselves: a pool does
            not protect you from either of them falling. The second is specific to pooling — if
            the two prices drift apart, the pool sells you out of the winner and into the loser as
            it rebalances, so you can end up worth less than if you had simply held both. That is
            impermanent loss, and the calculator at the bottom of this page will size it for any
            price move you want to test.
          </p>
        </div>
      </div>
    </details>
  );
}
