// Postgres writes. The only module that knows SQL.
//
// It takes a `client` with a single `query(text, params) => { rows }` method
// rather than importing `pg` itself. That is what lets every write path be
// exercised by the test suite against a recording fake, including the ordering
// rule below, which is the one thing here that cannot be checked by reading.
//
// THE ORDERING RULE: a signature's rows and that signature's cursor advance go
// in ONE transaction, and the cursor advances by exactly one signature at a
// time. Batch the advance and a crash between the last write and the commit
// leaves the cursor ahead of the data — a permanent hole that nothing detects,
// because next boot resumes from a point past the rows that were never written.
// Re-reading a handful of signatures after a crash costs a few RPC calls; the
// other failure costs silent, undetectable loss.

/** Gap kinds that describe the design, not a fault. See sql/001. */
export const STANDING_GAP_KINDS = new Set(["accrual-not-indexed", "fee-receiver-unset"]);

const INSERT_TRADE = `
  INSERT INTO solana_dbc_trade
    (signature, pool, slot, block_time, payer, direction, base_amount, quote_amount)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (signature, pool) DO NOTHING`;

const INSERT_CLAIM = `
  INSERT INTO solana_fee_claim
    (signature, pool, slot, block_time, receiver, mint, amount)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (signature, pool, mint) DO NOTHING`;

const UPSERT_CURSOR = `
  INSERT INTO solana_cursor (pool, last_signature, last_slot, last_block_time, updated_at)
  VALUES ($1, $2, $3, $4, now())
  ON CONFLICT (pool) DO UPDATE
    SET last_signature = EXCLUDED.last_signature,
        last_slot      = EXCLUDED.last_slot,
        last_block_time = EXCLUDED.last_block_time,
        updated_at     = now()`;

// The partial unique index means a re-detected gap is a no-op. A tick that
// keeps hitting the same unreadable transaction must not grow this table by a
// row every 15 seconds, and the hundredth detection is not new information.
const INSERT_GAP = `
  INSERT INTO solana_gap (pool, kind, standing, signature, from_slot, to_slot, detail)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (pool, kind, (COALESCE(signature, '')), (COALESCE(from_slot, -1)))
    WHERE resolved_at IS NULL
  DO NOTHING`;

export function createStore(client) {
  const q = (text, params) => client.query(text, params);

  return {
    /**
     * The env's watch set becomes the table's watch set.
     *
     * Dropped pools are RETIRED, never deleted: their trades, claims and gaps
     * stay readable and stay attributable to the pool they came from. A delete
     * would take the gap rows with it, which is the one deletion that quietly
     * turns "we could not read this" into "this never happened".
     */
    async syncWatches(watches) {
      for (const w of watches) {
        await q(
          `INSERT INTO solana_watch
             (pool, label, base_mint, quote_mint, fee_receiver, base_decimals, quote_decimals)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (pool) DO UPDATE
             SET label = EXCLUDED.label,
                 base_mint = EXCLUDED.base_mint,
                 quote_mint = EXCLUDED.quote_mint,
                 fee_receiver = EXCLUDED.fee_receiver,
                 base_decimals = EXCLUDED.base_decimals,
                 quote_decimals = EXCLUDED.quote_decimals,
                 retired_at = NULL`,
          [w.pool, w.label, w.baseMint, w.quoteMint, w.feeReceiver, w.baseDecimals, w.quoteDecimals],
        );
      }
      const pools = watches.map((w) => w.pool);
      await q(
        `UPDATE solana_watch SET retired_at = now()
          WHERE retired_at IS NULL AND NOT (pool = ANY($1::text[]))`,
        [pools],
      );
    },

    /**
     * The two limits of this leg, written down per pool so a SQL-only consumer
     * sees them without reading any documentation.
     *
     * Unrealized partner-fee accrual lives in the pool's account state; reading
     * it means decoding a layout this repo does not vendor. And with no fee
     * receiver configured there is nothing to recognise a claim by. Both are
     * "we do not know", and a fee total that omits them must never be read as
     * a fee total.
     */
    async declareLimitations(watches) {
      for (const w of watches) {
        await q(INSERT_GAP, [
          w.pool,
          "accrual-not-indexed",
          true,
          null,
          null,
          null,
          "partner fees accrued but not yet claimed live in pool account state; this service indexes " +
            "claims (transfers) only, so a fee total here is fees COLLECTED, never fees EARNED",
        ]);
        if (!w.feeReceiver) {
          await q(INSERT_GAP, [
            w.pool,
            "fee-receiver-unset",
            true,
            null,
            null,
            null,
            "no feeReceiver in SOLANA_WATCH for this pool, so partner-fee claims are not recognised at all",
          ]);
        }
      }
    },

    async getCursor(pool) {
      const { rows } = await q(
        `SELECT last_signature, last_slot, last_block_time FROM solana_cursor WHERE pool = $1`,
        [pool],
      );
      if (!rows || rows.length === 0) return null;
      const r = rows[0];
      return {
        lastSignature: r.last_signature ?? null,
        lastSlot: r.last_slot === null || r.last_slot === undefined ? null : Number(r.last_slot),
        lastBlockTime:
          r.last_block_time === null || r.last_block_time === undefined ? null : Number(r.last_block_time),
      };
    },

    /**
     * One signature's worth of facts plus its cursor advance, atomically.
     *
     * `trade` may be null and `claims` may be empty — a transaction that only
     * touched the pool still moves the cursor, or the same signature is
     * re-fetched on every tick forever.
     */
    async commitSignature({ pool, signature, slot, blockTime, trade, claims }) {
      await q("BEGIN");
      try {
        if (trade) {
          await q(INSERT_TRADE, [
            signature,
            pool,
            slot,
            blockTime,
            trade.payer,
            trade.direction,
            trade.baseAmount.toString(),
            trade.quoteAmount.toString(),
          ]);
        }
        for (const c of claims ?? []) {
          await q(INSERT_CLAIM, [
            signature,
            pool,
            slot,
            blockTime,
            c.receiver,
            c.mint,
            c.amount.toString(),
          ]);
        }
        await q(UPSERT_CURSOR, [pool, signature, slot, blockTime]);
        await q("COMMIT");
      } catch (e) {
        await q("ROLLBACK");
        throw e;
      }
    },

    async recordGap({ pool, kind, signature = null, fromSlot = null, toSlot = null, detail }) {
      await q(INSERT_GAP, [
        pool,
        kind,
        STANDING_GAP_KINDS.has(kind),
        signature,
        fromSlot,
        toSlot,
        detail,
      ]);
    },

    async recordTick({ headSlot = null, error = null }) {
      await q(
        `UPDATE solana_tick
            SET last_tick_at = now(),
                last_ok_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_ok_at END,
                head_slot = COALESCE($1::bigint, head_slot),
                last_error = $2
          WHERE id = 1`,
        [headSlot, error],
      );
    },

    /** Everything /status reports, read from the database rather than memory. */
    async readStatus() {
      const tick = await q(
        `SELECT last_tick_at, last_ok_at, head_slot, last_error FROM solana_tick WHERE id = 1`,
      );
      const pools = await q(
        `SELECT pool, label, cursor_signature, cursor_slot, cursor_updated_at,
                trades_observed, fee_claims_observed, claimed_fee_total_observed,
                open_gaps, standing_limitations
           FROM solana_launch_summary
          WHERE retired_at IS NULL
          ORDER BY pool`,
      );
      return { tick: tick.rows?.[0] ?? null, pools: pools.rows ?? [] };
    },
  };
}
