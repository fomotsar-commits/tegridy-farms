# The face's laws

Laws 18 to 23 of `CLAUDE.md`: what a visitor's screen must always show. They come from the
island's venue review of 2026-10-03. A law is written here by the pull request whose test
failed without it, so a number missing below is a law that is not true yet. Law 24 of the
review was refused: it is law 3 already.

21. The farm speaks only in its room. On a venue route the words, the footer and the corner are the venue's, whatever door was opened last. TOWELI's sentence, contract card, market links, ticker and Towelie show on `/toweli` and TOWELI's own pages; a resident's footer card shows on that resident's door and lock page. A room's art and its trade route still follow the room. Tests: `frontend/e2e/farm-in-its-room.spec.ts`, `frontend/src/lib/arrival.test.ts`, `frontend/src/components/layout/roomChrome.test.tsx`.
22. A shared `/read/<address>` link carries the island's painted card, `https://memetics.wtf/api/card?w=<address>`, for a wallet the island returns a reading for. A cold or unread wallet keeps the venue's card, because the venue never posts a zero. The title does not change. Test: `frontend/middleware.test.js`.
23. Off is not listed, and no bar or tab strip says Soon. A section's tab that is off today is left out of its strip; reached by its URL, its page opens with its own tab lit and says what it waits on. The bar reads Heat · Rooms · Lock · Launch · Swap at every width and everything else is one drawer. Tests: `frontend/src/components/layout/RouteTabs.test.tsx`, `frontend/src/pages/SectionHost.test.tsx`, `frontend/e2e/nav-five-words.spec.ts`.

## Not true yet

- Law 21 on `/dashboard`: it still follows the room opened last, because a room's positions have no address of their own. The farm's lock labels are also still to come.
- Law 23 past the bars and strips: Soon still marks `/nft-finance`'s overview cards, one row on `/security`, the not-deployed card (`FeatureNotDeployed`, on `/community`, `/vesting` and others), the bungalow picker's open lot and the LP farming panel. `/nft-finance`'s own strip still lists its three undeployed panels, unmarked.
- Laws 18, 19 and 20 land with the pull requests that make them true.
