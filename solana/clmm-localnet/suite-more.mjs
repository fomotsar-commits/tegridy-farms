// Phase 11 of suite.mjs: the remaining instructions the venue or a visitor can reach.
// Operators, a coin with an unusual Token-2022 feature, the instructions deleted on 2026-11-03,
// a two-hop route, the old swap, and the Metaplex path a stranger can call.
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, Keypair, TransactionInstruction, spl } from './lib/deps.mjs';
import { ADDR } from './lib/config.mjs';
import { conn, send, clockNow } from './lib/chain.mjs';
import { ix, PDA, account, order, tickAt, alignDown, arrayStart } from './lib/clmm.mjs';

export async function more(c, h, s) {
  const { K, VAULT, BAYLA, WSOL, USD, M0, M1, baylaIs0, poolA, poolB, vA0, vA1, obsA, bitmapA, cfg0, cfg1, arrays, SPACING, BAYLA_UNIT, OPEN_FEE } = c;
  const { check, phaseDone, must, mustVault, vaultRun, tok, sol, errName, failedWith, fmt, reg, ata, ataIx, prog, setProg, mut, measure } = h;
  const { alice, dave, erin, mallory, carol } = K;
  const WEEK = 7 * 24 * 3600;
  const poolIxAccounts = (creator, cfg, m0, m1, pool) => ({
    pool_creator: creator, amm_config: cfg, pool_state: pool, token_mint_0: m0, token_mint_1: m1, token_vault_0: PDA.vault(pool, m0), token_vault_1: PDA.vault(pool, m1),
    observation_state: PDA.observation(pool), tick_array_bitmap: PDA.bitmap(pool), token_program_0: prog(m0), token_program_1: prog(m1),
  });
  const regPool = (pool, name, m0, m1) => { reg(pool, name); reg(PDA.vault(pool, m0), name + ' vault 0'); reg(PDA.vault(pool, m1), name + ' vault 1'); reg(PDA.observation(pool), name + ' price history'); reg(PDA.bitmap(pool), name + ' range map'); return pool; };

  // ---- operators -------------------------------------------------------------------------
  const op = PDA.operation();
  const opIx = (owner, param, keys) => ix('update_operation_account', { owner, operation_state: op }, { param, keys });
  {
    const r = mut('X1') ? (await vaultRun('X1 mutant: the vault adds an operator', [opIx(VAULT, 0, [mallory.publicKey])])).execute
      : await send('a stranger makes herself an operator', [opIx(mallory.publicKey, 0, [mallory.publicKey])], [mallory], { expectFail: true });
    check('X1', 'update_operation_account', 'a stranger cannot make anyone an operator', failedWith(r, 'NotApproved'), `refused: ${errName(r)}`);
  }
  if (!mut('X2')) await mustVault('vault makes carol an operator', [opIx(VAULT, 0, [carol.publicKey])]);
  {
    const rvUsd = reg(PDA.rewardVault(poolA, USD), 'pool A reward vault USD');
    await must('USD for carol', [ataIx(K.usdMintAuthority.publicKey, carol.publicKey, USD), spl.createMintToInstruction(USD, ata(carol.publicKey, USD), K.usdMintAuthority.publicKey, 1_000_000n, [], ADDR.token)], [K.usdMintAuthority]);
    const now = await clockNow();
    const r = await send('carol, an operator, sets up the third reward', [ix('initialize_reward', {
      reward_funder: carol.publicKey, funder_token_account: ata(carol.publicKey, USD), amm_config: cfg0, pool_state: poolA, operation_state: op,
      reward_token_mint: USD, reward_token_vault: rvUsd, reward_token_program: prog(USD),
    }, { param: { open_time: BigInt(now + 20), end_time: BigInt(now + 20 + WEEK), emissions_per_second_x64: 1n << 64n } })], [carol]);
    const ri = (await account('PoolState', poolA)).reward_infos[2];
    check('X2', 'update_operation_account + initialize_reward', "the third reward may only be set up by the vault or an operator: carol, made an operator by the vault, can", r.ok && ri.authority.equals(carol.publicKey),
      r.ok ? `${fmt(await tok(rvUsd), 6)} USD funded` : `refused: ${errName(r)}`);
  }
  {
    await mustVault('vault whitelists REWARD and removes carol as operator', [opIx(VAULT, 2, [c.REWARD]), opIx(VAULT, 1, [carol.publicKey])]);
    const os = await account('OperationState', op);
    const a = os.whitelist_mints.some((m) => m.equals(c.REWARD)) && !os.operation_owners.some((m) => m.equals(carol.publicKey));
    if (!mut('X3')) await mustVault('vault removes REWARD from the whitelist', [opIx(VAULT, 3, [c.REWARD])]);
    const os2 = await account('OperationState', op);
    check('X3', 'update_operation_account', 'the vault adds and removes operators and whitelisted reward coins', a && !os2.whitelist_mints.some((m) => m.equals(c.REWARD)), 'add, remove, both seen');
  }

  // ---- a coin with an unusual Token-2022 feature ----------------------------------------
  const odd = Keypair.generate();
  reg(odd.publicKey, 'ODD mint (Token-2022, permanent delegate)');
  setProg(odd.publicKey, ADDR.token2022);
  {
    const ext = mut('X5') || mut('X7') ? [] : [spl.ExtensionType.PermanentDelegate];
    const space = spl.getMintLen(ext);
    await must('a coin with a permanent delegate (ODD)', [
      SystemProgram.createAccount({ fromPubkey: K.usdMintAuthority.publicKey, newAccountPubkey: odd.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(space), space, programId: ADDR.token2022 }),
      ...(ext.length ? [spl.createInitializePermanentDelegateInstruction(odd.publicKey, K.usdMintAuthority.publicKey, ADDR.token2022)] : []),
      spl.createInitializeMint2Instruction(odd.publicKey, 6, K.usdMintAuthority.publicKey, null, ADDR.token2022),
    ], [K.usdMintAuthority, odd]);
  }
  const [O0, O1] = order(odd.publicKey, WSOL);
  const poolOdd = regPool(PDA.pool(cfg0, O0, O1), 'pool ODD/SOL', O0, O1);
  const support = reg(PDA.supportMint(odd.publicKey), 'ODD support pass');
  const oddPoolIx = (extra) => ix('create_pool', poolIxAccounts(dave.publicKey, cfg0, O0, O1, poolOdd), { sqrt_price_x64: 1n << 64n, open_time: 0n }, extra);
  // X7's broken input makes ODD a plain coin, whose pool X4 would open first.
  if (!mut('X7')) {
    const r = await send('dave opens a pool for ODD', [oddPoolIx([])], [dave], { expectFail: true });
    check('X4', 'create_pool', 'a coin with an unusual Token-2022 feature (a permanent delegate) cannot get a pool by default', failedWith(r, 'NotSupportMint'), `refused: ${errName(r)}`);
  }
  const passIx = (name, owner) => ix(name, { owner, token_mint: odd.publicKey, support_mint_associated: support });
  {
    const r = mut('X6') ? (await vaultRun('X6 mutant: the vault', [passIx('create_support_mint_associated', VAULT)])).execute
      : await send('a stranger lets ODD in', [passIx('create_support_mint_associated', mallory.publicKey)], [mallory], { expectFail: true });
    check('X6', 'create_support_mint_associated', 'a stranger cannot let an unusual coin in', failedWith(r, 'NotApproved'), `refused: ${errName(r)}`);
  }
  await mustVault('vault lets ODD in', [passIx('create_support_mint_associated', VAULT)]);
  await measure('support-mint pass (SupportMintAssociated)', support, 'vault');
  {
    // Since 2026-11-03 the program reads every coin's Token-2022 features, a pass or not (audit
    // TK-1/CL-08): the pass the vault issued lets nothing in. Its broken input is a plain coin.
    const r = await send('dave opens the ODD pool with the pass', [oddPoolIx([{ pubkey: support, isWritable: false }])], [dave], { expectFail: !mut('X7') });
    check('X7', 'create_pool + create_support_mint_associated', "even with the vault's pass, a coin with a permanent delegate cannot get a pool: the program reads no pass",
      failedWith(r, 'NotSupportMint') && !(await conn.getAccountInfo(poolOdd)), r.ok ? 'pool opened' : `refused: ${errName(r)}`);
    if (!mut('X8')) await mustVault("vault closes ODD's pass", [passIx('close_support_mint_associated', VAULT)]);
    check('X8', 'close_support_mint_associated', 'the vault can withdraw the pass', !(await conn.getAccountInfo(support)), 'closed');
  }

  // ---- the instructions deleted on 2026-11-03 -------------------------------------------------
  // Custom pools (audit CL-03/DG-02), both dynamic-fee settings (CR-1/CO-1/CR-7), the rent sweep
  // (CD-2), and permissioned pools with the permission accounts only they read (the owner's ruling).
  // Each is sent bare, its 8-byte name (sha256 of "global:<name>") and nothing else: the program
  // answers it as an unknown instruction before it reads any account, where the build before the
  // deletion found it. The broken input sends close_limit_order's name instead.
  const bare = (name) => new TransactionInstruction({ programId: ADDR.program, keys: [], data: createHash('sha256').update(`global:${name}`).digest().subarray(0, 8) });
  for (const [id, name, why] of [
    ['D1', 'create_customizable_pool', 'audit CL-03/DG-02'], ['D2', 'create_dynamic_fee_config', 'audit CR-1/CO-1/CR-7'],
    ['D3', 'update_dynamic_fee_config', 'audit CR-1/CO-1/CR-7'], ['D4', 'collect_excess_lamports', 'audit CD-2'],
    ['D5', 'create_permissioned_pool', "the owner's ruling"], ['D6', 'create_permission_pda', "the owner's ruling"],
    ['D7', 'close_permission_pda', "the owner's ruling"],
  ]) {
    const r = await send(`${name}, sent bare`, [bare(mut(id) ? 'close_limit_order' : name)], [mallory], { expectFail: true });
    check(id, name, `the program has no ${name} (deleted 2026-11-03, ${why}): it answers as to any unknown instruction`, failedWith(r, 'InstructionFallbackNotFound'), `refused: ${errName(r)}`);
  }

  // ---- a two-hop route: BAYLA -> SOL (1% pool) -> USD (0.25% pool) ------------------------
  const [N0, N1] = order(WSOL, USD);
  const rawB = (usd) => (N0.equals(WSOL) ? usd * 1e-3 : 1e3 / usd);
  const arraysB = new Set();
  {
    const nft = Keypair.generate(); reg(nft.publicKey, 'alice pool B NFT mint');
    const nftAcc = reg(spl.getAssociatedTokenAddressSync(nft.publicKey, alice.publicKey, false, ADDR.token2022), 'alice pool B NFT account');
    const pos = reg(PDA.position(nft.publicKey), 'alice pool B position');
    let [lo, hi] = [alignDown(tickAt(rawB(120)), 60), alignDown(tickAt(rawB(270)), 60)];
    if (lo > hi) [lo, hi] = [hi, lo];
    const [tl, tu] = [arrayStart(lo, 60), arrayStart(hi, 60)];
    for (const t of [tl, tu]) { arraysB.add(t); reg(PDA.tickArray(poolB, t), `pool B tick array ${t}`); }
    const [a0, a1] = N0.equals(WSOL) ? [5n * 10n ** 9n, 3_000n * 10n ** 6n] : [3_000n * 10n ** 6n, 5n * 10n ** 9n];
    await must('alice adds SOL and USD to pool B', [ix('open_position_with_token22_nft', {
      payer: alice.publicKey, position_nft_owner: alice.publicKey, position_nft_mint: nft.publicKey, position_nft_account: nftAcc, pool_state: poolB, protocol_position: SystemProgram.programId,
      tick_array_lower: PDA.tickArray(poolB, tl), tick_array_upper: PDA.tickArray(poolB, tu), personal_position: pos,
      token_account_0: ata(alice.publicKey, N0), token_account_1: ata(alice.publicKey, N1), token_vault_0: PDA.vault(poolB, N0), token_vault_1: PDA.vault(poolB, N1), vault_0_mint: N0, vault_1_mint: N1,
    }, { tick_lower_index: lo, tick_upper_index: hi, tick_array_lower_start_index: tl, tick_array_upper_start_index: tu, liquidity: 0n, amount_0_max: a0, amount_1_max: a1, with_metadata: true, base_flag: N0.equals(WSOL) })], [alice, nft]);
  }
  {
    await must('USD account for dave', [ataIx(dave.publicKey, dave.publicKey, USD)], [dave]);
    const hop = async (cfg, pool, inMint, outMint, obs, bitmap, arr) => {
      const p = await account('PoolState', pool);
      const zeroForOne = inMint.equals(p.token_mint_0);
      const cur = arrayStart(p.tick_current, p.tick_spacing);
      const ex = []; for (const t of arr) if (await conn.getAccountInfo(PDA.tickArray(pool, t))) ex.push(t);
      const ord = zeroForOne ? ex.filter((t) => t <= cur).sort((a, b) => b - a) : ex.filter((t) => t >= cur).sort((a, b) => a - b);
      return [cfg, pool, ata(dave.publicKey, outMint), PDA.vault(pool, inMint), PDA.vault(pool, outMint), outMint, obs, bitmap, ...ord.map((t) => PDA.tickArray(pool, t))]
        .map((k, i) => ({ pubkey: k, isWritable: !(i === 0 || i === 5) }));
    };
    const amount = 100_000n * BAYLA_UNIT;
    const b = { b: await tok(ata(dave.publicKey, BAYLA)), s: await tok(ata(dave.publicKey, WSOL)), u: await tok(ata(dave.publicKey, USD)) };
    const route = [...await hop(cfg0, poolA, BAYLA, WSOL, obsA, bitmapA, arrays), ...await hop(cfg1, poolB, WSOL, USD, PDA.observation(poolB), PDA.bitmap(poolB), arraysB)];
    const r = await send('dave routes BAYLA -> SOL -> USD', [ix('swap_router_base_in', { payer: dave.publicKey, input_token_account: ata(dave.publicKey, BAYLA), input_token_mint: BAYLA }, { amount_in: amount, amount_out_minimum: mut('X15') ? 1n << 62n : 1n }, route)], [dave]);
    const d = { b: b.b - (await tok(ata(dave.publicKey, BAYLA))), s: (await tok(ata(dave.publicKey, WSOL))) - b.s, u: (await tok(ata(dave.publicKey, USD))) - b.u };
    if (!r.ok) console.log(r.logs.slice(-12).join('\n'));
    check('X15', 'swap_router_base_in', 'a two-hop route through both tiers spends exactly the BAYLA in, pays USD out, and leaves no SOL behind', r.ok && d.b === amount && d.u > 0n && d.s === 0n,
      `100,000 BAYLA -> ${fmt(d.u, 6)} USD, ${r.cu} CU, ${r.bytes} bytes`);
  }

  // ---- the old swap, and the Metaplex position path -------------------------------------
  {
    // Same call on both pools, with the tick arrays that exist in the swap's direction, so the only
    // difference is the coin: the refusal must name the BAYLA side's account.
    const onB = mut('X16');
    const [pool, inM, outM, obs, arr] = onB ? [poolB, WSOL, USD, PDA.observation(poolB), arraysB] : [poolA, WSOL, BAYLA, obsA, arrays];
    const p = await account('PoolState', pool);
    const zeroForOne = inM.equals(p.token_mint_0);
    const cur = arrayStart(p.tick_current, p.tick_spacing);
    const ex = []; for (const t of arr) if (await conn.getAccountInfo(PDA.tickArray(pool, t))) ex.push(t);
    const ord = (zeroForOne ? ex.filter((t) => t <= cur).sort((a, b) => b - a) : ex.filter((t) => t >= cur).sort((a, b) => a - b)).map((t) => PDA.tickArray(pool, t));
    const r = await send('the old swap (SPL Token only)', [ix('swap', {
      payer: dave.publicKey, amm_config: onB ? cfg1 : cfg0, pool_state: pool, input_token_account: ata(dave.publicKey, inM), output_token_account: ata(dave.publicKey, outM),
      input_vault: PDA.vault(pool, inM), output_vault: PDA.vault(pool, outM), observation_state: obs, tick_array: ord[0],
    }, { amount: 10_000_000n, other_amount_threshold: 0n, sqrt_price_limit_x64: 0n, is_base_input: true }, ord.slice(1).map((k) => ({ pubkey: k })))], [dave], { expectFail: true });
    const onBayla = ['output_token_account', 'output_vault'].includes(r.error?.account);
    check('X16', 'swap (old)', "the old swap cannot move a Token-2022 coin, so it cannot trade BAYLA: it is refused at BAYLA's own account", !r.ok && onBayla,
      r.ok ? 'it went through' : `refused: ${errName(r)} at ${r.error?.account ?? 'no named account'}`);
  }
  {
    const p = await account('PoolState', poolA);
    const nft = Keypair.generate(); reg(nft.publicKey, 'mallory Metaplex NFT mint');
    const nftAcc = reg(spl.getAssociatedTokenAddressSync(nft.publicKey, mallory.publicKey, false, ADDR.token), 'mallory Metaplex NFT account');
    const meta = reg(PublicKey.findProgramAddressSync([Buffer.from('metadata'), ADDR.metaplex.toBuffer(), nft.publicKey.toBuffer()], ADDR.metaplex)[0], 'mallory Metaplex name record');
    const pos = reg(PDA.position(nft.publicKey), 'mallory position');
    const lo = alignDown(p.tick_current, SPACING) - 10 * SPACING; const hi = lo + 20 * SPACING;
    const [tl, tu] = [arrayStart(lo, SPACING), arrayStart(hi, SPACING)];
    for (const t of [tl, tu]) { arrays.add(t); reg(PDA.tickArray(poolA, t), `pool A tick array ${t}`); }
    const vault0 = await sol(VAULT); const m0 = await sol(mallory.publicKey);
    const [a0, a1] = baylaIs0 ? [10_000n * BAYLA_UNIT, 10n ** 9n] : [10n ** 9n, 10_000n * BAYLA_UNIT];
    const r = await send('a stranger opens a position the old way, with a Metaplex name record', [ix('open_position_v2', {
      payer: mallory.publicKey, position_nft_owner: mallory.publicKey, position_nft_mint: nft.publicKey, position_nft_account: nftAcc, metadata_account: meta, pool_state: poolA,
      protocol_position: SystemProgram.programId, tick_array_lower: PDA.tickArray(poolA, tl), tick_array_upper: PDA.tickArray(poolA, tu), personal_position: pos,
      token_account_0: ata(mallory.publicKey, M0), token_account_1: ata(mallory.publicKey, M1), token_vault_0: vA0, token_vault_1: vA1, vault_0_mint: M0, vault_1_mint: M1,
    }, { tick_lower_index: lo, tick_upper_index: hi, tick_array_lower_start_index: tl, tick_array_upper_start_index: tu, liquidity: 0n, amount_0_max: a0, amount_1_max: a1, with_metadata: !mut('X17'), base_flag: baylaIs0 })], [mallory, nft]);
    if (!r.ok) console.log(r.logs.slice(-10).join('\n'));
    const ma = r.ok ? await conn.getAccountInfo(meta) : null;
    const metaplexFee = ma ? BigInt(ma.lamports) - BigInt(await conn.getMinimumBalanceForRentExemption(ma.data.length)) : null;
    check('X17', 'open_position_v2', 'the old path still works for a stranger, who pays Metaplex from her own wallet; the vault pays nothing',
      r.ok && !!ma && (await sol(VAULT)) === vault0 && m0 > (await sol(mallory.publicKey)),
      ma ? `Metaplex name record ${ma.data.length} bytes; ${fmt(metaplexFee, 9)} SOL above its rent stays in it as Metaplex's fee` : errName(r));
    if (ma) await measure('Metaplex name record (old path only)', meta, 'the stranger who chose that path');
  }
  phaseDone('phase11');
}
