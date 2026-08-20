# Deploying the Tegridy Telegram bot

Node 20 service, zero npm dependencies, complete and deployed nowhere. Everything
on the venue side is already built and waiting: `frontend/api/_lib/botLink.js` is
dispatched from the aggregator catchall, and
`frontend/src/components/bot/TelegramLinkPanel.tsx` is mounted on `/alerts`. Two
environment variables and a migration are what turn this on.

**The hosting choice is the operator's** — it costs money and creates a Telegram
account this repo cannot create. Everything up to that decision is done.

---

## 0. What you are deploying, and the one thing it will never do

| Piece | Where |
|---|---|
| Command router (every reply the bot can produce) | `src/commands.js` |
| Telegram transport (long polling, no dependencies) | `src/telegram.js` |
| Venue calls, HMAC-signed | `src/venueClient.js` |
| Indexed reads, ready-gated | `src/indexerClient.js` |
| Telegram id → `chat_ref` digest | `src/chatRef.js` |
| Config and the capability report | `src/config.js` |
| Seed-phrase / key tripwire | `src/secretGuard.js` |

**It holds no key.** Not encrypted, not sharded, not in an HSM, not "just for gas".
A chat is bound to a wallet by that wallet SIGNING in the web app, and everything
that would move value comes back to the user as a link they open and sign
themselves. If a future change makes this service capable of producing a
signature, `frontend/api/__tests__/bot-noncustodial.test.js` fails the build, and
that test is not the obstacle — it is the record of a decision that was made
deliberately, after Trojan and Banana Gun both lost user funds the other way.

Read `bot/SESSION_KEYS.md` before proposing in-chat execution. There is a design
for it; it is gated on an audit wave that has not happened.

---

## 1. Hosting — recommendation, and why

**Recommended: Railway**, on the same project as the indexer.

1. **Long-running process, not serverless.** The bot holds an open long-poll to
   Telegram. Vercel is the wrong shape, and the 12-function Hobby cap is real and
   already at 11 — see `frontend/api/SERVERLESS_BUDGET.md`. **Do not add an
   `api/bot.js` webhook function.**
2. **No inbound port needed.** Long polling means the host needs no public
   hostname, no TLS certificate and no webhook secret rotation. A private worker
   service is enough.
3. **It is where the neighbours are.** The indexer (F1) is already recommended
   there, and this service reads from it.

Fly.io, a small VPS, or a home server all work. The requirements are Node ≥ 20 and
outbound HTTPS. Nothing else.

### Provision

1. Add a service from this repo with **root directory `bot/`**.
   - Build: *(none — `npm ci` installs nothing; the package has no dependencies)*
   - Start: `npm run start` (= `node src/index.js`)
   - Node: ≥ 20 (`package.json` engines)
2. Set the environment variables in §2.
3. There is **no health endpoint** and deliberately no port. Point the platform's
   restart policy at process exit, not at an HTTP check. `npm run preflight`
   exits non-zero on a fatal config problem and prints the capability report;
   that is the check to run in a deploy step.

---

## 2. Environment variables

Exactly what the code reads (`src/config.js`).

| Variable | Required? | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **Yes** | From @BotFather. Without it nothing can be received or sent, and the process refuses to start rather than idling silently. |
| `BOT_LINK_SECRET` | **Yes** | Shared with the Vercel deployment. See the warning below. |
| `VENUE_ORIGIN` | No | Defaults to `https://memetic.fun`. Where `/api/aggregator` lives. |
| `APP_ORIGIN` | No | Defaults to `https://memetic.fun`. What the bot puts in the links it hands back. |
| `INDEXER_URL` | No | The indexer's **public proxy origin**, no path — the same value as the frontend's `VITE_INDEXER_URL`. Unset means `/history` answers "no indexer is hosted", never "you have no swaps". |
| `TELEGRAM_POLL_TIMEOUT_SEC` | No | Long-poll seconds. Default 30. |

### `BOT_LINK_SECRET` — generate once, then never rotate casually

```
openssl rand -hex 32
```

Set the **same value** in two places: this service, and the Vercel project (where
`frontend/api/_lib/botLink.js` reads it). It does two jobs at once:

- it authenticates the bot's calls to the venue (HMAC over `${timestamp}.${body}`), and
- it derives `chat_ref = HMAC(secret, 'tg:' || telegram_user_id)`, which is the
  only form of a Telegram identity that ever reaches the database.

**Rotating it silently unlinks every user.** The rows survive; the digests no
longer match; every linked chat reads as unlinked and every user must re-link.
There is no migration that can repair it, because the input to the old digest —
the Telegram id — was never stored. Treat rotation as a user-visible event.

A mismatch between the two sides is less dramatic and just as total: every bot
call answers `401 {code: "bad-signature"}` and every command reports that it could
not read the store.

---

## 3. The migration is a prerequisite, not a nicety

Apply `frontend/supabase/migrations/020_telegram_links.sql` to the Supabase project
by hand. This repo has no migration ledger.

Until it is applied, PostgREST answers `PGRST205` and the venue returns
`503 {code: "schema-missing"}` with the step attached. The bot prints that, and the
alerts panel prints it. **Nothing anywhere answers `linked: false`** — "this chat
is not linked" and "no chat could ever have been linked" are different facts and
only one of them is about the user.

The file ends with `NOTIFY pgrst, 'reload schema';`. Without that the table exists
in Postgres and PostgREST still 404s until the pool is bounced by hand.

Verify:

```sql
select count(*) from telegram_links;   -- 0 rows, not an error
```

---

## 4. Telegram setup

1. `/newbot` to @BotFather, take the token.
2. `/setcommands`, paste:

```
link - Bind this chat to your wallet
status - What this chat is linked to
unlink - Cut the binding
heat - Held-time standing
history - Your venue-routed swaps
scan - Open the holder scanner for a token
alerts - Where alerts actually go
```

3. `/setprivacy` → **Enable**. Group privacy mode ON means the bot only receives
   messages addressed to it. Leave it on: this bot's tripwire reads message text,
   and a bot that receives every message in every group it is in is holding far
   more than it needs to do its job.
4. **Do not set a webhook.** This service polls; a webhook left configured from an
   earlier experiment makes `getUpdates` fail with `409 Conflict`.

---

## 5. Bring-up

1. `npm run preflight` — expect exit 0 and a capability report. Every `[off]` line
   states its own reason; read them, because those are the answers your users will
   get.
2. Start the service. Expect `connected as @yourbot`.
3. Send `/status` from a personal chat. Expect "not linked to any wallet" plus the
   capability list. If instead it says it could not read whether the chat is
   linked, §2 or §3 is unfinished — and note that it did NOT say you are unlinked.
4. Send `/link`. Expect a code and a URL under `APP_ORIGIN`.
5. Open the URL, connect a wallet, sign in, press the link button. Expect
   "Linked." on the page.
6. `/status` again. Expect the wallet address.
7. `/unlink`, then `/status`. Expect "not linked".
8. **Prove the refusal.** Send `/buy 1 eth`. Expect a refusal naming the reason and
   a link to the app. If any future version of this answers with anything that
   looks like an order, stop the service.
9. **Prove the tripwire**, with a phrase controlling nothing:
   `abandon ability able about above absent absorb abstract absurd abuse access accident`.
   Expect the warning. Then delete your message — the warning tells the user to,
   and it is worth having done it once yourself to see how little deleting does.

---

## 6. Turning on indexed answers

Set `INDEXER_URL` to the indexer's public proxy origin once `indexer/DEPLOY.md` is
done, and restart. Until then `/history` says the venue hosts no indexer.

Verify the reverse too — unset it, restart, and confirm `/history` reports
unavailable rather than answering "no swaps". That is the failure this gate exists
for and it is worth proving once, deliberately.

---

## 7. Known gaps (so silence is not mistaken for absence)

- **No alerts are delivered to Telegram, by anyone, ever, today.** Nothing in this
  venue runs on a schedule: there is no keeper and no F9 worker. Alert rules are
  evaluated in the user's browser while the app is open. `/alerts` says exactly
  this, and the alerts page says it too. Do not "fix" it with a cron that pretends
  to be the worker.
- **No Solana reads.** `/history` covers EVM venue-routed swaps from the Ponder
  indexer. The `indexer-solana` leg writes to the same Postgres but is not exposed
  through the GraphQL surface this bot queries, so there is nothing to ask.
- **No balances.** `/history` is fills, not holdings. A balance needs token
  decimals and price context the bot does not read, and a number rendered with the
  wrong decimals is worse than no number.
- **No group-chat features.** Commands work in groups (with `@botname`), but a
  binding is per Telegram USER, not per chat: two people in a group each get their
  own `chat_ref`, and neither can read the other's wallet.
- **The update offset is in memory.** A restart resumes from Telegram's backlog,
  which can re-deliver a message the bot already answered. Every command here is a
  read or an idempotent write, so a duplicate is a duplicate reply and nothing
  worse. Do not add a command for which that is untrue without adding persistence.
- **No rate limiting of its own.** The venue rate-limits the bot's calls
  (`identifier: "bot-link-service"`, 120/min) and Telegram rate-limits outbound
  messages. A single abusive chat can therefore spend the bot's shared venue
  budget. If that becomes real, the fix is per-`chat_ref` limiting in
  `src/index.js`, not raising the venue cap.
