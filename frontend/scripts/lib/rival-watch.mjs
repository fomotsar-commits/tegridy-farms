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

/**
 * Programs every wallet's transaction may hold beside ours without being a bot's: the budget, the
 * system and token programs, the token-account program, memos, and Lighthouse (the site adds its
 * check to a visitor's swap). Read 2026-11-10: a visitor's transaction held only these and ours.
 */
export const PLUMBING = Object.freeze([
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95',
]);

/**
 * The wallets identified in our pools' whole history (read 2026-11-14, every transaction since the
 * first pool; reports/pool-wallet-census-2026-11-14.md), by the family each belongs to: the program
 * it trades through. Three families reached our program from inside their own, which the guard
 * (on since 2026-11-14 03:3xZ) refuses; the fourth calls it at the top level beside a Kamino loan
 * and a Jupiter route, which the guard lets through.
 */
export const KNOWN_WALLETS = Object.freeze({
  GLiCiNEnku3pQsmkVkRvnDLbfUN9BWbsrPDWLdPaADng: 'GLiCi',
  moodt1QXNtbmiheUJr9EGfch7h5mTxcWqCLyzXxWNu6: 'moodt1',
  DcQNaByvstRZCERvb9UJHgHiQe8YX2FMdPptM86psQyz: 'LiveiNLx bot 1',
  '7nwPXZNhBj88jcC22VNBQUYLohTsQWh5VGxWqnAAcvMf': 'LiveiNLx bot 2',
  DmQSnFzRoENh3weu6EtBBhHTpQBQSsvjpMX8iYKRygQ4: 'LiveiNLx bot 3',
  '29eV5LuZwwVaoufKr5ShBejYVP6N4JZ14U3M5rffXsjp': 'LiveiNLx bot 4',
  '8tWhkQfchNW6HgZv1BgABf57NHxdFiFCi7RaEgiUoKtM': 'LiveiNLx bot 5',
  Cn8LrZZnFD6qpyUY5uxJqTYKJ131U1dQLspEJqsxBn34: 'loan bot 1 (Kamino + Jupiter)',
  GWYrYHremktV7jiL6GyrG7G8M2yN1nSWm1bEiogR5sdn: 'loan bot 2 (Kamino + Jupiter)',
  // The loan bots' hub: it funded both on 2026-11-04 and takes their profits back (LOAN_BOT_HUB).
  // These two it funded on 2026-11-14 06:27Z and 06:33Z; neither had traded anywhere when read.
  Y2PRy1frYNj4UPLU2hGGHyLuw88RhzNHs94psGg2sj8: 'new wallet of the loan bots’ hub (funded 11-14)',
  FFtEX3CYqSyv3Qs2haPjNdsgYbNK4eRQDfEy7AucrPrY: 'new wallet of the loan bots’ hub (funded 11-14)',
});
/**
 * The wallet behind the loan bots: it sent Cn8LrZZn… and GWYrYHre… their first SOL on 2026-11-04
 * and receives what they make. It runs more wallets the same way against other exchanges (one
 * wallet an exchange: a Kamino loan, two swaps, the repayment). It never calls our program itself.
 */
export const LOAN_BOT_HUB = 'FQwUxowDQKwE8SbGR9RfXbHpy2PGFtE4qvpDP5wBFmVf';

/** Our pool program's instructions, by the first 8 bytes of their data in hex (Anchor: sha256("global:<name>")). */
export const OUR_INSTRUCTIONS = Object.freeze({
  '8fbe5adac41e33de': 'swap_base_input',
  '37d96256a34ab4ad': 'swap_base_output',
  f223c68952e1f2b6: 'deposit',
  b712469c946da122: 'withdraw',
  afaf6d1f0d989bed: 'initialize',
  '3f37fe4131b25979': 'initialize_with_permission',
});

/**
 * What a transaction did in our pool program, from its instructions to it (top level and inner):
 * 'swap', 'liquidity' (a deposit, a withdrawal, a new pool), or 'other'. `decode` turns an
 * instruction's base58 data into bytes.
 */
export function didInOurs(tx, ours, decode) {
  const top = tx?.transaction?.message?.instructions ?? [];
  const inner = (tx?.meta?.innerInstructions ?? []).flatMap((x) => x.instructions ?? []);
  const names = [...top, ...inner]
    .filter((i) => i.programId === ours && typeof i.data === 'string')
    .map((i) => OUR_INSTRUCTIONS[Buffer.from(decode(i.data).subarray(0, 8)).toString('hex')] ?? 'other');
  if (names.some((n) => n.startsWith('swap'))) return 'swap';
  if (names.some((n) => n === 'deposit' || n === 'withdraw' || n.startsWith('initialize'))) return 'liquidity';
  return 'other';
}

/**
 * Who a transaction that reached our pools is, by how it is built (the sentinel's reading):
 *   robot        ours
 *   bot-inside   it called our program from inside its own (the guard refuses this)
 *   bot-beside   our program at the top level, beside a program that is not plumbing: a loan, an
 *                aggregator, another exchange. The guard lets this through: it is how a bot that
 *                is not stopped by it trades (Cn8LrZZn… and GWYrYHre…, 2026-11-14)
 *   lp           a deposit, a withdrawal or a new pool, with nothing else
 *   user         a swap with ours alone: a visitor (or a bot trading in separate steps)
 * `via`: the program it came through (inside) or stood beside. Null when it did not reach ours.
 */
export function kindOf(tx, { ours, robot, exchanges, decode, plumbing = PLUMBING }) {
  const h = howCalled(tx, { ours, robot, exchanges });
  if (!h.how) return { payer: h.payer, kind: null, via: null, did: null };
  const did = didInOurs(tx, ours, decode);
  if (h.how === 'robot') return { payer: h.payer, kind: 'robot', via: null, did };
  if (h.how === 'inside') return { payer: h.payer, kind: 'bot-inside', via: h.via, did };
  const strangers = (tx?.transaction?.message?.instructions ?? []).map((i) => i.programId).filter((p) => p !== ours && !plumbing.includes(p));
  if (strangers.length && did === 'swap') return { payer: h.payer, kind: 'bot-beside', via: strangers[0], did };
  return { payer: h.payer, kind: did === 'swap' ? 'user' : 'lp', via: strangers[0] ?? null, did };
}

/**
 * The sentinel's memory of every wallet seen in our pools, with `rows` folded in (each row: payer,
 * at (s), ok, kind, via, refusedByGuard, lamports). Returns a new state; `state` is not changed.
 */
export function foldSentinel(state, rows) {
  const payers = { ...(state?.payers ?? {}) };
  for (const r of rows) {
    const was = payers[r.payer];
    const p = was ? { ...was, kinds: { ...was.kinds }, via: { ...was.via } } : { first: r.at, last: r.at, landed: 0, failed: 0, refused: 0, lamports: 0, kinds: {}, via: {} };
    p.first = Math.min(p.first, r.at);
    p.last = Math.max(p.last, r.at);
    if (r.ok) p.landed++;
    else p.failed++;
    if (r.refusedByGuard) p.refused++;
    p.lamports += r.lamports ?? 0;
    p.kinds[r.kind] = (p.kinds[r.kind] ?? 0) + 1;
    if (r.via) p.via[r.via] = (p.via[r.via] ?? 0) + 1;
    payers[r.payer] = p;
  }
  return { ...(state ?? {}), payers };
}

/** A direct trader with this many swaps in one round of rows is said to be busy: a visitor rarely is. */
export const BUSY_SWAPS = 10;

/**
 * When the pool program's guard was switched on, on both fee tiers: proposal #33, executed in slot
 * 469,178,423 (2026-11-14T03:32:44Z, getBlockTime), signature below. A trade from inside a bot's
 * program that landed before it is history, not a breach. The last such trade read landed at 03:28Z.
 */
export const GUARD_ON = Object.freeze({ at: 1_794_627_164, slot: 469_178_423, signature: '3o7uZAWTJqmLKiiVeS6VjCAX1p94o4EAgm46Q8c62sA9UQ4XPHnCbpyLYaaZPegPg6Fe8z9qjadYpSTg5Ln2Q3n8' });

/**
 * What the owner should hear of in `rows`, given the wallets known BEFORE them (`state`, as
 * foldSentinel keeps it) and the names of wallets already identified (`names`: address → name).
 * One alert a wallet a reason, worst first, each with the time (`at`, s) of the last trade it speaks of:
 *   inside-landed  a bot's trade from inside its own program LANDED after the guard went on
 *                  (`guardOnAt`): the guard is off or was passed
 *   passed-guard   a bot traded beside another program, which the guard lets through
 *   new-wallet     a wallet never seen before swapped in our pools
 *   busy           one wallet made BUSY_SWAPS or more plain swaps
 *   guard-refused  the guard refused a bot (it is still trying)
 */
export function alertsFor(state, rows, names = {}, { guardOnAt = GUARD_ON.at } = {}) {
  const known = state?.payers ?? {};
  const by = new Map();
  const later = (was, at) => (was === null || at > was ? at : was);
  for (const r of rows) {
    if (r.kind === 'robot' || !r.kind) continue;
    const s = by.get(r.payer) ?? { payer: r.payer, name: names[r.payer] ?? null, isNew: !known[r.payer], insideLanded: 0, insideAt: null, beside: 0, besideLamports: 0, besideAt: null, refused: 0, refusedAt: null, swaps: 0, swapAt: null, via: null };
    if (r.kind === 'bot-inside' && r.ok && r.at >= guardOnAt) {
      s.insideLanded++;
      s.insideAt = later(s.insideAt, r.at);
    }
    if (r.kind === 'bot-beside' && r.ok) {
      s.beside++;
      s.besideLamports += r.lamports ?? 0;
      s.besideAt = later(s.besideAt, r.at);
    }
    if (r.refusedByGuard) {
      s.refused++;
      s.refusedAt = later(s.refusedAt, r.at);
    }
    if (r.kind === 'user' && r.ok) {
      s.swaps++;
      s.swapAt = later(s.swapAt, r.at);
    }
    s.via ??= r.via ?? null;
    by.set(r.payer, s);
  }
  const out = [];
  const who = (s) => (s.name ? `${s.name} (${s.payer})` : s.payer);
  const sol = (n) => `${n >= 0 ? '+' : ''}${(n / 1e9).toFixed(6)} SOL`;
  for (const s of by.values()) {
    if (s.insideLanded) out.push({ rank: 0, why: 'inside-landed', payer: s.payer, at: s.insideAt, text: `GUARD PASSED FROM INSIDE: ${who(s)} landed ${s.insideLanded} trade(s) from inside its program ${s.via}: the guard is off, or it found a way through` });
    if (s.beside) out.push({ rank: 1, why: 'passed-guard', payer: s.payer, at: s.besideAt, text: `${s.isNew ? 'NEW bot' : 'bot'} past the guard: ${who(s)} landed ${s.beside} trade(s) beside ${s.via}, wallet change ${sol(s.besideLamports)}` });
    else if (s.isNew && s.swaps) out.push({ rank: 2, why: 'new-wallet', payer: s.payer, at: s.swapAt, text: `new wallet: ${who(s)} swapped in our pools (${s.swaps} time(s), ours alone: a visitor by its shape)` });
    if (s.swaps >= BUSY_SWAPS) out.push({ rank: 3, why: 'busy', payer: s.payer, at: s.swapAt, text: `busy: ${who(s)} made ${s.swaps} plain swaps: more than a visitor makes (a bot trading in separate steps?)` });
    if (s.refused) out.push({ rank: 4, why: 'guard-refused', payer: s.payer, at: s.refusedAt, text: `guard refused ${who(s)} ${s.refused} time(s)${s.via ? ` (from inside ${s.via})` : ''}: still trying` });
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ rank: _rank, ...a }) => a);
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
