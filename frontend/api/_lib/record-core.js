// THE BIRTH CERTIFICATE — the machine-readable twin of the per-token record page.
//
// "Locks, plates (every allocation named), fee instruction, and decimals on one record;
//  the stamp prints beneath: Every lock verifiable onchain. That route is the token's
//  birth certificate. The island reads it for enrollment, hygiene watch runs against it,
//  and certification state renders on it later. One build, four consumers."
//
// ## WHY THIS FILE IS PLAIN .js AND LIVES UNDER api/_lib
//
// Four consumers means four ways to get it wrong, so the SHAPE lives here exactly once.
// Two of those consumers are the browser (src/lib/launcher/birthRecord.ts re-exports this
// verbatim) and a Vercel serverless function (api/_lib/record.js imports it directly).
// A lambda cannot import a .ts module, and the repo's existing answer to that problem —
// a hand-written JS port with a "keep in sync" comment (see _lib/launcher-outcomes.js) —
// is exactly the fork the build directive forbids ("extend, never fork").
//
// So the RUNTIME moved to .js and the TYPES live beside it in record-core.d.ts. The
// module's public identity is unchanged: every existing import of
// `src/lib/launcher/birthRecord` still resolves, still type-checks, and now executes the
// same bytes the lambda executes.
//
// ⚠️ This file is bundled into the BROWSER as well as the lambda. It must stay pure:
// no node: imports, no process.env, no fetch, no Buffer. If it ever needs one of those,
// it has stopped being the shared core.
//
// ## The honesty rule this inherits
//
// This repo has shipped the "unreadable rendered as zero" bug twice (a scam pool priced
// at "520607 ETH"; a "+10% NFT boost" no contract paid). A birth record is worse than a
// page, because it is consumed by machines that cannot see a caveat. So every field that
// could not be read is `null` and named in `unread`, and a consumer that ignores `unread`
// is reading an incomplete record on purpose. Zero NEVER stands in for unknown.

/** Bumped when a field changes meaning. Additive fields do not bump it. */
export const BIRTH_RECORD_SCHEMA_VERSION = 1;

/** The stamp the island's standard prints beneath every record. Verbatim. */
export const BIRTH_RECORD_STAMP = 'Every lock verifiable onchain.';

/**
 * `RawTokenFacts.unreadFields` carries SOLIDITY METHOD NAMES; `BirthRecord.unread`
 * carries RECORD FIELD NAMES. They are not the same vocabulary, and piping one into the
 * other publishes `"totalSupply"` in a list a consumer reads as record fields.
 *
 * The four keys are the complete set of reads that `collectTokenFacts` passes its unread
 * Set to. `owner` maps to `residual_powers` because that is the only part of the record
 * an unread owner actually degrades.
 */
export const UNREAD_FIELD_BY_METHOD = Object.freeze({
  name: 'name',
  symbol: 'symbol',
  totalSupply: 'total_supply',
  owner: 'residual_powers',
});

/** Translate collector method names into record field names, deduped. */
export function recordUnreadFrom(methodNames) {
  const out = new Set();
  for (const m of methodNames ?? []) {
    const mapped = UNREAD_FIELD_BY_METHOD[m];
    if (mapped) out.add(mapped);
  }
  return [...out];
}

/**
 * DECIMALS, PINNED PER RAIL.
 *
 * The ETH rail is FIXED at 18: every token it creates comes from Doppler's
 * DopplerERC20V1 template, which hardcodes 18 — it is not a per-launch choice, so there
 * is nothing to snapshot and nothing that can drift.
 *
 * The CURVE rail is NOT fixed: `mint.decimals` is a launch parameter (6 by default,
 * pump.fun-style, and 6–9 is the supported band). So it must be SNAPSHOTTED from the
 * mint at create and printed on the record, and this function refuses to invent one —
 * a Solana record without a read `decimals` is incomplete, not 18 and not 6.
 *
 * ⚠️ A CALLER THAT CAN READ THE CHAIN SHOULD PREFER THE CHAIN. This function returns the
 * rail's *pinned* value, which is a statement about our own launch template — it is not a
 * statement about an arbitrary token that happens to be asked for by address. The record
 * route reads `decimals()` and lets the chain win; this is its fallback, used only when
 * provenance proves the template.
 */
export function railDecimals(chain, snapshot) {
  if (chain === 'ethereum' || chain === 'base') return 18;
  return typeof snapshot === 'number' && Number.isInteger(snapshot) && snapshot >= 0 && snapshot <= 18
    ? snapshot
    : null;
}

/**
 * Two minimal-proxy layouts we must recognise:
 *  - Canonical OZ / EIP-1167: 363d3d373d3d3d363d73 <impl> 5af43d82803e903d91602b57fd5bf3
 *  - Solady LibClone (what Doppler's token factories DEPLOY — VERIFIED on a mainnet
 *    fork 2026-07-17): 3d3d3d3d363d3d37363d73 <impl> 5af43d3d93803e602a57fd5bf3
 *
 * A launched Doppler token uses the SOLADY layout, so parsing only EIP-1167 makes every
 * real Doppler launch look unverified — which on the page means default-closed, and on
 * the birth record means the premine reads as unknown for every token we launched.
 *
 * Lives here rather than in collector.ts because both the browser collector and the
 * serverless record route must agree on what a Doppler clone is; two copies would drift
 * and the drift would be silent on one rail.
 */
const CLONE_LAYOUTS = [
  { prefix: '363d3d373d3d3d363d73', suffix: '5af43d82803e903d91602b57fd5bf3' }, // EIP-1167
  { prefix: '3d3d3d3d363d3d37363d73', suffix: '5af43d3d93803e602a57fd5bf3' }, // Solady LibClone
];

/** Extract the implementation address from a known minimal-proxy runtime, or null. */
export function cloneImplTarget(code) {
  if (!code) return null;
  const c = String(code).slice(2).toLowerCase();
  for (const { prefix, suffix } of CLONE_LAYOUTS) {
    if (c.startsWith(prefix) && c.endsWith(suffix)) {
      const middle = c.slice(prefix.length, c.length - suffix.length);
      if (middle.length === 40) return `0x${middle}`;
    }
  }
  return null;
}

/** Base units as a decimal string — never a JS number, which loses precision above 2^53. */
function toBaseUnits(whole) {
  return whole.toString();
}

/** bps of `supply` that `amount` represents. Integer, truncating, 0 when supply is 0. */
function shareBps(amount, supply) {
  return supply > 0n ? Number((amount * 10_000n) / supply) : 0;
}

/**
 * Build the record. PURE — every input is a fact somebody else already read.
 *
 * The plates are derived from the sheet rather than restated: `teamAllocationBps` and the
 * vesting schedules are already the disclosure the Fact Sheet publishes, so a record that
 * disagreed with the page would mean one of them had been edited alone.
 */
export function buildBirthRecord(input) {
  const { sheet, chain } = input;
  const unread = new Set(input.unread ?? []);

  const supply = sheet.totalSupply;
  const teamBps = sheet.teamAllocationBps;

  // THE EXACT AMOUNT WINS OVER THE BPS.
  //
  // bps is a truncating DISPLAY figure. Recomputing an amount from it — `supply * bps /
  // 10_000` — loses up to `supply/10_000 - 1` base units, and that loss does not vanish:
  // it lands in the public-sale remainder, which this record publishes with
  // `locked: false`. Chain-provably vested supply would be republished as unlocked float.
  //
  // Worse at the boundary: a premine under one basis point truncates to 0 bps, the team
  // plate disappears entirely, and the record publishes a single 10000-bps "Public sale"
  // plate — the exact fabricated full-float claim the plates suppression above exists to
  // prevent, reached by a different road.
  //
  // So callers that read a real amount pass it, and it is used verbatim.
  const exactVested = input.vestedAmount ?? null;
  const teamAmount =
    exactVested !== null && teamBps === (sheet.teamAllocationVestedBps ?? 0)
      ? exactVested
      : (supply * BigInt(teamBps)) / 10_000n;

  // How much of the team allocation is under an on-chain schedule.
  //
  // TWO SOURCES, AND THE SECOND ONE MATTERS. `sheet.vesting[]` carries the individual
  // schedules — but `collectTokenFacts` declares that array and NEVER PUSHES to it on the
  // EVM rail (collector.ts), so it is empty even for a token whose premine is provably
  // vested. `teamAllocationVestedBps` is the fact that survives: it is derived from
  // `vestedTotalAmount()`, which the Doppler template only reports for amounts that ARE
  // under a schedule.
  //
  // Reading only `sheet.vesting[]` would therefore label every premine "no on-chain
  // vesting schedule was read" with `locked: false` — publishing an UNLOCKED insider
  // slice for a token whose insider slice is locked. That is an inversion, not a gap,
  // and it is worse than saying nothing.
  const scheduledTotal = sheet.vesting.reduce((a, v) => a + v.amount, 0n);
  // Exact when the caller read one; otherwise the bps-derived approximation.
  const vestedByBps = exactVested ?? (supply * BigInt(sheet.teamAllocationVestedBps ?? 0)) / 10_000n;
  const vestedTotal = scheduledTotal > vestedByBps ? scheduledTotal : vestedByBps;
  const unvested = teamAmount > vestedTotal ? teamAmount - vestedTotal : 0n;

  // Non-sale plates first; the SALE IS THE REMAINDER, so no base unit can go missing.
  const plates = [];
  for (const v of sheet.vesting) {
    plates.push({
      name: 'Team allocation (on-chain vested)',
      amount: toBaseUnits(v.amount),
      share_bps: shareBps(v.amount, supply),
      beneficiary: v.beneficiary,
      locked: true,
    });
  }
  // Vested, but the SCHEDULE TERMS were not read. Still locked — that is the fact the
  // chain reports — but the cliff/duration are unknown, so `locks.vesting` is declared
  // unread rather than a duration being invented.
  if (scheduledTotal === 0n && vestedByBps > 0n) {
    plates.push({
      name: 'Team allocation (on-chain vested)',
      amount: toBaseUnits(vestedByBps),
      share_bps: shareBps(vestedByBps, supply),
      beneficiary: null,
      locked: true,
    });
    unread.add('locks.vesting');
  }
  // A team allocation with no schedule behind ANY of it is an unvested insider slice. It
  // is named, and it is named as unlocked — silence here would read as "there is no
  // insider allocation", which is the opposite of the truth.
  if (unvested > 0n) {
    plates.push({
      name: 'Team allocation (not under an on-chain vesting schedule)',
      amount: toBaseUnits(unvested),
      share_bps: shareBps(unvested, supply),
      beneficiary: null,
      locked: false,
    });
  }

  // THE SALE IS WHAT IS LEFT, computed from EXACT amounts and inserted first.
  //
  // Deriving it as `supply - supply*teamBps/10_000` instead would leak every truncated
  // base unit into an UNLOCKED plate. Its share is the bps remainder for the same reason:
  // the parts must sum to 10000 without any single plate having to absorb rounding.
  const allocatedAmount = plates.reduce((a, p) => a + BigInt(p.amount), 0n);
  const allocatedBps = plates.reduce((a, p) => a + p.share_bps, 0);
  const saleAmount = supply > allocatedAmount ? supply - allocatedAmount : 0n;
  if (saleAmount > 0n) {
    plates.unshift({
      name: 'Public sale',
      amount: toBaseUnits(saleAmount),
      share_bps: 10_000 - allocatedBps,
      beneficiary: null,
      locked: false,
    });
  }

  const locks = [];
  // THE LIQUIDITY LOCK.
  //
  // `liquidityReadable === false` means NOBODY QUERIED THE LOCKER. On the EVM rail that
  // is the standing state: `readMigrationStream` is inert against the V1 locker and
  // returns a hardcoded `locked: false`, which `gate.ts` then renders as the sentence
  // "Liquidity is not locked; it may be withdrawable by the liquidity owner."
  //
  // That sentence is a CLAIM. Copying it into a machine-readable record publishes an
  // assertion about a locker nobody asked. The page has its own guard for this
  // (`unverifiedGateChecks` suppresses the gate's version whenever the lock state is
  // null); this is the record's.
  // The SHEET now carries this too (LiquidityDisclosure.readable). Prefer the caller's
  // explicit answer, fall back to the sheet's, and only then assume readable — so a
  // record built from a sheet that already said "not read" cannot silently disagree
  // with it. Both undefined still means readable, which keeps every old producer working.
  const liquidityReadable = (input.liquidityReadable ?? sheet.liquidity.readable) !== false;
  if (!liquidityReadable) {
    locks.push({
      kind: 'liquidity',
      locker: null,
      amount: null,
      unlock_at: null,
      beneficiary: null,
      note: 'The liquidity lock state could not be read on this rail, so this record makes no claim about it either way.',
    });
    unread.add('locks.liquidity');
  } else {
    locks.push({
      kind: 'liquidity',
      locker: sheet.liquidity.locker ?? null,
      amount: null,
      unlock_at: sheet.liquidity.unlockAt,
      beneficiary: null,
      note: sheet.liquidity.note,
    });
    if (sheet.liquidity.unlockAt === null && !sheet.liquidity.locked) unread.add('locks.liquidity.unlock_at');
  }

  for (const v of sheet.vesting) {
    locks.push({
      kind: 'vesting',
      locker: sheet.liquidity.locker ?? null,
      amount: toBaseUnits(v.amount),
      unlock_at:
        v.cliffSeconds + v.durationSeconds > 0 ? sheet.observedAt + v.cliffSeconds + v.durationSeconds : null,
      beneficiary: v.beneficiary,
      note: `Vests over ${Math.round(v.durationSeconds / 86_400)} days${
        v.cliffSeconds > 0 ? ` after a ${Math.round(v.cliffSeconds / 86_400)}-day cliff` : ''
      }.`,
    });
  }
  if (scheduledTotal === 0n && vestedByBps > 0n) {
    locks.push({
      kind: 'vesting',
      locker: null,
      amount: toBaseUnits(vestedByBps),
      unlock_at: null,
      beneficiary: null,
      note: 'The token reports this amount as on-chain vested, but the schedule’s cliff and duration were not read.',
    });
  }

  // PLATES WE COULD NOT ENUMERATE ARE NO PLATES AT ALL.
  //
  // When the caller says the allocation breakdown is unreadable — an arbitrary token
  // whose insider holdings we cannot enumerate, or a `vestedTotalAmount()` read that
  // failed — `teamAllocationBps` is 0, and the arithmetic above therefore produces a
  // single "Public sale = 10000 bps" plate. That is not a gap, it is an ASSERTION that
  // the token is 100% float, published for a token we just admitted we cannot read.
  //
  // Emitting nothing is the honest shape: `plates: []` alongside `unread: ["plates"]`
  // reads as "not enumerated", which is true, and cannot be mistaken for "all float".
  const platesUnreadable = unread.has('plates');
  const finalPlates = platesUnreadable ? [] : plates;

  const fee_instruction = sheet.feeConstitution.map((l) => ({
    recipient: l.recipient,
    share_bps: l.shareBps,
    role: l.role,
  }));
  // An EMPTY fee instruction is a real state on this rail — the launch-time split is a
  // config input that cannot be proven for an arbitrary token, and the real one is only
  // readable from the locker after graduation. Say so rather than publishing `[]` as if
  // it meant "no fees are charged".
  if (fee_instruction.length === 0) unread.add('fee_instruction');

  const decimals = input.decimals ?? null;
  if (decimals === null) unread.add('decimals');
  if (input.birthBlock === null || input.birthBlock === undefined) unread.add('birth_block');
  if (!input.birthTx) unread.add('birth_tx');
  if (!input.gateDecisionId) unread.add('gate_decision_id');

  // An empty name/symbol and a zero supply are NOT facts — they are what a failed read
  // looks like after a default. The builder cannot tell the difference on its own, so it
  // declares them unread; a caller that genuinely read an empty string has lost nothing
  // by the record saying so.
  const name = sheet.name || null;
  const symbol = sheet.symbol || null;
  if (name === null) unread.add('name');
  if (symbol === null) unread.add('symbol');
  if (!(supply > 0n)) unread.add('total_supply');

  const creator = input.creator ? normaliseCa(input.creator, chain) : null;
  if (creator === null) unread.add('creator');

  return {
    schema_version: BIRTH_RECORD_SCHEMA_VERSION,
    ca: normaliseCa(sheet.token, chain),
    chain,
    creator,
    birth_block: input.birthBlock ?? null,
    birth_tx: input.birthTx ?? null,
    gate_decision_id: input.gateDecisionId ?? null,
    name,
    symbol,
    decimals,
    total_supply: supply > 0n ? toBaseUnits(supply) : null,
    plates: finalPlates,
    locks,
    fee_instruction,
    observed_at: sheet.observedAt,
    unread: [...unread].sort(),
    stamp: BIRTH_RECORD_STAMP,
  };
}

/**
 * EVM addresses are case-insensitive, so they are folded; Solana base58 is NOT, and
 * folding it would produce an address that does not exist. Getting this backwards
 * silently corrupts every record on one rail, so it lives in one function.
 */
export function normaliseCa(address, chain) {
  return chain === 'solana' ? String(address).trim() : String(address).trim().toLowerCase();
}

/**
 * The stable per-token route. THIS IS THE `record_url` ON THE WIRE, so it must not move:
 * the island stores it at enrollment and re-reads it later for hygiene and certification.
 *
 * Absolute, because the consumer is a server on somebody else's machine — a relative path
 * would be unresolvable to every one of the four consumers except the page itself.
 */
export function birthRecordUrl(chain, ca, origin) {
  return `${String(origin).replace(/\/+$/, '')}/record/${chain}/${normaliseCa(ca, chain)}.json`;
}

/**
 * Validate a record read back from the wire. Returns a human-readable reason, or null.
 *
 * Used by the page (to refuse to render a malformed twin) and by tests. Deliberately
 * strict about the things the island depends on and quiet about the rest.
 */
export function birthRecordFailure(payload) {
  if (!payload || typeof payload !== 'object') return 'The record is not an object.';
  const r = payload;
  if (r.schema_version !== BIRTH_RECORD_SCHEMA_VERSION) {
    return `Unsupported record schema version: ${String(r.schema_version)}`;
  }
  if (typeof r.ca !== 'string' || !r.ca) return 'The record names no contract address.';
  if (r.chain !== 'base' && r.chain !== 'ethereum' && r.chain !== 'solana') return 'The record names no known chain.';
  if (!Array.isArray(r.plates)) return 'The record has no plates.';
  if (!Array.isArray(r.locks)) return 'The record has no locks.';
  if (!Array.isArray(r.fee_instruction)) return 'The record has no fee instruction.';
  if (!Array.isArray(r.unread)) return 'The record does not say what it could not read.';
  if (r.stamp !== BIRTH_RECORD_STAMP) return 'The record is missing its stamp.';
  return null;
}
