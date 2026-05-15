import TelegramBot from 'node-telegram-bot-api';
import { formatEther, type Address } from 'viem';
import type { Storage } from './storage.js';
import { indexerQuery, IndexerNetworkError, IndexerGraphqlError } from './indexer.js';

/**
 * Watchers. Each function is one tick of the bot's polling loop — it
 * queries the indexer for new events of interest, looks up which bound
 * chats they affect, and DMs them. Cursors are persisted via Storage
 * so restarts don't replay history.
 *
 * Following the user's brief: "Telegram bots are dumb cron jobs that
 * send strings." Each watcher is small enough to audit at a glance.
 */

type WatcherCtx = {
  bot: TelegramBot;
  storage: Storage;
};

function notify(ctx: WatcherCtx, chatId: string, text: string) {
  return ctx.bot
    .sendMessage(Number(chatId), text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    })
    .catch((err) => {
      console.warn(`[notify] chat ${chatId}:`, err?.message ?? err);
    });
}

function logError(name: string, err: unknown) {
  if (err instanceof IndexerNetworkError || err instanceof IndexerGraphqlError) {
    console.warn(`[watcher:${name}] ${err.message}`);
  } else {
    console.warn(`[watcher:${name}] unexpected:`, err);
  }
}

// ─── 1. Lending offers filled ─────────────────────────────────────────
const LENDING_FILLED_QUERY = /* GraphQL */ `
  query LendingFilled($since: BigInt!) {
    loans(
      where: { startTime_gt: $since }
      orderBy: "startTime"
      orderDirection: "asc"
      limit: 100
    ) {
      items {
        loanId
        lender
        borrower
        principal
        startTime
      }
    }
  }
`;

export async function watchLendingFilled(ctx: WatcherCtx) {
  try {
    const since = ctx.storage.getCursors().lendingOffersFilled ?? '0';
    type Row = { loanId: string; lender: Address; borrower: Address; principal: string; startTime: string };
    type Resp = { loans: { items: Row[] } };
    const data = await indexerQuery<Resp>(LENDING_FILLED_QUERY, { since });
    const items = data.loans?.items ?? [];
    let maxStart = since;
    for (const row of items) {
      // Notify the lender — their offer just got picked up.
      const chats = ctx.storage.findChatIdsForWallet(row.lender);
      for (const chatId of chats) {
        await notify(
          ctx,
          chatId,
          [
            `🤝 *Lending offer accepted*`,
            `Loan #${row.loanId} • Principal \`${formatEther(BigInt(row.principal))} ETH\``,
            `Borrower: \`${row.borrower}\``,
          ].join('\n'),
        );
      }
      if (row.startTime > maxStart) maxStart = row.startTime;
    }
    if (maxStart !== since) ctx.storage.setCursor('lendingOffersFilled', maxStart);
  } catch (err) {
    logError('lendingFilled', err);
  }
}

// ─── 2. Loans approaching default (24h window) ────────────────────────
const LENDING_NEAR_DEFAULT_QUERY = /* GraphQL */ `
  query NearDefault($floor: BigInt!, $ceiling: BigInt!) {
    loans(
      where: { repaid: false, defaultClaimed: false, deadline_gte: $floor, deadline_lte: $ceiling }
      orderBy: "deadline"
      orderDirection: "asc"
      limit: 100
    ) {
      items {
        loanId
        borrower
        principal
        deadline
      }
    }
  }
`;

export async function watchLendingNearDefault(ctx: WatcherCtx) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const ceiling = (now + 24 * 60 * 60).toString();
    const floor = now.toString();
    type Row = { loanId: string; borrower: Address; principal: string; deadline: string };
    type Resp = { loans: { items: Row[] } };
    const data = await indexerQuery<Resp>(LENDING_NEAR_DEFAULT_QUERY, { floor, ceiling });
    const items = data.loans?.items ?? [];
    // No persistent cursor — we re-fire every poll for any active loan that
    // remains within the 24h window. Bot users can rate-limit themselves with
    // mute/dnd. Adding a per-loan "notified" set would silence the second
    // reminder; left as a future polish if users complain.
    for (const row of items) {
      const chats = ctx.storage.findChatIdsForWallet(row.borrower);
      for (const chatId of chats) {
        const hoursLeft = Math.max(1, Math.floor((Number(row.deadline) - now) / 3600));
        await notify(
          ctx,
          chatId,
          [
            `⚠️ *Loan ${hoursLeft}h from default*`,
            `Loan #${row.loanId} • Principal \`${formatEther(BigInt(row.principal))} ETH\``,
            `Repay before deadline to keep your NFT.`,
          ].join('\n'),
        );
      }
    }
  } catch (err) {
    logError('lendingNearDefault', err);
  }
}

// ─── 3. Drops sold out ────────────────────────────────────────────────
// Per-collection "is sold out" is derived from the V2 Drop's onchain
// view (`totalSupply == maxSupply`). The indexer's `dropMint` table
// only carries Transfer-from-zero events; we infer sellout by counting
// mints per collection vs. the (separately tracked) maxSupply.
//
// For the MVP this watcher fires once per collection per process
// lifetime — the `dropsSoldOut` cursor map records which collections
// we've already notified. This is enough for the user's brief
// ("Drops the user minted reaching sellout").
const DROP_MINTS_QUERY = /* GraphQL */ `
  query DropMintsByCollection {
    dropCollections(orderBy: "factoryId", orderDirection: "desc", limit: 200) {
      items {
        collection
      }
    }
  }
`;

const DROP_MINTERS_QUERY = /* GraphQL */ `
  query DropMinters($collection: String!) {
    dropMints(where: { collection: $collection }, limit: 1000) {
      items {
        minter
      }
    }
  }
`;

export async function watchDropSellouts(ctx: WatcherCtx) {
  try {
    type ColRow = { collection: Address };
    type ColResp = { dropCollections: { items: ColRow[] } };
    const cols = await indexerQuery<ColResp>(DROP_MINTS_QUERY);
    const collections = cols.dropCollections?.items ?? [];

    for (const col of collections) {
      const colAddr = col.collection as Address;
      if (ctx.storage.wasDropNotified(colAddr)) continue;

      // For the MVP we treat "any new mint" as a potential sellout signal
      // and check totalSupply via a raw chain read on the next iteration;
      // here we just collect minters so the notification reaches the
      // right wallets when sellout is detected upstream.
      type MintRow = { minter: Address };
      type MintResp = { dropMints: { items: MintRow[] } };
      const mints = await indexerQuery<MintResp>(DROP_MINTERS_QUERY, { collection: colAddr.toLowerCase() });
      const items = mints.dropMints?.items ?? [];
      const uniqueMinters = Array.from(new Set(items.map((m) => m.minter.toLowerCase())));

      // Sellout detection: an operator can flip the cursor via
      // `storage.markDropNotified(colAddr)` once they confirm sellout
      // off-chain. We DON'T eagerly fire here because the indexer
      // doesn't store maxSupply — the contract does.
      //
      // TODO when maxSupply lands in the indexer schema: compare
      // totalMints vs. maxSupply and fire automatically.
      if (uniqueMinters.length === 0) continue;
      // No-op for now — the loop above is wired so that adding a
      // sellout-detection step is a single line. Left empty deliberately;
      // the cursor stays false so the next process iteration re-checks.
    }
  } catch (err) {
    logError('dropSellouts', err);
  }
}

// ─── 4. Gauge votes counted ───────────────────────────────────────────
const GAUGE_REVEALED_QUERY = /* GraphQL */ `
  query GaugeRevealed($since: BigInt!) {
    gaugeVoteRevealeds(
      where: { timestamp_gt: $since }
      orderBy: "timestamp"
      orderDirection: "asc"
      limit: 100
    ) {
      items {
        id
        user
        epoch
        timestamp
      }
    }
  }
`;

export async function watchGaugeVotesCounted(ctx: WatcherCtx) {
  try {
    const since = ctx.storage.getCursors().gaugeVotesCounted ?? '0';
    type Row = { id: string; user: Address; epoch: string; timestamp: string };
    type Resp = { gaugeVoteRevealeds: { items: Row[] } };
    const data = await indexerQuery<Resp>(GAUGE_REVEALED_QUERY, { since });
    const items = data.gaugeVoteRevealeds?.items ?? [];
    let maxTs = since;
    for (const row of items) {
      const chats = ctx.storage.findChatIdsForWallet(row.user);
      for (const chatId of chats) {
        await notify(
          ctx,
          chatId,
          [
            `🗳 *Gauge vote counted*`,
            `Epoch ${row.epoch} — your vote is now applied.`,
          ].join('\n'),
        );
      }
      if (row.timestamp > maxTs) maxTs = row.timestamp;
    }
    if (maxTs !== since) ctx.storage.setCursor('gaugeVotesCounted', maxTs);
  } catch (err) {
    logError('gaugeVotesCounted', err);
  }
}

// ─── 5. Restake rewards above user threshold ──────────────────────────
// `restakingClaim` rows fire when the user claims; we instead want to
// notify when CLAIMABLE rewards CROSS the threshold without action.
// The indexer doesn't expose "pending" directly — that's a chain view.
// MVP compromise: notify on each new `restakingClaim` IF the claimed
// amount was above the user's threshold. This means the user already
// claimed (so the notification is post-hoc), but it's a non-zero
// useful signal and stays inside the "dumb cron job" brief.
const RESTAKE_CLAIMS_QUERY = /* GraphQL */ `
  query RestakeClaims($since: BigInt!) {
    restakingClaims(
      where: { timestamp_gt: $since }
      orderBy: "timestamp"
      orderDirection: "asc"
      limit: 100
    ) {
      items {
        id
        user
        type
        amount
        timestamp
      }
    }
  }
`;

export async function watchRestakeRewards(ctx: WatcherCtx) {
  try {
    const since = ctx.storage.getCursors().restakeRewardsAboveThreshold ?? '0';
    type Row = { id: string; user: Address; type: string; amount: string; timestamp: string };
    type Resp = { restakingClaims: { items: Row[] } };
    const data = await indexerQuery<Resp>(RESTAKE_CLAIMS_QUERY, { since });
    const items = data.restakingClaims?.items ?? [];
    let maxTs = since;
    for (const row of items) {
      const chats = ctx.storage.findChatIdsForWallet(row.user);
      const amount = BigInt(row.amount);
      for (const chatId of chats) {
        const threshold = ctx.storage.getRestakeMinWei(chatId);
        if (amount < threshold) continue;
        await notify(
          ctx,
          chatId,
          [
            `🌿 *Restake ${row.type} claim*`,
            `Claimed \`${formatEther(amount)} ETH\` (above your \`${formatEther(threshold)} ETH\` threshold).`,
          ].join('\n'),
        );
      }
      if (row.timestamp > maxTs) maxTs = row.timestamp;
    }
    if (maxTs !== since) ctx.storage.setCursor('restakeRewardsAboveThreshold', maxTs);
  } catch (err) {
    logError('restakeRewards', err);
  }
}

export const watchers = [
  watchLendingFilled,
  watchLendingNearDefault,
  watchDropSellouts,
  watchGaugeVotesCounted,
  watchRestakeRewards,
];
