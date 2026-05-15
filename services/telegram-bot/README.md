# @tegridy/telegram-bot

Telegram notification bot. Watches the Ponder indexer for events that
touch bound wallets and DMs the Telegram chats that bound them.

P2-8 of the 30-day UX push. Designed to be deployed next to the indexer
(same host or container) — the brief was explicit: "Telegram bots are
dumb cron jobs that send strings."

## What it watches

| Event                          | Triggers on                                   |
| ------------------------------ | --------------------------------------------- |
| Lending offer filled           | New `loan` row whose `lender` is bound        |
| Loan ≤24h from default         | `loan.deadline` in the next 24h, not repaid   |
| Drop sold-out (your mint)      | `dropMint` rows for a collection that flipped |
| Gauge vote counted             | `gaugeVoteRevealed` row for a bound `user`    |
| Restake reward above threshold | `restakingClaim.amount ≥` user threshold      |

## Binding a wallet

In a DM with the bot:

```
/bind
```

The bot replies with a fixed challenge message. Sign it in your wallet
(e.g. via Etherscan's signature tool or the Tegridy app's "sign for
Telegram" button when shipped). Then:

```
/bind 0xYourAddress 0xSignature
```

The bot verifies the signature via `viem.verifyMessage` and stores the
binding. `/unbind` clears it.

## Commands

| Command                | What it does                              |
| ---------------------- | ----------------------------------------- |
| `/start`               | Welcome + intro                           |
| `/bind`                | Issue a signing challenge                 |
| `/bind 0x… 0x…`        | Submit address + signature                |
| `/status`              | Show bound wallet + threshold             |
| `/unbind`              | Drop the binding                          |
| `/threshold 0.1`       | Set restake-reward threshold in ETH       |
| `/help`                | Command list                              |

## Running locally

```bash
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN and (if not running indexer locally) INDEXER_URL
npm install
npm run dev
```

`npm run dev` uses `tsx watch` so source edits restart the bot. The
state file (`.state.json` by default) survives restarts so bindings and
cursors don't reset.

## Deploying

The bot is a single long-running Node process. Any host that can run a
Node 20+ service works — Railway / Render / Fly.io / a small VPS / a
container in the same compose file as the indexer.

Requirements:

- `node >= 20`
- Write access to wherever `STATE_FILE` lives (default `./.state.json`,
  but in production set it to a path on a persisted disk).
- Network egress to `api.telegram.org` and to `INDEXER_URL`.

Build + start:

```bash
npm install
npm run build   # writes JS to dist/ if you want a non-tsx runtime
npm start       # runs via tsx (no build step needed)
```

## Adding a new watcher

1. Write a function in `src/watchers.ts` matching the
   `(ctx: { bot, storage }) => Promise<void>` shape.
2. Use `indexerQuery<T>(...)` to ask the indexer for what changed
   since the last poll. Read/write the per-watcher cursor via
   `ctx.storage.getCursors()` / `setCursor(...)`.
3. Look up bound chats via
   `ctx.storage.findChatIdsForWallet(userAddress)`.
4. Append the new function to the `watchers` array at the bottom of
   `watchers.ts`. Every tick calls every watcher serially.

That's the entire architecture. No queues, no clustering, no retries
beyond what the indexer / Telegram API already give us.

## What this bot is NOT

- Not a webhook-style architecture. Polling is enough for ≤1k bound
  users and the indexer's GraphQL layer handles filtering cheaply.
- Not multi-tenant. One bot per Tegridy instance.
- Not user authentication. The `/bind` signature binds one wallet to
  one chat for read-only notifications — there are no privileged
  actions the bot can take on the user's behalf.

## Operational gotchas

- The bot uses Telegram **long polling** (`node-telegram-bot-api`'s
  default). If you also wire a webhook in BotFather, polling will
  fight the webhook and lose messages. Pick one.
- `.state.json` is the source of truth. Back it up before redeploys.
- Bot replies to direct messages only. Group chats are ignored to
  keep the surface tight.
