// Books against the chain: what the bot believes the house's WETH, approval and Seaport counter
// should be, from what it approved, what it was filled for and what it bumped, against one chain
// snapshot. A difference means something other than the bot moved the house's money or state
// (a stolen key, a fill the bot never saw, a ledger rolled back), and is an integrity trip.
//
// Every figure is taken at one block: fills and approvals after the snapshot's block are not
// counted against it, so a snapshot that lags the bot's own news is not a false alarm. The loop
// re-reads the chain's house fills and checks again before it trips on a mismatch.

/**
 * @param {object} a
 * @param {{ block: number, house: { weth: bigint, allowance: bigint, counter: bigint } }} a.snapshot
 * @param {{ amountWei: bigint, block: number } | null} a.lastApproval   the latest approval the signer mined
 * @param {{ block: number, unitPriceWei: bigint }[]} a.fills            every house fill the bot knows
 * @param {bigint | null} a.expectedCounter                             the counter the books expect
 * @param {boolean} [a.counterBumpPending]                              the bot itself sent a counter bump not yet seen
 * @param {{ weth: bigint, block: number } | null} a.prevWeth            the last WETH balance and its block
 * @param {{ block: number, wethOut: bigint }[]} [a.ownTxs]              the house's own mined txs that took WETH out
 * @returns {{ ok: boolean, mismatches: { field: string, expected: string, actual: string }[] }}
 */
export function reconcile({ snapshot, lastApproval, fills, expectedCounter, counterBumpPending = false, prevWeth, ownTxs = [] }) {
  const mismatches = [];
  const at = snapshot.block;
  const h = snapshot.house;

  if (lastApproval && lastApproval.block <= at) {
    // WETH lowers an allowance by every amount the conduit pulls, and a fill pulls its unit price.
    const after = fills.filter((f) => f.block > lastApproval.block && f.block <= at).reduce((s, f) => s + f.unitPriceWei, 0n);
    const same = fills.filter((f) => f.block === lastApproval.block).reduce((s, f) => s + f.unitPriceWei, 0n);
    const high = lastApproval.amountWei - after;
    const low = high - same; // a fill in the approval's own block may have landed after it
    if (h.allowance > high || h.allowance < low) {
      mismatches.push({ field: 'allowance', expected: low === high ? `${high}` : `${low}..${high}`, actual: `${h.allowance}` });
    }
  } else if (!lastApproval && h.allowance !== 0n) {
    mismatches.push({ field: 'allowance', expected: '0 (the house never approved)', actual: `${h.allowance}` });
  }

  if (expectedCounter !== null && expectedCounter !== undefined) {
    if (h.counter < expectedCounter || (h.counter > expectedCounter && !counterBumpPending)) {
      mismatches.push({ field: 'counter', expected: `${expectedCounter}`, actual: `${h.counter}` });
    }
  }

  if (prevWeth && prevWeth.block <= at) {
    const spent = fills.filter((f) => f.block > prevWeth.block && f.block <= at).reduce((s, f) => s + f.unitPriceWei, 0n);
    const own = ownTxs.filter((t) => t.block > prevWeth.block && t.block <= at).reduce((s, t) => s + t.wethOut, 0n);
    // More WETH than expected is funding; less is WETH that left by a path the bot does not know.
    if (h.weth < prevWeth.weth - spent - own) {
      mismatches.push({ field: 'weth', expected: `at least ${prevWeth.weth - spent - own}`, actual: `${h.weth}` });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}
