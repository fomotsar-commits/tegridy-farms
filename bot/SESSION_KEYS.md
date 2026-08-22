# In-chat execution: the design, and why it is not built

The brief that produced the bot asked for one more thing than the bot ships: *if a
genuinely non-custodial in-chat execution path exists — scoped session keys with
spend caps and expiry via the F6 seam — design it and write the plan, but do not
ship key handling that has not been through an audit wave.*

This is that plan. Nothing described below exists in the tree. The bot as built
refuses every value-moving command and hands back a link.

---

## 1. Why the obvious version is the one that lost the money

The competitor design is: the bot generates a wallet for the user, holds the key,
and signs on their instruction. It converts a one-tap UX into a single point of
total loss, and both of the two largest bots on this surface were exploited through
exactly that point. There is no amount of encryption-at-rest that changes the shape:
if the server can sign without the user present, then whoever controls the server
can sign without the user present.

The intermediate version — "we derive the key from a passphrase, so we never store
it" — is worse, not better, because it *sounds* like it fixed something. A server
that can derive a key on request is a server that holds a key with extra steps.

**House law, `docs/BATTLE_PLAN.md` line 30: no server ever holds user keys. This is
the one line the revenue evidence never justifies crossing.**

## 2. What a genuinely non-custodial in-chat path would have to be

The user delegates a *narrow, revocable, expiring* authority to a key that is not
theirs and not the bot's spending key — a **session key** — and the delegation is
enforced by a contract, not by the honesty of the process holding it. The user
signs the grant once, in the app, with their own wallet. After that a keeper can
act inside the grant and nowhere outside it.

The grant is only meaningful if all of these are true:

1. **The scope is on-chain.** A validator contract checks target, selector, token
   allowlist, per-transaction cap, rolling daily cap and expiry. A grant enforced
   by the executor's own code is not a grant, it is a promise.
2. **Expiry is mandatory and short.** No open-ended session. An unbounded grant is
   a custodial key with a nicer name.
3. **Revocation is unilateral and immediate.** One transaction from the user's own
   wallet kills it, with no cooperation from the venue.
4. **The session key cannot transfer out.** Scoped to the router's swap entry
   points, never to `transfer`, `approve`, or any path that moves an asset to an
   arbitrary address. The worst case of a fully compromised session key must be
   *bad trades inside the cap*, not *drained wallet*.
5. **The bot still holds nothing.** The session key lives with the F4 keeper, which
   is a separate service with a separate blast radius, or in the user's own Mini
   App client. Not in this process.

Point 5 is worth restating: even the session-key design does not put a key in the
bot. The bot's role stays what it is today — parse intent, produce a payload, and
send the user somewhere to authorise it.

## 3. The pieces this venue would need, and their state

| Piece | State |
|---|---|
| Session-key validator contract (scoped, capped, expiring) | **Does not exist.** F6 deliverable. |
| An audit wave over that contract | **Has not happened.** F7. It moves user funds, so it is mandatory, not advisable. |
| F4 keeper (execution, retries, receipts) | **Does not exist.** `KEEPER_AVAILABLE` is a constant `false` in the frontend, deliberately not an env dial. |
| `TerminalFeeRouter` — the fee leg a session key would be scoped to | **Does not exist.** |
| F1 indexer, to show grants and fills back to the user | Built, **hosted nowhere**. |
| Grant/revocation indexing | Not in `indexer/ponder.schema.ts`. |

Six preconditions, of which zero are met. This is not a near-term item dressed up
as a distant one.

## 4. If all six were met, the flow

```
User (Telegram)          Bot                 App (browser)        Chain
──────────────────────────────────────────────────────────────────────────
/buy 0.5 eth of X   ──▶  parse intent
                         build a GRANT
                         REQUEST, not a
                         transaction
                    ◀──  deep link
                              │
open link ───────────────────▶│
                              │  show the exact scope in words:
                              │  target, token, per-tx cap, daily
                              │  cap, expiry, and what it can NOT do
                              │
                         user signs the grant  ───────────────▶  validator
                                                                 records grant
                              │
                         ◀────┘
keeper executes inside the grant ─────────────────────────────▶  router
                    ◀──  receipt in chat, from the indexer
```

Three properties of that diagram are the whole point:

- **The bot never touches the signing step.** It builds a request; the app obtains
  the signature; the keeper executes. Three processes, and no one of them can both
  decide and sign.
- **The scope is shown in words before the signature**, including the negative
  space — what the grant cannot do. A user who cannot read a grant has not
  consented to it, and "sign this to enable trading" is how the previous generation
  of drains got their signatures.
- **The receipt comes from the indexer**, not from the keeper's own claim about
  what it did. An executor reporting its own success is the shape that lets a
  failed order look filled.

## 5. What must NOT be built as a shortcut

- A "bot wallet" the user funds. That is custody with a deposit step.
- A session key held by *this* process. It collapses three blast radii into one and
  gives back the single point of loss the whole design exists to remove.
- An off-chain allowlist. Scope enforced by the executor is not scope.
- A grant with no expiry, or one the venue can extend.
- Shipping the validator before the audit wave because the contract "is small".
  Small contracts that move user funds are the ones that get deployed unaudited.

## 6. The honest position, today

The bot answers questions and hands back links. That is less than a competitor
offers and it is the whole of what can be offered without a key. Anyone proposing
to close that gap should start at the table in §3 and finish it in order — not at
this file's diagram, which is the easy part.
