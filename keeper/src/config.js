// What the keeper watches, and the numbers it judges with.
//
// Every address here was read from mainnet on 2026-10-16 and is checked again at
// run time where the chain can say it (a pool names its own mints, vaults and fee
// tier; those are never taken from this file). test/addresses.test.mjs decodes each
// one: a mistyped address looks exactly like a right one.

/** The venue's pool program (our cp-swap fork). */
export const PROGRAM_ID = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';

/** The Squads vault, the venue's treasury. Every fee tier's protocol (venue) fee owner must be this. */
export const VENUE_VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';

/**
 * The island's Workshop: every fee tier's fund fee owner, the island's agreed share of each
 * fee since the split went live (2026-10-19; read on chain 2026-10-25, slot 461,072,652,
 * on both tiers). frontend/src/lib/launcher/solana/write/plant.ts WORKSHOP_WALLET.
 */
export const ISLAND_WORKSHOP = 'G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu';

/**
 * Where a live correction's profit goes (owner, 2026-10-25: "it should pay to our treasury
 * and we can distribute how we want"): the treasury, never the pool's LPs and never kept in
 * the keeper's wallet. Only what is above the owner's float is ever sent; the float stays
 * the owner's. Week 1 sends nothing: this only names it in the log and the report.
 */
export const PROFIT_TO = VENUE_VAULT;

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** Read from the BAYLA/USDC pool's own account on 2026-10-16, not from memory. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** frontend/src/lib/bungalows.ts BAYLA_MINT. */
export const BAYLA_MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';

/**
 * BAYLA's deep outside market: pump.fun's AMM pool (~333 SOL a side on 10-16).
 * Every outside BAYLA quote is FORCED through this one pool, so a thin or odd pool
 * elsewhere can never become the price the keeper follows.
 */
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMP_BAYLA_POOL = '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n';

/**
 * The pools the keeper watches. SOL/USDC (an outsider's ~$140 pool, never traded)
 * is left out on purpose: fixing it pays well under a cent.
 *
 * `maxIn` is the most one correction may spend, in whole coins of the pool's
 * pairing coin: the sizes that closed the full 10-16 gaps.
 */
export const POOLS = [
  { name: 'BAYLA/SOL', address: 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4', token: BAYLA_MINT, coin: SOL_MINT, coinSymbol: 'SOL', maxIn: 0.5 },
  { name: 'BAYLA/USDC', address: 'J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm', token: BAYLA_MINT, coin: USDC_MINT, coinSymbol: 'USDC', maxIn: 20 },
];

/** Alert the owner when a pool is this far from the outside price. */
export const ALERT_GAP_PCT = 3;
/**
 * An outside price that moves this much within a minute is a reason to PAUSE AND
 * ALERT, never to skip quietly: the biggest gaps come exactly then, and a skipped
 * one is handed to a stranger.
 */
export const BIG_MOVE_PCT = 15;
export const BIG_MOVE_WINDOW_MS = 60_000;

/** One signature's network fee. */
export const BASE_FEE_LAMPORTS = 5_000n;
/** Jito tip the live keeper would pay; the median tip on 10-16 was ~10,300 lamports. */
export const TIP_LAMPORTS = 10_000n;
/** A correction must clear this after every cost (0.00005 SOL). */
export const MIN_PROFIT_LAMPORTS = 50_000n;

/** Size of the probe trade that reads BAYLA's outside price (the site uses the same 0.05 SOL). */
export const PROBE_LAMPORTS = 50_000_000n;
/** Size of the probe that reads SOL's price in USDC. */
export const SOL_USDC_PROBE_LAMPORTS = 1_000_000_000n;
/** Jupiter route size cap for the size check: our own leg adds ~13 accounts on top. */
export const MAX_JUPITER_ACCOUNTS = 40;

/**
 * A middle leg's output is only certain down to its minimum, so the next leg may
 * count on this much less than the quote (0.1%). It is the pump.fun leg's slippage
 * allowance: whatever the fill gives above the minimum is left over, as BAYLA (at
 * most 0.1% of one correction's BAYLA) or SOL, and the live keeper sells leftover
 * BAYLA on its next correction.
 */
export const CHAIN_SLIPPAGE_BPS = 10n;

/**
 * The confirming quote may differ from the fitted curve by this much. More means
 * the outside price moved while it was being read, and no correction is counted.
 */
export const MODEL_TOLERANCE_PCT = 2;
/** Unread for this long in a row sends an alert: unread is never "no gap". */
export const UNREAD_ALERT_MS = 10 * 60_000;
/** The same pool is not alerted about again within this window unless its gap moved. */
export const ALERT_COOLDOWN_MS = 15 * 60_000;

/** Settings that come from the environment. None of them is a signing key: there is none. */
export function readEnv(env = process.env) {
  const interval = Number(env.KEEPER_INTERVAL_SECONDS ?? 30);
  return {
    rpcUrl: env.KEEPER_RPC_URL || 'https://api.mainnet-beta.solana.com',
    jupiterApiKey: env.JUPITER_API_KEY || null,
    taker: env.KEEPER_TAKER || null,
    telegramToken: env.TELEGRAM_BOT_TOKEN || null,
    telegramChat: env.TELEGRAM_CHAT_ID || null,
    intervalMs: Math.max(10, Number.isFinite(interval) ? interval : 30) * 1000,
    logDir: env.KEEPER_LOG_DIR || null,
  };
}
