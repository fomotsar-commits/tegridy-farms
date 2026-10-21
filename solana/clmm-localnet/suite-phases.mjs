// Phases 4 to 10 of suite.mjs: swaps, fees, the venue's share, rewards, limit orders, admin
// actions, and the checks over every transaction of the run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublicKey, SystemProgram, Keypair, spl, LAMPORTS_PER_SOL } from './lib/deps.mjs';
import { ADDR, WORK, DENY, LOCAL_TIME_LOCK } from './lib/config.mjs';
import { conn, send, ledger, clockNow, wait } from './lib/chain.mjs';
import { ix, PDA, account, events, tickAt, alignDown, arrayStart, consts } from './lib/clmm.mjs';

export async function phases(c, h) {
  const { positions, arrays, K, VAULT, BAYLA, WSOL, REWARD, M0, M1, baylaIs0, poolA, poolB, vA0, vA1, obsA, bitmapA, cfg0, S, raw, human, sqrtOf, range, SPACING, BAYLA_UNIT, known } = c;
  const { check, phaseDone, must, mustVault, vaultRun, measure, tok, sol, errName, failedWith, fmt, reg, ata, ataIx, prog, mut, pool, liqIx } = h;
  const { alice, bob, carol, dave, erin, mallory } = K;
  const vaultOf = (m) => (m.equals(M0) ? vA0 : vA1);
  const other = (m) => (m.equals(M0) ? M1 : M0);
  const priceHuman = (p) => human(Number(p.sqrt_price_x64) ** 2 / 2 ** 128);
  const span = SPACING * consts.TICK_ARRAY_SIZE;
  const U64MAX = (1n << 64n) - 1n;

  async function swapIx(trader, inMint, { amount, threshold = 0n, limitHuman = null, baseIn = true }) {
    const outMint = other(inMint);
    const zeroForOne = inMint.equals(M0);
    const p = await pool();
    const cur = arrayStart(p.tick_current, SPACING);
    const existing = [];
    for (const s of [...arrays]) if (await conn.getAccountInfo(PDA.tickArray(poolA, s))) existing.push(s);
    const ordered = zeroForOne ? existing.filter((s) => s <= cur).sort((a, b) => b - a) : existing.filter((s) => s >= cur).sort((a, b) => a - b);
    return ix('swap_v2', {
      payer: trader.publicKey, amm_config: cfg0, pool_state: poolA, input_token_account: ata(trader.publicKey, inMint), output_token_account: ata(trader.publicKey, outMint),
      input_vault: vaultOf(inMint), output_vault: vaultOf(outMint), observation_state: obsA, input_vault_mint: inMint, output_vault_mint: outMint,
    }, { amount, other_amount_threshold: threshold, sqrt_price_limit_x64: limitHuman ? sqrtOf(limitHuman) : 0n, is_base_input: baseIn },
    [{ pubkey: bitmapA }, ...ordered.map((s) => ({ pubkey: PDA.tickArray(poolA, s) }))]);
  }
  const paidIn = { [BAYLA.toBase58()]: 0n, [WSOL.toBase58()]: 0n };
  async function swap(label, trader, inMint, opts, { expectFail = false, extra = [] } = {}) {
    const outMint = other(inMint);
    const before = { p: await pool(), i: await tok(ata(trader.publicKey, inMint)), o: await tok(ata(trader.publicKey, outMint)), vi: await tok(vaultOf(inMint)), vo: await tok(vaultOf(outMint)) };
    const r = await send(label, [await swapIx(trader, inMint, opts), ...extra], [trader], { expectFail });
    const p = await pool();
    const res = {
      r, before: before.p, after: p,
      paid: before.i - (await tok(ata(trader.publicKey, inMint))), got: (await tok(ata(trader.publicKey, outMint))) - before.o,
      vaultIn: (await tok(vaultOf(inMint))) - before.vi, vaultOut: before.vo - (await tok(vaultOf(outMint))),
      proto: inMint.equals(M0) ? p.protocol_fees_token_0 - before.p.protocol_fees_token_0 : p.protocol_fees_token_1 - before.p.protocol_fees_token_1,
      fund: inMint.equals(M0) ? p.fund_fees_token_0 - before.p.fund_fees_token_0 : p.fund_fees_token_1 - before.p.fund_fees_token_1,
      crossed: Math.abs(arrayStart(p.tick_current, SPACING) - arrayStart(before.p.tick_current, SPACING)) / span,
    };
    if (r.ok) paidIn[inMint.toBase58()] += res.paid;
    return res;
  }
  const share = (x, paid) => Number(x) / Number(paid);
  const near = (x, want) => Math.abs(x - want) / want < 0.005;

  // ===========================================================================================
  // Phase 4: swaps through the ranges, both ways, across tick arrays.
  // ===========================================================================================
  {
    let limit = S * 2.2;
    if (mut('W1')) {
      // Halfway from the current tick to the edge of its tick array, in the direction of the buy.
      const t = (await pool()).tick_current;
      const edge = baylaIs0 ? arrayStart(t, SPACING) + span : arrayStart(t, SPACING);
      limit = human(1.0001 ** ((t + edge) / 2));
    }
    const extra = mut('W2') ? [spl.createTransferCheckedInstruction(ata(dave.publicKey, WSOL), WSOL, ata(bob.publicKey, WSOL), dave.publicKey, 1n, 9, [], ADDR.token)] : [];
    const s = await swap('dave buys BAYLA with SOL, up through two ranges', dave, WSOL, { amount: 150n * 10n ** 9n, limitHuman: limit }, { extra });
    if (!s.r.ok) console.log(s.r.logs.join('\n'));
    check('W1', 'swap_v2', 'a buy moves the price up into the BAYLA-only range and across into another tick array',
      s.r.ok && s.crossed >= 1 && priceHuman(s.after) > priceHuman(s.before) && priceHuman(s.after) > S * 1.3,
      `${priceHuman(s.before).toExponential(4)} -> ${priceHuman(s.after).toExponential(4)} SOL per BAYLA, ${s.crossed} array boundary crossed, ${s.r.cu} CU`);
    check('W2', 'swap_v2', "the trader's coins and the pool's vaults move by exactly the same amounts", s.paid === s.vaultIn && s.got === s.vaultOut && s.paid > 0n && s.got > 0n,
      `paid ${fmt(s.paid, 9)} SOL, got ${fmt(s.got, 6)} BAYLA`);
    const sh = share(s.proto, s.paid); const fh = share(s.fund, s.paid);
    check('W3', 'swap_v2', "of a 1% swap, 0.104% of what the trader paid waits for the venue and 0.056% for the island", near(sh, 0.00104) && near(fh, 0.00056),
      `venue ${fmt(s.proto, 9)} SOL (${(sh * 100).toFixed(5)}%), island ${fmt(s.fund, 9)} SOL (${(fh * 100).toFixed(5)}%) of ${fmt(s.paid, 9)} SOL`);
  }
  {
    const all = await tok(ata(dave.publicKey, BAYLA));
    const s = await swap('dave sells BAYLA for SOL, down through every range', dave, BAYLA, { amount: all, limitHuman: mut('W4') ? S * 0.95 : S / 2 });
    if (!s.r.ok) console.log(s.r.logs.join('\n'));
    const t = s.after.tick_current;
    const inCarol = positions.carol.lower <= t && t < positions.carol.upper;
    check('W4', 'swap_v2', 'a sell moves the price the other way, across several tick arrays, into the SOL-only range', s.r.ok && s.crossed >= 2 && priceHuman(s.after) < priceHuman(s.before) && inCarol,
      `${priceHuman(s.before).toExponential(4)} -> ${priceHuman(s.after).toExponential(4)}, ${s.crossed} boundaries, ${s.r.cu} CU`);
    const sh = share(s.proto, s.paid); const fh = share(s.fund, s.paid);
    check('W5', 'swap_v2', 'the same split in the other coin', s.paid === s.vaultIn && s.got === s.vaultOut && near(sh, 0.00104) && near(fh, 0.00056),
      `venue ${fmt(s.proto, 6)} BAYLA (${(sh * 100).toFixed(5)}%), island ${fmt(s.fund, 6)} BAYLA (${(fh * 100).toFixed(5)}%)`);
  }
  {
    const want = 100_000n * BAYLA_UNIT;
    const s = await swap('dave buys exactly 100,000 BAYLA', dave, WSOL, { amount: want, threshold: mut('W6') ? 0n : 10n * 10n ** 9n, baseIn: !!mut('W6') });
    check('W6', 'swap_v2', 'an exact-output buy delivers exactly what was asked, for no more than the cap', s.r.ok && s.got === want && s.paid <= 10n * 10n ** 9n,
      `got ${fmt(s.got, 6)} BAYLA for ${fmt(s.paid, 9)} SOL`);
  }
  {
    const s = await swap('dave sells 1,000 BAYLA asking 10 SOL', dave, BAYLA, { amount: 1_000n * BAYLA_UNIT, threshold: mut('W7') ? 0n : 10n * 10n ** 9n }, { expectFail: true });
    check('W7', 'swap_v2', 'a swap that would pay less than the trader asked is refused and moves nothing', failedWith(s.r, 'TooLittleOutputReceived') && s.paid === 0n, `refused: ${errName(s.r)}`);
  }
  phaseDone('phase4');

  // ===========================================================================================
  // Phase 5: each position collects its own fees, without withdrawing.
  // ===========================================================================================
  const rewardGroups = async (owner) => {
    const p = await pool();
    const out = [];
    for (const r of p.reward_infos) {
      if (r.token_mint.equals(PublicKey.default)) continue;
      out.push({ pubkey: r.token_vault }, { pubkey: ata(owner.publicKey, r.token_mint) }, { pubkey: r.token_mint, isWritable: false });
    }
    return out;
  };
  async function collect(key, label = 'collect') {
    const p = positions[key];
    const o = p.owner.publicKey;
    const b = { b: await tok(ata(o, BAYLA)), s: await tok(ata(o, WSOL)), r: await tok(ata(o, REWARD)) };
    const l0 = (await account('PersonalPositionState', p.pos)).liquidity;
    const r = await must(`${key}: ${label}`, [liqIx('decrease_liquidity_v2', key, { liquidity: 0n, amount_0_min: 0n, amount_1_min: 0n }, await rewardGroups(p.owner))], [p.owner]);
    const l1 = (await account('PersonalPositionState', p.pos)).liquidity;
    return { r, bayla: (await tok(ata(o, BAYLA))) - b.b, sol: (await tok(ata(o, WSOL))) - b.s, reward: (await tok(ata(o, REWARD))) - b.r, same: l0 === l1 };
  }
  const fees = {};
  for (const [m, k] of [['F1', 'alice'], ['F2', 'bob'], ['F3', 'carol']]) if (mut(m)) await collect(k, 'mutant: collect first');
  for (const k of ['alice', 'bob', 'carol', 'dave', 'erin-nometa']) fees[k] = await collect(k, 'collect fees, keep the position');
  check('F1', 'decrease_liquidity_v2 (0)', 'the wide range collects fees in both coins and keeps its liquidity', fees.alice.bayla > 0n && fees.alice.sol > 0n && fees.alice.same,
    `${fmt(fees.alice.bayla, 6)} BAYLA + ${fmt(fees.alice.sol, 9)} SOL`);
  check('F2', 'decrease_liquidity_v2 (0)', 'the BAYLA-only range, which both swaps passed, earned fees in both coins', fees.bob.sol > 0n && fees.bob.bayla > 0n && fees.bob.same,
    `${fmt(fees.bob.bayla, 6)} BAYLA + ${fmt(fees.bob.sol, 9)} SOL`);
  check('F3', 'decrease_liquidity_v2 (0)', 'the SOL-only range earned BAYLA fees from the sell that reached it', fees.carol.bayla > 0n && fees.carol.same, `${fmt(fees.carol.bayla, 6)} BAYLA + ${fmt(fees.carol.sol, 9)} SOL`);
  check('F4', 'decrease_liquidity_v2 (0)', 'a range no swap reached earned nothing', fees.dave.bayla === 0n && fees.dave.sol === 0n, `${fees.dave.bayla} + ${fees.dave.sol} base units`);
  {
    const p = await pool();
    const lp = { b: Object.values(fees).reduce((s, f) => s + f.bayla, 0n), s: Object.values(fees).reduce((s, f) => s + f.sol, 0n) };
    const [protoB, protoS] = baylaIs0 ? [p.protocol_fees_token_0, p.protocol_fees_token_1] : [p.protocol_fees_token_1, p.protocol_fees_token_0];
    const [fundB, fundS] = baylaIs0 ? [p.fund_fees_token_0, p.fund_fees_token_1] : [p.fund_fees_token_1, p.fund_fees_token_0];
    const parts = (l, pr, fu, paid) => { const t = l + pr + fu; return { lp: Number(l) / Number(t), venue: Number(pr) / Number(t), island: Number(fu) / Number(t), fee: Number(t) / Number(paid) }; };
    const b = parts(lp.b, protoB, fundB, paidIn[BAYLA.toBase58()]); const so = parts(lp.s, protoS, fundS, paidIn[WSOL.toBase58()]);
    const pct = (x) => (x * 100).toFixed(3) + '%';
    check('F5', 'swap_v2 + decrease_liquidity_v2', 'of every fee the LPs collected 84%, 10.4% waits for the venue and 5.6% for the island; together they are 1% of what traders paid',
      [b, so].every((x) => x.lp > 0.8395 && x.lp <= 0.8401 && near(x.venue, 0.104) && near(x.island, 0.056) && near(x.fee, 0.01)),
      `BAYLA: LPs ${pct(b.lp)}, venue ${pct(b.venue)}, island ${pct(b.island)}; SOL: LPs ${pct(so.lp)}, venue ${pct(so.venue)}, island ${pct(so.island)}; fee ${pct(b.fee)} and ${pct(so.fee)} of input`);
  }
  phaseDone('phase5');

  // ===========================================================================================
  // Phase 6: the venue's share: only the vault can collect it.
  // ===========================================================================================
  const feeIx = (name, owner, r0, r1, amount = U64MAX) => ix(name, {
    owner, pool_state: poolA, amm_config: cfg0, token_vault_0: vA0, token_vault_1: vA1, vault_0_mint: M0, vault_1_mint: M1,
    recipient_token_account_0: r0, recipient_token_account_1: r1,
  }, { amount_0_requested: amount, amount_1_requested: amount });
  {
    const m0 = ata(mallory.publicKey, M0); const m1 = ata(mallory.publicKey, M1);
    const r = mut('V1') ? (await vaultRun('V1 mutant: the vault collects', [feeIx('collect_protocol_fee', VAULT, m0, m1)])).execute
      : await send('a stranger collects the protocol fee', [feeIx('collect_protocol_fee', mallory.publicKey, m0, m1)], [mallory], { expectFail: true });
    check('V1', 'collect_protocol_fee', "a stranger cannot collect the venue's share", failedWith(r, 'NotApproved'), `refused: ${errName(r)}`);
  }
  {
    const p0 = await pool();
    const dest = mut('V3') ? mallory.publicKey : VAULT;
    const r0 = ata(dest, M0); const r1 = ata(dest, M1);
    const b = [await tok(r0), await tok(r1)];
    const r = await mustVault("vault collects the venue's share", [feeIx('collect_protocol_fee', VAULT, r0, r1, mut('V2') ? 1n : U64MAX)]);
    const p1 = await pool();
    const got = [(await tok(r0)) - b[0], (await tok(r1)) - b[1]];
    check('V2', 'collect_protocol_fee', "the vault collects exactly the venue's share that built up, and the pool's count goes to zero",
      got[0] === p0.protocol_fees_token_0 && got[1] === p0.protocol_fees_token_1 && p1.protocol_fees_token_0 === 0n && p1.protocol_fees_token_1 === 0n && got[0] > 0n && got[1] > 0n,
      `${fmt(baylaIs0 ? got[0] : got[1], 6)} BAYLA + ${fmt(baylaIs0 ? got[1] : got[0], 9)} SOL, proposal ${r.index}`);
    const owners = [];
    for (const a of [r0, r1]) owners.push(spl.unpackAccount(a, await conn.getAccountInfo(a), (await conn.getAccountInfo(a)).owner).owner);
    check('V3', 'collect_protocol_fee', "the venue's share landed in token accounts the vault owns", owners.every((o) => o.equals(VAULT)), [...new Set(owners.map((o) => o.toBase58()))].join(', '));
  }
  {
    // The Workshop's own signature cannot be made here, so a local key stands in for it in the
    // fund-owner role. Pointing the tier at it, and back, is itself the admin's re-point path.
    const standIn = K.workshopStandIn;
    await mustVault("vault points tier 0's fund owner at a stand-in for the Workshop", [ix('update_amm_config', { owner: VAULT, amm_config: cfg0 }, { param: 4, value: 0 }, [{ pubkey: mut('V6') ? c.WORKSHOP : standIn.publicKey, isWritable: false }])]);
    const moved = (await account('AmmConfig', cfg0)).fund_owner.equals(standIn.publicKey);
    check('V6', 'update_amm_config (param 4)', "the vault can point a tier's fund share at any account, at any time (an admin path over the island's share)", moved, 'fund owner re-pointed by one vault proposal');
    for (const m of [M0, M1]) await must('stand-in token account', [ataIx(standIn.publicKey, standIn.publicKey, m)], [standIn]);
    {
      // Its broken input is the fund owner itself, who may collect.
      const who = mut('V5') ? standIn : mallory;
      const m = await send("a stranger collects the island's share", [feeIx('collect_fund_fee', who.publicKey, ata(who.publicKey, M0), ata(who.publicKey, M1))], [who], { expectFail: !mut('V5') });
      check('V5', 'collect_fund_fee', "a stranger cannot collect the island's share", failedWith(m, 'NotApproved'), `refused: ${errName(m)}`);
    }
    const p0 = await pool();
    const r0 = ata(standIn.publicKey, M0); const r1 = ata(standIn.publicKey, M1);
    const b = [await tok(r0), await tok(r1)];
    const who = mut('V7') ? mallory : standIn;
    const r = await send("the fund owner collects the island's share", [feeIx('collect_fund_fee', who.publicKey, r0, r1)], [who]);
    const got = [(await tok(r0)) - b[0], (await tok(r1)) - b[1]];
    const p1 = await pool();
    check('V7', 'collect_fund_fee', "the fund owner collects exactly the island's share that built up, into its own accounts",
      r.ok && got[0] === p0.fund_fees_token_0 && got[1] === p0.fund_fees_token_1 && got[0] > 0n && got[1] > 0n && p1.fund_fees_token_0 === 0n && p1.fund_fees_token_1 === 0n,
      r.ok ? `${fmt(baylaIs0 ? got[0] : got[1], 6)} BAYLA + ${fmt(baylaIs0 ? got[1] : got[0], 9)} SOL` : `refused: ${errName(r)}`);
    if (!mut('V8')) await mustVault("vault points tier 0's fund owner back at the Workshop", [ix('update_amm_config', { owner: VAULT, amm_config: cfg0 }, { param: 4, value: 0 }, [{ pubkey: c.WORKSHOP, isWritable: false }])]);
    check('V8', 'update_amm_config (param 4)', "tier 0's fund owner is the Workshop again", (await account('AmmConfig', cfg0)).fund_owner.equals(c.WORKSHOP), '');
  }
  phaseDone('phase6');

  // ===========================================================================================
  // Phase 7: rewards, paid by the vault and by the pool's opener; the whole life of one stream.
  // ===========================================================================================
  for (const k of [bob, carol, dave, erin]) await must('REWARD account for ' + h.names.get(k.publicKey.toBase58()), [ataIx(k.publicKey, k.publicKey, REWARD)], [k]);
  const op = reg(PDA.operation(), 'operation account');
  if (!mut('R1')) await mustVault('vault creates the operation account', [ix('create_operation_account', { owner: VAULT, operation_state: op })]);
  check('R1', 'create_operation_account', 'the vault creates the operation account rewards need', !!(await conn.getAccountInfo(op)), '');
  await measure('operation account (OperationState)', op, 'vault');
  const rv0 = reg(PDA.rewardVault(poolA, BAYLA), 'pool A reward vault BAYLA');
  const rv1 = reg(PDA.rewardVault(poolA, REWARD), 'pool A reward vault REWARD');
  const initReward = (funder, mint, rv, open, end, perSecond) => ix('initialize_reward', {
    reward_funder: funder, funder_token_account: ata(funder, mint), amm_config: cfg0, pool_state: poolA, operation_state: op,
    reward_token_mint: mint, reward_token_vault: rv, reward_token_program: prog(mint),
  }, { param: { open_time: BigInt(open), end_time: BigInt(end), emissions_per_second_x64: BigInt(perSecond) << 64n } });
  const WEEK = 7 * 24 * 3600;
  {
    const now = await clockNow();
    const b = await tok(ata(VAULT, BAYLA));
    await mustVault('vault sets up a BAYLA reward for 7 days', [initReward(VAULT, BAYLA, rv0, now + 150, now + 150 + WEEK, mut('R2') ? 500_000 : 1_000_000)]);
    const p = await pool();
    const paid = b - (await tok(ata(VAULT, BAYLA)));
    check('R2', 'initialize_reward', 'the vault funds a 1 BAYLA a second reward for 7 days: exactly 604,800 BAYLA leave the vault for the reward vault',
      paid === BigInt(WEEK) * BAYLA_UNIT && (await tok(rv0)) === paid && p.reward_infos[0].token_mint.equals(BAYLA) && p.reward_infos[0].authority.equals(VAULT), `${fmt(paid, 6)} BAYLA`);
    await measure('reward vault (Token-2022, BAYLA)', rv0, 'reward funder');
  }
  {
    const who = mut('R3') ? alice : mallory;
    const now = await clockNow();
    const r = await send('a stranger sets up a reward', [initReward(who.publicKey, REWARD, rv1, now + 30, now + 30 + WEEK, 500_000)], [who], { expectFail: true });
    check('R3', 'initialize_reward', 'a stranger cannot set up a reward on the pool', failedWith(r, 'NotApproved'), `refused: ${errName(r)}`);
  }
  {
    const now = await clockNow();
    const b = await tok(ata(alice.publicKey, REWARD));
    await must('alice (the opener) sets up a REWARD reward', [initReward(alice.publicKey, REWARD, rv1, now + 20, now + 20 + WEEK, mut('R4') ? 250_000 : 500_000)], [alice]);
    const paid = b - (await tok(ata(alice.publicKey, REWARD)));
    check('R4', 'initialize_reward', "the pool's opener funds a second reward from her own coins", paid === BigInt(WEEK) * 500_000n && (await tok(rv1)) === paid, `${fmt(paid, 6)} REWARD`);
    await measure('reward vault (SPL Token, REWARD)', rv1, 'reward funder');
  }
  let window;
  {
    const now = await clockNow();
    const open = now + LOCAL_TIME_LOCK + 25; const end = open + (mut('R5') ? 100 : 90);
    const b = await tok(ata(VAULT, BAYLA));
    await mustVault('vault resets the BAYLA reward to a 90 s window before it opens', [ix('set_reward_params', {
      authority: VAULT, amm_config: cfg0, pool_state: poolA, operation_state: op,
    }, { reward_index: 0, emissions_per_second_x64: 1_000_000n << 64n, open_time: BigInt(open), end_time: BigInt(end) },
    [{ pubkey: rv0 }, { pubkey: ata(VAULT, BAYLA) }, { pubkey: BAYLA, isWritable: false }])]);
    const ri = (await pool()).reward_infos[0];
    const paid = b - (await tok(ata(VAULT, BAYLA)));
    window = { open, end };
    check('R5', 'set_reward_params', 'before a reward opens, the vault can move its window (here to 90 s, paying 90 BAYLA more)', Number(ri.open_time) === open && Number(ri.end_time) === end && paid === 90n * BAYLA_UNIT,
      `window ${open}..${end}, paid ${fmt(paid, 6)} BAYLA`);
  }
  if (!mut('R7A')) while ((await clockNow()) < window.open + 30) await wait(1000);
  {
    const r = await send('a stranger updates the reward counters', [ix('update_reward_infos', { pool_state: mut('R6') ? obsA : poolA })], [mallory]);
    check('R6', 'update_reward_infos', 'anyone can bring the reward counters up to date', r.ok, `${r.cu} CU`);
  }
  const claimed = { bayla: 0n };
  {
    const a = await collect('alice', 'collect rewards');
    claimed.bayla += a.bayla;
    const elapsed = (await clockNow()) - window.open;
    check('R7A', 'decrease_liquidity_v2 (rewards)', 'an LP in range collects both rewards, no more than the stream paid so far', a.bayla > 0n && a.bayla <= BigInt(elapsed) * BAYLA_UNIT && a.reward > 0n,
      `${fmt(a.bayla, 6)} BAYLA after ${elapsed} s, ${fmt(a.reward, 6)} REWARD`);
    const d = await collect('dave', 'collect rewards');
    claimed.bayla += d.bayla;
    check('R7', 'decrease_liquidity_v2 (rewards)', 'a position out of range earns no reward', d.bayla === 0n && d.reward === 0n, `${d.bayla} + ${d.reward} base units`);
  }
  while ((await clockNow()) < window.end + 3) await wait(1000);
  await must('update the reward counters after the end', [ix('update_reward_infos', { pool_state: poolA })], [mallory]);
  for (const k of ['alice', 'bob', 'carol', 'dave', 'erin-nometa'].filter((k) => !(mut('R8') && k === 'alice'))) claimed.bayla += (await collect(k, 'collect rewards after the end')).bayla;
  {
    const ri = (await pool()).reward_infos[0];
    const emitted = ri.reward_total_emitted;
    check('R8', 'decrease_liquidity_v2 (rewards)', 'over the whole window the LPs together collect what the stream emitted (90 BAYLA), never more',
      claimed.bayla <= emitted && Number(claimed.bayla) >= 0.999 * Number(emitted) && emitted === 90n * BAYLA_UNIT, `${fmt(claimed.bayla, 6)} of ${fmt(emitted, 6)} BAYLA`);
    const remIx = (funder, mint, rv, idx) => ix('collect_remaining_rewards', { reward_funder: funder, funder_token_account: ata(funder, mint), pool_state: poolA, reward_token_vault: rv, reward_vault_mint: mint }, { reward_index: idx });
    const inVault = await tok(rv0);
    const b = await tok(ata(VAULT, BAYLA));
    const rr = await vaultRun('vault takes back what the ended reward did not pay', [mut('R9') ? remIx(VAULT, REWARD, rv1, 1) : remIx(VAULT, BAYLA, rv0, 0)]);
    const back = (await tok(ata(VAULT, BAYLA))) - b;
    const want = inVault - (ri.reward_total_emitted - ri.reward_claimed);
    check('R9', 'collect_remaining_rewards', 'after the end the vault takes back everything the stream did not owe', rr.executed && back === want && back >= BigInt(WEEK) * BAYLA_UNIT, rr.executed ? `${fmt(back, 6)} BAYLA back` : `refused: ${errName(rr.execute)}`);
    const r = mut('R10') ? (await vaultRun('R10 mutant: the ended stream again', [remIx(VAULT, BAYLA, rv0, 0)])).execute
      : await send('alice takes back a reward still running', [remIx(alice.publicKey, REWARD, rv1, 1)], [alice], { expectFail: true });
    check('R10', 'collect_remaining_rewards', 'a reward still running cannot be taken back', failedWith(r, 'NotApproved'), `refused: ${errName(r)}`);
  }
  {
    const tr = (authority, to = bob.publicKey) => ix('transfer_reward_owner', { authority, pool_state: poolB }, { new_owner: to });
    const m = mut('R12') ? (await vaultRun('R12 mutant: vault', [tr(VAULT)])).execute : await send('a stranger takes a pool over', [tr(mallory.publicKey)], [mallory], { expectFail: true });
    check('R12', 'transfer_reward_owner', "a stranger cannot take over a pool's rewards", failedWith(m, 'NotApproved'), `refused: ${errName(m)}`);
    // A reward on pool B funded by alice, its opener; before it opens the vault moves it to a
    // short window (paying that window itself), then hands the pool to bob.
    const rvB = reg(PDA.rewardVault(poolB, REWARD), 'pool B reward vault REWARD');
    let now = await clockNow();
    await must('alice funds a REWARD reward on pool B', [ix('initialize_reward', {
      reward_funder: alice.publicKey, funder_token_account: ata(alice.publicKey, REWARD), amm_config: c.cfg1, pool_state: poolB, operation_state: op,
      reward_token_mint: REWARD, reward_token_vault: rvB, reward_token_program: prog(REWARD),
    }, { param: { open_time: BigInt(now + 3600), end_time: BigInt(now + 3600 + WEEK), emissions_per_second_x64: 1_000n << 64n } })], [alice]);
    const alicePaid = await tok(rvB);
    await must("the vault's REWARD, to pay a short window", [ataIx(K.rewardMintAuthority.publicKey, VAULT, REWARD),
      spl.createMintToInstruction(REWARD, ata(VAULT, REWARD), K.rewardMintAuthority.publicKey, 1_000_000n, [], ADDR.token)], [K.rewardMintAuthority]);
    now = await clockNow();
    const winB = { open: now + LOCAL_TIME_LOCK + 25 }; winB.end = winB.open + 30;
    const vaultBefore = await tok(ata(VAULT, REWARD));
    await mustVault("vault moves pool B's reward to a 30 s window", [ix('set_reward_params', { authority: VAULT, amm_config: c.cfg1, pool_state: poolB, operation_state: op },
      { reward_index: 0, emissions_per_second_x64: 1_000n << 64n, open_time: BigInt(winB.open), end_time: BigInt(winB.end) },
      [{ pubkey: rvB }, { pubkey: ata(VAULT, REWARD) }, { pubkey: REWARD, isWritable: false }])]);
    const vaultPaid = vaultBefore - (await tok(ata(VAULT, REWARD)));
    const before = (await account('PoolState', poolB)).reward_infos.map((r) => r.authority.toBase58());
    await mustVault('vault hands pool B to bob', [tr(VAULT, mut('R11') ? carol.publicKey : bob.publicKey)]);
    const pb = await account('PoolState', poolB);
    check('R11', 'transfer_reward_owner', "the vault can hand a pool to someone else, and each reward's authority stays with whoever funded it",
      pb.owner.equals(bob.publicKey) && pb.reward_infos[0].authority.equals(alice.publicKey) && pb.reward_infos.every((r, i) => r.authority.toBase58() === before[i]),
      `pool B owner ${h.names.get(pb.owner.toBase58()) ?? pb.owner.toBase58()}, reward authority ${h.names.get(pb.reward_infos[0].authority.toBase58()) ?? pb.reward_infos[0].authority.toBase58()}`);
    while ((await clockNow()) < winB.end + 3) await wait(1000);
    await must('update pool B reward counters after its end', [ix('update_reward_infos', { pool_state: poolB })], [mallory]);
    const remB = (k) => ix('collect_remaining_rewards', { reward_funder: k.publicKey, funder_token_account: ata(k.publicKey, REWARD), pool_state: poolB, reward_token_vault: rvB, reward_vault_mint: REWARD }, { reward_index: 0 });
    {
      const who = mut('R13') ? alice : bob;
      const r = await send("pool B's new owner takes back the reward's unpaid rest", [remB(who)], [who], { expectFail: !mut('R13') });
      // Two key checks can fire there; the authority's logs alice's key as its Right value.
      const authorityFired = (r.logs ?? []).join(' ').includes(alice.publicKey.toBase58());
      check('R13', 'collect_remaining_rewards', "a pool's new owner cannot take back the unpaid rest of a reward someone else funded", failedWith(r, 'RequireKeysEqViolated') && authorityFired,
        `refused: ${errName(r)}${authorityFired ? " (the reward is alice's)" : ''}`);
    }
    {
      const who = mut('R14') ? bob : alice;
      const ri = (await account('PoolState', poolB)).reward_infos[0];
      const inVault = await tok(rvB); const b0 = await tok(ata(who.publicKey, REWARD));
      const r = await send("alice takes back her reward's unpaid rest", [remB(who)], [who], { expectFail: mut('R14') });
      const back = (await tok(ata(who.publicKey, REWARD))) - b0;
      const want = inVault - (ri.reward_total_emitted - ri.reward_claimed);
      check('R14', 'collect_remaining_rewards', "after the end, the funder takes back the unpaid rest of her reward, whoever owns the pool now, and with it what the vault paid in to move the window: a top-up of someone else's reward goes to its funder",
        r.ok && back === want && back === alicePaid + vaultPaid && vaultPaid > 0n && ri.reward_total_emitted === ri.reward_claimed,
        r.ok ? `${fmt(back, 6)} REWARD back to ${h.names.get(who.publicKey.toBase58())}: ${fmt(alicePaid, 6)} hers, ${fmt(vaultPaid, 6)} the vault's` : `refused: ${errName(r)}`);
    }
  }
  phaseDone('phase7');

  // ===========================================================================================
  // Phase 8: a limit order, filled by a swap, settled and closed by the keeper (the vault).
  // ===========================================================================================
  const zeroForOne = baylaIs0; // selling BAYLA
  const orderTick = alignDown(tickAt(raw(S * 0.6)), SPACING) + (zeroForOne ? SPACING : 0);
  const orderArray = arrayStart(orderTick, SPACING);
  arrays.add(orderArray);
  reg(PDA.tickArray(poolA, orderArray), `pool A tick array ${orderArray}`);
  const nonce = reg(PDA.limitNonce(erin.publicKey, 0), 'erin order nonce');
  const order0 = reg(PDA.limitOrder(erin.publicKey, nonce, 0), 'erin order 0');
  const order1 = reg(PDA.limitOrder(erin.publicKey, nonce, 1), 'erin order 1');
  const inV = vaultOf(BAYLA); const outV = vaultOf(WSOL);
  const openOrderIx = (order, tick, amount) => ix('open_limit_order', {
    payer: erin.publicKey, pool_state: poolA, tick_array: PDA.tickArray(poolA, arrayStart(tick, SPACING)), limit_order_nonce: nonce, limit_order: order,
    input_token_account: ata(erin.publicKey, BAYLA), output_token_account: ata(erin.publicKey, WSOL), input_vault: inV, output_vault: outV,
    input_vault_mint: BAYLA, output_vault_mint: WSOL, input_token_program: prog(BAYLA),
  }, { nonce_index: 0, zero_for_one: zeroForOne, tick_index: tick, amount });
  const decOrderIx = (order, tick, amount) => ix('decrease_limit_order', {
    owner: erin.publicKey, pool_state: poolA, tick_array: PDA.tickArray(poolA, arrayStart(tick, SPACING)), limit_order: order, input_token_account: ata(erin.publicKey, BAYLA),
    output_token_account: ata(erin.publicKey, WSOL), input_vault: inV, output_vault: outV, input_vault_mint: BAYLA, output_vault_mint: WSOL,
  }, { amount, amount_min: 0n });
  const settleIx = (signer, dest) => ix('settle_limit_order', {
    signer, pool_state: poolA, tick_array: PDA.tickArray(poolA, orderArray), limit_order: order0, output_token_account: dest, output_vault: outV, output_vault_mint: WSOL, output_token_program: prog(WSOL),
  });
  {
    const b = await tok(ata(erin.publicKey, BAYLA)); const v = await tok(inV);
    await must('erin places a limit order: sell 1,000,000 BAYLA at 0.6x today', [openOrderIx(order0, orderTick, mut('O1') ? 999_999n * BAYLA_UNIT : 1_000_000n * BAYLA_UNIT)], [erin]);
    const o = await account('LimitOrderState', order0);
    check('O1', 'open_limit_order', 'the order takes exactly its BAYLA into the pool and records owner, price and side',
      b - (await tok(ata(erin.publicKey, BAYLA))) === 1_000_000n * BAYLA_UNIT && (await tok(inV)) - v === 1_000_000n * BAYLA_UNIT && o.owner.equals(erin.publicKey) && o.tick_index === orderTick && o.total_amount === 1_000_000n * BAYLA_UNIT,
      `tick ${orderTick} (${human(1.0001 ** orderTick).toExponential(4)} SOL per BAYLA)`);
    await measure('limit order (LimitOrderState)', order0, 'order owner');
    await measure('limit order nonce (LimitOrderNonce)', nonce, 'order owner');
  }
  {
    await must('erin adds 500,000 BAYLA to the order', [ix('increase_limit_order', {
      owner: erin.publicKey, pool_state: poolA, tick_array: PDA.tickArray(poolA, orderArray), limit_order: order0, input_token_account: ata(erin.publicKey, BAYLA),
      input_vault: inV, input_vault_mint: BAYLA, input_token_program: prog(BAYLA),
    }, { amount: (mut('O2') ? 400_000n : 500_000n) * BAYLA_UNIT })], [erin]);
    check('O2', 'increase_limit_order', 'adding to an order raises its total', (await account('LimitOrderState', order0)).total_amount === 1_500_000n * BAYLA_UNIT, '1,500,000 BAYLA');
    const b = await tok(ata(erin.publicKey, BAYLA));
    await must('erin takes 200,000 BAYLA back out', [decOrderIx(order0, orderTick, (mut('O3') ? 100_000n : 200_000n) * BAYLA_UNIT)], [erin]);
    check('O3', 'decrease_limit_order', 'cutting an unfilled order pays the coins back to its owner', (await tok(ata(erin.publicKey, BAYLA))) - b === 200_000n * BAYLA_UNIT, '200,000 BAYLA back');
  }
  {
    const s = await swap('dave buys BAYLA up through the order price', dave, WSOL, { amount: 100n * 10n ** 9n, limitHuman: mut('O4') || mut('O7') ? S * 0.55 : S * 0.75 });
    if (!s.r.ok) console.log(s.r.logs.join('\n'));
    const passed = zeroForOne ? s.after.tick_current > orderTick : s.after.tick_current < orderTick;
    check('O4', 'swap_v2 (fills the order)', 'a buy moves the price past the order', s.r.ok && passed, `${priceHuman(s.before).toExponential(4)} -> ${priceHuman(s.after).toExponential(4)}`);
  }
  {
    const who = mut('O5') ? erin : mallory;
    const r = await send('a stranger settles the order', [settleIx(who.publicKey, ata(erin.publicKey, WSOL))], [who], { expectFail: true });
    check('O5', 'settle_limit_order', "a stranger cannot settle someone's order", !r.ok, `refused: ${errName(r)}`);
  }
  {
    const dest = mut('O6') ? ata(erin.publicKey, WSOL) : ata(VAULT, WSOL);
    const r = await vaultRun('keeper settles into its own account', [settleIx(VAULT, dest)]);
    check('O6', 'settle_limit_order', "the keeper (the vault) cannot settle an order into its own account", !r.executed && errName(r.execute) === 'ConstraintTokenOwner', `refused: ${errName(r.execute)}`);
  }
  {
    const b = await tok(ata(erin.publicKey, WSOL)); const vs = await sol(VAULT); const vw = await tok(ata(VAULT, WSOL));
    const r = await vaultRun("keeper settles erin's order into erin's account", [settleIx(VAULT, ata(erin.publicKey, WSOL))]);
    const got = (await tok(ata(erin.publicKey, WSOL))) - b;
    const o = await account('LimitOrderState', order0);
    const p = 1.0001 ** orderTick; // token 1 per token 0 at the order's price
    const expect = baylaIs0 ? 1_300_000e6 * p : 1_300_000e6 / p;
    check('O7', 'settle_limit_order', "the keeper settles the filled order; the SOL goes to the order's owner, at the order's price, and the vault gets nothing",
      r.executed && o.filled_amount === o.total_amount && got > 0n && Math.abs(Number(got) - expect) / expect < 0.001 && (await sol(VAULT)) === vs && (await tok(ata(VAULT, WSOL))) === vw,
      `${fmt(got, 9)} SOL for 1,300,000 BAYLA (expected ${(expect / 1e9).toFixed(6)}), proposal ${r.index}`);
    const el = await sol(erin.publicKey); const rent = BigInt((await conn.getAccountInfo(order0)).lamports);
    await vaultRun("keeper closes erin's settled order", [ix('close_limit_order', { signer: VAULT, rent_receiver: mut('O8') ? VAULT : erin.publicKey, limit_order: order0 })]);
    check('O8', 'close_limit_order', "closing the order refunds its rent to the order's owner, none to the keeper",
      !(await conn.getAccountInfo(order0)) && (await sol(erin.publicKey)) - el === rent && (await sol(VAULT)) === vs, `${fmt(rent, 9)} SOL to erin`);
  }
  {
    const t2 = orderTick + (zeroForOne ? 30 * SPACING : -30 * SPACING);
    arrays.add(arrayStart(t2, SPACING)); reg(PDA.tickArray(poolA, arrayStart(t2, SPACING)), `pool A tick array ${arrayStart(t2, SPACING)}`);
    const b = await tok(ata(erin.publicKey, BAYLA));
    await must('erin places a second order', [openOrderIx(order1, t2, 200_000n * BAYLA_UNIT)], [erin]);
    await must('erin cancels it', [decOrderIx(order1, t2, (mut('O9') ? 100_000n : 200_000n) * BAYLA_UNIT)], [erin]);
    const back = (await tok(ata(erin.publicKey, BAYLA))) === b;
    const el = await sol(erin.publicKey); const rent1 = BigInt((await conn.getAccountInfo(order1)).lamports);
    const r = await send('erin closes it', [ix('close_limit_order', { signer: erin.publicKey, rent_receiver: erin.publicKey, limit_order: order1 })], [erin]);
    check('O9', 'decrease_limit_order + close_limit_order', 'an owner can cancel an order in full and close it herself', r.ok && back && !(await conn.getAccountInfo(order1)) && (await sol(erin.publicKey)) === el + rent1 - BigInt(r.meta.fee), `all 200,000 BAYLA and ${fmt(rent1, 9)} SOL rent back`);
  }
  phaseDone('phase8');

  // ===========================================================================================
  // Phase 9: pausing, the spare-SOL sweep, closing a position.
  // ===========================================================================================
  const statusIx = (authority, status) => ix('update_pool_status', { authority, pool_state: poolA }, { status });
  {
    const m = mut('A3') ? (await vaultRun('A3 mutant: the vault pauses', [statusIx(VAULT, 16)])).execute : await send('a stranger pauses the pool', [statusIx(mallory.publicKey, 16)], [mallory], { expectFail: true });
    check('A3', 'update_pool_status', 'a stranger cannot pause a pool', !m.ok && (await pool()).status === 0, `refused: ${errName(m)}`);
    if (!mut('A1')) await mustVault('vault pauses swaps on pool A', [statusIx(VAULT, 16)]);
    const s = await swap('dave swaps while paused', dave, WSOL, { amount: 10n ** 9n }, { expectFail: true });
    check('A1', 'update_pool_status', 'when the vault pauses swaps, a swap is refused', !s.r.ok && s.paid === 0n, `refused: ${errName(s.r)}`);
    if (!mut('A2')) await mustVault('vault unpauses pool A', [statusIx(VAULT, 0)]);
    const s2 = await swap('dave swaps after the pause', dave, WSOL, { amount: 10n ** 9n });
    check('A2', 'update_pool_status', 'after the vault lifts the pause, swaps work again', s2.r.ok && s2.got > 0n, `${fmt(s2.got, 6)} BAYLA`);
  }
  {
    const p0 = await pool();
    const r0 = ata(VAULT, M0); const r1 = ata(VAULT, M1);
    const b = [await tok(r0), await tok(r1)];
    // Raydium's code let the admin collect the island's share too; the venue removed that.
    // The broken input: the vault collects the venue's share, which it may.
    const r = await vaultRun(mut('V9') ? "V9 mutant: the vault collects the venue's share" : "the vault tries to collect the island's share",
      [feeIx(mut('V9') ? 'collect_protocol_fee' : 'collect_fund_fee', VAULT, r0, r1)]);
    const got = [(await tok(r0)) - b[0], (await tok(r1)) - b[1]];
    const p1 = await pool();
    check('V9', 'collect_fund_fee', "the vault cannot collect the island's share, even while the Workshop is the fund owner: only the fund owner can",
      !r.executed && failedWith(r.execute, 'NotApproved') && got[0] === 0n && got[1] === 0n && p1.fund_fees_token_0 === p0.fund_fees_token_0 && p1.fund_fees_token_1 === p0.fund_fees_token_1,
      r.executed ? `executed: ${fmt(baylaIs0 ? got[0] : got[1], 6)} BAYLA + ${fmt(baylaIs0 ? got[1] : got[0], 9)} SOL to the vault, proposal ${r.index}` : `refused: ${errName(r.execute)}`);
  }
  {
    // Kept on purpose and disclosed (the owner's ruling): the vault can still move the island's
    // share, by pointing the tier's fund owner at itself. Its broken input skips that step.
    const p0 = await pool();
    const r0 = ata(VAULT, M0); const r1 = ata(VAULT, M1);
    const b = [await tok(r0), await tok(r1)];
    const point = (to) => ix('update_amm_config', { owner: VAULT, amm_config: cfg0 }, { param: 4, value: 0 }, [{ pubkey: to, isWritable: false }]);
    const r = await vaultRun("vault points tier 0's island share at itself, collects it, and points it back", [
      ...(mut('V10') ? [] : [point(VAULT)]), feeIx('collect_fund_fee', VAULT, r0, r1), point(c.WORKSHOP)]);
    const got = [(await tok(r0)) - b[0], (await tok(r1)) - b[1]];
    check('V10', 'update_amm_config (param 4) + collect_fund_fee', "kept and disclosed: in one proposal the vault can point a tier's island share at itself, collect it, and point it back",
      r.executed && got[0] === p0.fund_fees_token_0 && got[1] === p0.fund_fees_token_1 && got[0] + got[1] > 0n && (await account('AmmConfig', cfg0)).fund_owner.equals(c.WORKSHOP),
      r.executed ? `${fmt(baylaIs0 ? got[0] : got[1], 6)} BAYLA + ${fmt(baylaIs0 ? got[1] : got[0], 9)} SOL, proposal ${r.index}` : `refused: ${errName(r.execute)}`);
  }
  {
    const gift = { [poolA.toBase58()]: 500_000_000n, [obsA.toBase58()]: 250_000_000n, [vaultOf(BAYLA).toBase58()]: 50_000_000n, [vaultOf(WSOL).toBase58()]: 100_000_000n };
    await must('a stranger sends spare SOL to four pool accounts', Object.entries(gift).map(([to, l]) => SystemProgram.transfer({ fromPubkey: mallory.publicKey, toPubkey: new PublicKey(to), lamports: l })), [mallory]);
    const sweep = (wallet, extra) => ix('collect_excess_lamports', { collect_lamports_wallet: wallet, pool_state: poolA }, {}, extra.map((p) => ({ pubkey: p })));
    const m = mut('E3') ? (await vaultRun('E3 mutant: the vault sweeps', [sweep(VAULT, [obsA])])).execute : await send('a stranger sweeps the spare SOL', [sweep(mallory.publicKey, [obsA])], [mallory], { expectFail: true });
    check('E3', 'collect_excess_lamports', 'a stranger cannot sweep spare SOL', failedWith(m, 'NotApproved'), `refused: ${errName(m)}`);
    const v0 = await sol(VAULT); const bv = await tok(vaultOf(BAYLA));
    await mustVault('vault sweeps the spare SOL of the pool, its history and its BAYLA vault', [sweep(VAULT, mut('E1') ? [obsA, bitmapA] : [obsA, bitmapA, vaultOf(BAYLA)])]);
    const gained = (await sol(VAULT)) - v0;
    check('E1', 'collect_excess_lamports', 'the vault receives exactly the spare SOL, and the BAYLA in the pool is untouched', gained === 800_000_000n && (await tok(vaultOf(BAYLA))) === bv, `${fmt(gained, 9)} SOL to the vault`);
    const w = vaultOf(WSOL);
    const before = { amount: await tok(w), lamports: await sol(w) };
    if (mut('E2')) await swap('E2 mutant: a swap in between', dave, WSOL, { amount: 10n ** 9n });
    const r = await vaultRun("vault tries to sweep the pool's wrapped-SOL vault", [sweep(VAULT, [w])]);
    const after = { amount: await tok(w), lamports: await sol(w) };
    const rentW = BigInt(await conn.getMinimumBalanceForRentExemption(165));
    check('E2', 'collect_excess_lamports', "the sweep cannot take LPs' SOL out of the wrapped-SOL vault: its balance and lamports are unchanged",
      after.amount === before.amount && after.lamports >= rentW + after.amount && (r.executed ? after.lamports === before.lamports - 100_000_000n : after.lamports === before.lamports),
      r.executed ? `swept only the 0.1 SOL gift; balance ${fmt(after.amount, 9)} SOL kept` : `refused: ${errName(r.execute)}; the 0.1 SOL gift stays, ${fmt(after.amount, 9)} SOL kept`);
  }
  {
    const p = positions.carol;
    const pp = await account('PersonalPositionState', p.pos);
    if (!mut('C1')) await must('carol withdraws everything', [liqIx('decrease_liquidity_v2', 'carol', { liquidity: pp.liquidity, amount_0_min: 0n, amount_1_min: 0n }, await rewardGroups(carol))], [carol]);
    const rents = [];
    for (const a of [p.pos, p.nft, p.nftAcc]) rents.push(BigInt((await conn.getAccountInfo(a)).lamports));
    const l0 = await sol(carol.publicKey);
    const r = await send('carol closes her position', [ix('close_position', { nft_owner: carol.publicKey, position_nft_mint: p.nft, position_nft_account: p.nftAcc, personal_position: p.pos, token_program: ADDR.token2022 })], [carol]);
    const gone = [];
    for (const a of [p.pos, p.nft, p.nftAcc]) gone.push(!(await conn.getAccountInfo(a)));
    const refund = (await sol(carol.publicKey)) - l0 + BigInt(r.meta.fee);
    check('C1', 'close_position', 'closing burns the NFT, closes its mint, account and record, and refunds all three rents to the owner', r.ok && gone.every(Boolean) && refund === rents.reduce((s, x) => s + x, 0n), `${fmt(refund, 9)} SOL back`);
  }
  phaseDone('phase9');

  const { more } = await import('./suite-more.mjs');
  await more(c, h, {});

  await ledgerChecks(c, h);
}

/** Phase 10, over every transaction of the run so far; a G mutant runs it right after setup. */
export async function ledgerChecks(c, h) {
  const { K, VAULT, poolA, poolB, known } = c;
  const { check, phaseDone, measure, mut } = h;
  const { mallory } = K;
  // ===========================================================================================
  // Phase 10: every transaction of the run, and the program's own bytes.
  // ===========================================================================================
  if (mut('G1')) await send('G1 mutant: 1 lamport to a Raydium key', [SystemProgram.transfer({ fromPubkey: mallory.publicKey, toPubkey: new PublicKey(DENY[0]), lamports: 1 })], [mallory]);
  if (mut('G2')) await send('G2 mutant: 1 lamport to an unknown key', [SystemProgram.transfer({ fromPubkey: mallory.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 })], [mallory]);
  // The deny list is every key Raydium's two repositories write, less allowed-keys.json's system
  // names. It so carries the SPL Memo program, which swap_v2 and the v2 withdrawals must name
  // (address = anchor_spl::memo::ID); the Memo id here comes from the crate the program builds with.
  const memo = ADDR.memo.toBase58();
  if (mut('G3')) {
    const stranger = Keypair.generate().publicKey;
    const to = spl.getAssociatedTokenAddressSync(c.BAYLA, stranger, false, ADDR.token2022);
    await send('G3 mutant: 1 BAYLA unit to a stranger', [spl.createAssociatedTokenAccountIdempotentInstruction(mallory.publicKey, to, stranger, c.BAYLA, ADDR.token2022, ADDR.ata),
      spl.createTransferCheckedInstruction(spl.getAssociatedTokenAddressSync(c.BAYLA, mallory.publicKey, false, ADDR.token2022), c.BAYLA, to, mallory.publicKey, 1n, 6, [], ADDR.token2022)], [mallory]);
  }
  const deny = new Set(DENY);
  const touched = new Map();
  for (const r of ledger) for (const k of r.keys) if (deny.has(k)) touched.set(k, (touched.get(k) || 0) + 1);
  const keysAll = new Set(ledger.flatMap((r) => r.keys));
  const others = [...touched.keys()].filter((k) => k !== memo);
  const memoGained = ledger.some((r) => { const i = r.keys.indexOf(memo); return i >= 0 && r.meta.postBalances[i] !== r.meta.preBalances[i]; });
  check('G1', 'every transaction', "no transaction touched any of the 39 keys Raydium's code hard-codes, except the SPL Memo program, which the deny list also carries; it was only named, never paid",
    deny.has(memo) && others.length === 0 && !memoGained,
    `${ledger.length} transactions, ${keysAll.size} accounts; Memo named in ${touched.get(memo) || 0}; ${others.length ? 'OTHER deny keys: ' + others.join(', ') : 'no other deny key'}`);
  const unknown = [...keysAll].filter((k) => !known.has(k));
  check('G2', 'every transaction', 'every account any transaction touched is one this run made or named (wallets, vault, pools, programs)', unknown.length === 0, unknown.length ? `unknown: ${unknown.slice(0, 3).join(', ')}` : `${keysAll.size} accounts, all named`);
  {
    const ours = new Set([...Object.values(K).map((k) => k.publicKey.toBase58()), VAULT.toBase58(), poolA.toBase58(), poolB.toBase58(), ...(c.extraPools ?? []).map((p) => p.toBase58())]);
    const bad = [];
    for (const r of ledger) {
      const pre = new Map((r.meta.preTokenBalances || []).map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
      for (const b of r.meta.postTokenBalances || []) if (BigInt(b.uiTokenAmount.amount) > (pre.get(b.accountIndex) ?? 0n) && !ours.has(b.owner)) bad.push(`${r.label}: ${b.owner}`);
    }
    check('G3', 'every transaction', 'every coin that moved anywhere landed with a test wallet, the vault or a pool', bad.length === 0, bad.length ? bad.slice(0, 2).join('; ') : 'all landed with named owners');
  }
  {
    const prog = await conn.getAccountInfo(ADDR.program);
    const pd = await conn.getAccountInfo(new PublicKey(prog.data.subarray(4, 36)));
    let bytes = pd.data.subarray(45);
    if (mut('G4')) { bytes = Buffer.from(bytes); new PublicKey(DENY[0]).toBuffer().copy(bytes, 1000); }
    const hits = DENY.filter((k) => bytes.indexOf(new PublicKey(k).toBuffer()) >= 0 || bytes.indexOf(Buffer.from(k)) >= 0);
    check('G4', 'the program itself', "the running program's bytes hold none of Raydium's 39 keys, as bytes or as text", hits.length === 0, `${bytes.length} bytes searched`);
    const authority = new PublicKey(pd.data.subarray(13, 45));
    check('G5', 'the program itself', 'the local program sits at the id lib.rs declares with the vault as its upgrade authority', authority.equals(VAULT) && pd.data[12] === 1, `program data ${pd.data.length} bytes`);
    await measure('program data account (the program\'s code)', new PublicKey(prog.data.subarray(4, 36)), 'deployer');
    await measure('program account', ADDR.program, 'deployer');
  }
  phaseDone('phase10');
}
