/**
 * Who trades in our pools, and how (scripts/rival-watch.mjs; owner 2026-11-13: "we will beat them
 * completely"). Every bot trade read on 11-10 (120 of 120) reached our pool program from inside the
 * bot's own program; the pool program's guard (proposal #33) refuses exactly that. A bot that
 * adapts calls our program as an instruction of its own, beside its swap on another exchange, in
 * the same transaction: 'beside' below. A user's swap calls ours alone: 'direct'.
 */

/** How a transaction reached our pool program: 'robot', 'direct', 'beside', 'inside', or null (it did not). */
export function howCalled(tx, { ours, robot, exchanges }) {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  const payer = typeof keys[0] === 'string' ? keys[0] : keys[0]?.pubkey;
  const top = (tx?.transaction?.message?.instructions ?? []).map((i) => i.programId);
  const inner = (tx?.meta?.innerInstructions ?? []).flatMap((x) => (x.instructions ?? []).map((i) => ({ parent: top[x.index], program: i.programId })));
  const oursTop = top.includes(ours);
  const oursInner = inner.filter((i) => i.program === ours && i.parent !== ours);
  if (!oursTop && !oursInner.length) return { payer, how: null, via: null };
  if (payer === robot) return { payer, how: 'robot', via: null };
  if (oursInner.length && !oursTop) return { payer, how: 'inside', via: oursInner[0].parent };
  const others = top.filter((p) => p !== ours && exchanges.has(p));
  return others.length ? { payer, how: 'beside', via: others[0] } : { payer, how: 'direct', via: null };
}

/** The payer's SOL after the transaction less before it (plain and wrapped, its fee taken), in lamports. */
export function payerSolChange(tx, payer, wsol = 'So11111111111111111111111111111111111111112') {
  const meta = tx?.meta;
  if (!meta) return 0;
  const plain = Number(meta.postBalances?.[0] ?? 0) - Number(meta.preBalances?.[0] ?? 0);
  const wrapped = (list) => (list ?? []).filter((b) => b.owner === payer && b.mint === wsol).reduce((s, b) => s + Number(b.uiTokenAmount?.amount ?? 0), 0);
  return plain + wrapped(meta.postTokenBalances) - wrapped(meta.preTokenBalances);
}

/** Whether a failed transaction was refused by our guard (SwapNotDirect, 6015 = 0x177f). */
export const refusedByGuard = (tx) => {
  const err = tx?.meta?.err;
  if (!err) return false;
  const custom = err?.InstructionError?.[1]?.Custom;
  if (custom === 6015) return true;
  return (tx?.meta?.logMessages ?? []).some((l) => /SwapNotDirect|custom program error: 0x177f/.test(l));
};

/**
 * Each payer's trades in the rows (one a transaction that reached our pools): landed and failed,
 * how each called our program, refused by the guard, and its SOL change in all; biggest take first.
 */
export function summarize(rows) {
  const by = new Map();
  for (const r of rows) {
    const s = by.get(r.payer) ?? { payer: r.payer, landed: 0, failed: 0, refusedByGuard: 0, how: {}, via: {}, lamports: 0 };
    if (r.ok) s.landed++;
    else s.failed++;
    if (r.refusedByGuard) s.refusedByGuard++;
    s.how[r.how] = (s.how[r.how] ?? 0) + 1;
    if (r.via) s.via[r.via] = (s.via[r.via] ?? 0) + 1;
    s.lamports += r.lamports;
    by.set(r.payer, s);
  }
  return [...by.values()].sort((a, b) => b.lamports - a.lamports || b.landed - a.landed);
}
