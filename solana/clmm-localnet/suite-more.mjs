// Phase 11 of suite.mjs: the remaining instructions the venue or a visitor can reach.
// Operators, a coin with an unusual Token-2022 feature, dynamic fees, a custom pool, a
// permission pool, a two-hop route, the old swap, and the Metaplex path a stranger can call.
import { PublicKey, SystemProgram, Keypair, spl } from './lib/deps.mjs';
import { ADDR } from './lib/config.mjs';
import { conn, send, clockNow } from './lib/chain.mjs';
import { ix, PDA, account, order, tickAt, alignDown, arrayStart, sqrtPriceX64 } from './lib/clmm.mjs';

export async function more(c, h, s) {
  const { K, VAULT, BAYLA, WSOL, USD, M0, M1, baylaIs0, poolA, poolB, vA0, vA1, obsA, bitmapA, cfg0, cfg1, arrays, SPACING, BAYLA_UNIT } = c;
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
    const ext = mut('X5') ? [] : [spl.ExtensionType.PermanentDelegate];
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
  {
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
    const r = await send('dave opens the ODD pool with the pass', [oddPoolIx(mut('X7') ? [] : [{ pubkey: support, isWritable: false }])], [dave]);
    check('X7', 'create_pool + create_support_mint_associated', "once the vault lets a coin in, anyone can open its pool", r.ok && !!(await conn.getAccountInfo(poolOdd)), r.ok ? 'pool opened' : errName(r));
    if (!mut('X8')) await mustVault("vault closes ODD's pass", [passIx('close_support_mint_associated', VAULT)]);
    check('X8', 'close_support_mint_associated', 'the vault can withdraw the pass', !(await conn.getAccountInfo(support)), 'closed');
  }

  // ---- dynamic fees and a custom pool ----------------------------------------------------
  const dfc = reg(PDA.dynamicFee(0), 'dynamic fee config 0');
  const dfArgs = { filter_period: 30, decay_period: 600, reduction_factor: 5_000, dynamic_fee_control: 4_000, max_volatility_accumulator: 350_000 };
  const dfIx = (owner) => ix('create_dynamic_fee_config', { owner, dynamic_fee_config: dfc }, { index: 0, ...dfArgs });
  {
    const r = mut('X9') ? (await vaultRun('X9 mutant: the vault', [dfIx(VAULT)])).execute : await send('a stranger makes a dynamic fee setting', [dfIx(mallory.publicKey)], [mallory], { expectFail: true });
    check('X9', 'create_dynamic_fee_config', 'a stranger cannot make a dynamic fee setting', failedWith(r, 'NotApproved'), `refused: ${errName(r)}`);
  }
  await mustVault('vault makes dynamic fee setting 0', [dfIx(VAULT)]);
  if (!mut('X10')) await mustVault('vault changes its decay period', [ix('update_dynamic_fee_config', { owner: VAULT, dynamic_fee_config: dfc }, { ...dfArgs, decay_period: 900 })]);
  {
    const d = await account('DynamicFeeConfig', dfc);
    check('X10', 'create_dynamic_fee_config + update_dynamic_fee_config', 'the vault makes a dynamic fee setting and changes it', d.filter_period === 30 && d.decay_period === 900 && d.reduction_factor === 5_000, 'decay 600 -> 900 s');
    await measure('dynamic fee setting (DynamicFeeConfig)', dfc, 'vault');
  }
  {
    const poolC = regPool(PDA.pool(cfg1, M0, M1), 'pool BAYLA/SOL 0.25% custom', M0, M1);
    const solSide = M0.equals(WSOL) ? 1 : 2; // CollectFeeOn: Token0Only = 1, Token1Only = 2
    const r = await send('a visitor opens a custom pool: fee in SOL only, dynamic fee on', [ix('create_customizable_pool', poolIxAccounts(K.bob.publicKey, cfg1, M0, M1, poolC),
      { customizable_params: { sqrt_price_x64: (await account('PoolState', poolA)).sqrt_price_x64, collect_fee_on: solSide, enable_dynamic_fee: !mut('X11') } }, [{ pubkey: dfc, isWritable: false }])], [K.bob]);
    const p = r.ok ? await account('PoolState', poolC) : null;
    check('X11', 'create_customizable_pool', 'anyone can open a pool that takes its fee in one coin only, with the dynamic fee the vault set', r.ok && p.fee_on === solSide && p.dynamic_fee_info.decay_period === 900,
      r.ok ? `fee_on ${p.fee_on}, decay ${p.dynamic_fee_info.decay_period} s` : errName(r));
  }

  // ---- the 4% ceiling holds a dynamic fee too ------------------------------------------------
  // Pool D sits on tier 8 (3%) with a strong dynamic fee. A first swap moves the price many steps;
  // a second, inside the filter period, then pays the raised rate on all of it: above 4% without
  // the ceiling, exactly 4% with it, and 3% with no dynamic fee at all.
  {
    const cfg8 = reg(PDA.ammConfig(8), 'fee tier 8 (3%)');
    const TIER8 = { index: 8, tick_spacing: 10, trade_fee_rate: 30_000, protocol_fee_rate: 104_000, fund_fee_rate: 56_000 };
    await mustVault('vault makes tier 8 (3%)', [ix('create_amm_config', { owner: VAULT, amm_config: cfg8 }, TIER8)]);
    const dfc1 = reg(PDA.dynamicFee(1), 'dynamic fee config 1 (strong)');
    await mustVault('vault makes a strong dynamic fee setting', [ix('create_dynamic_fee_config', { owner: VAULT, dynamic_fee_config: dfc1 },
      { index: 1, filter_period: 120, decay_period: 600, reduction_factor: 5_000, dynamic_fee_control: 99_999, max_volatility_accumulator: 350_000 })]);
    const [D0, D1] = order(WSOL, USD);
    const poolD = regPool(PDA.pool(cfg8, D0, D1), 'pool D (SOL/USD, 3%, dynamic)', D0, D1);
    c.extraPools = [...(c.extraPools ?? []), poolD];
    const sqrtD = D0.equals(WSOL) ? sqrtPriceX64(180 * 1e6, 1e9) : sqrtPriceX64(1e9, 180 * 1e6);
    await must('alice opens pool D with the strong dynamic fee', [ix('create_customizable_pool', poolIxAccounts(alice.publicKey, cfg8, D0, D1, poolD),
      { customizable_params: { sqrt_price_x64: sqrtD, collect_fee_on: 0, enable_dynamic_fee: !mut('K6') } }, [{ pubkey: dfc1, isWritable: false }])], [alice]);
    const sp = TIER8.tick_spacing;
    const t0 = (await account('PoolState', poolD)).tick_current;
    const lower = alignDown(t0 - 300, sp); const upper = alignDown(t0 + 300, sp);
    const taL = arrayStart(lower, sp); const taU = arrayStart(upper, sp);
    for (const a of new Set([taL, taU])) reg(PDA.tickArray(poolD, a), `pool D tick array ${a}`);
    const nft = Keypair.generate();
    reg(nft.publicKey, 'pool D position NFT mint'); reg(PDA.position(nft.publicKey), 'pool D position');
    reg(spl.getAssociatedTokenAddressSync(nft.publicKey, alice.publicKey, false, ADDR.token2022), 'pool D position NFT account');
    const vD0 = PDA.vault(poolD, D0); const vD1 = PDA.vault(poolD, D1);
    await must('alice adds a narrow range to pool D', [ix('open_position_with_token22_nft', {
      payer: alice.publicKey, position_nft_owner: alice.publicKey, position_nft_mint: nft.publicKey,
      position_nft_account: spl.getAssociatedTokenAddressSync(nft.publicKey, alice.publicKey, false, ADDR.token2022), pool_state: poolD, protocol_position: SystemProgram.programId,
      tick_array_lower: PDA.tickArray(poolD, taL), tick_array_upper: PDA.tickArray(poolD, taU), personal_position: PDA.position(nft.publicKey),
      token_account_0: ata(alice.publicKey, D0), token_account_1: ata(alice.publicKey, D1), token_vault_0: vD0, token_vault_1: vD1, vault_0_mint: D0, vault_1_mint: D1,
    }, {
      tick_lower_index: lower, tick_upper_index: upper, tick_array_lower_start_index: taL, tick_array_upper_start_index: taU,
      liquidity: 0n, amount_0_max: D0.equals(WSOL) ? 2n * 10n ** 9n : 400n * 10n ** 6n, amount_1_max: D0.equals(WSOL) ? 400n * 10n ** 6n : 2n * 10n ** 9n,
      with_metadata: false, base_flag: D0.equals(WSOL),
    })], [alice, nft]);
    // SOL in: the price of SOL falls, ticks move toward the lower array.
    const solIs0 = D0.equals(WSOL);
    const swapD = async (amount) => {
      const cur = arrayStart((await account('PoolState', poolD)).tick_current, sp);
      const list = [...new Set([taL, taU])];
      const ordered = solIs0 ? list.filter((s) => s <= cur).sort((a, b) => b - a) : list.filter((s) => s >= cur).sort((a, b) => a - b);
      return ix('swap_v2', {
        payer: alice.publicKey, amm_config: cfg8, pool_state: poolD, input_token_account: ata(alice.publicKey, WSOL), output_token_account: ata(alice.publicKey, USD),
        input_vault: PDA.vault(poolD, WSOL), output_vault: PDA.vault(poolD, USD), observation_state: PDA.observation(poolD), input_vault_mint: WSOL, output_vault_mint: USD,
      }, { amount, other_amount_threshold: 0n, sqrt_price_limit_x64: 0n, is_base_input: true },
      [{ pubkey: PDA.bitmap(poolD) }, ...ordered.map((s) => ({ pubkey: PDA.tickArray(poolD, s) }))]);
    };
    await must('alice swaps 1.5 SOL into pool D, moving its price many steps', [await swapD(15n * 10n ** 8n)], [alice]);
    const mid = await account('PoolState', poolD);
    const moved = Math.abs(mid.tick_current - t0) / sp;
    const amount = 10n ** 7n; // 0.01 SOL
    const protoBefore = solIs0 ? mid.protocol_fees_token_0 : mid.protocol_fees_token_1;
    await must('alice swaps 0.01 SOL more, inside the filter period', [await swapD(amount)], [alice]);
    const end = await account('PoolState', poolD);
    const proto = (solIs0 ? end.protocol_fees_token_0 : end.protocol_fees_token_1) - protoBefore;
    const t8 = await account('AmmConfig', cfg8);
    const rate = Number(proto) * 1e6 / t8.protocol_fee_rate / Number(amount) * 1e6; // per million of the swap
    check('K6', 'swap_v2 (dynamic fee)', 'a swap through a pool whose dynamic fee would add more than 1% to its 3% pays exactly 4%, the ceiling',
      end.dynamic_fee_info.volatility_accumulator >= 120_000 && rate <= 40_000 * 1.0001 && rate >= 40_000 * 0.999,
      `${moved.toFixed(1)} steps moved, volatility ${end.dynamic_fee_info.volatility_accumulator}, second swap paid ${(rate / 1e4).toFixed(3)}%`);
  }

  // ---- a permission and a second pool for the same pair ----------------------------------
  const perm = reg(PDA.permission(erin.publicKey), 'erin permission');
  const permIx = (name, owner) => ix(name, { owner, permission_authority: erin.publicKey, permission: perm });
  {
    const r = mut('X12') ? (await vaultRun('X12 mutant: the vault', [permIx('create_permission_pda', VAULT)])).execute
      : await send('a stranger grants a permission', [permIx('create_permission_pda', mallory.publicKey)], [mallory], { expectFail: true });
    check('X12', 'create_permission_pda', 'a stranger cannot grant the right to open extra pools', failedWith(r, 'NotApproved'), `refused: ${errName(r)}`);
  }
  if (!mut('X13')) await mustVault('vault grants erin a permission', [permIx('create_permission_pda', VAULT)]);
  const seeded = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return PublicKey.findProgramAddressSync([Buffer.from('pool'), cfg0.toBuffer(), M0.toBuffer(), M1.toBuffer(), b], ADDR.program)[0]; };
  const permPoolIx = (n) => { const pool = regPool(seeded(n), `pool BAYLA/SOL #${n}`, M0, M1); return ix('create_permissioned_pool', { payer: erin.publicKey, permission: perm, ...poolIxAccounts(erin.publicKey, cfg0, M0, M1, pool) }, { customizable_params: { sqrt_price_x64: 1n << 64n, collect_fee_on: 0, enable_dynamic_fee: false }, seed_index: n }); };
  {
    const r = await send('erin opens a second BAYLA/SOL 1% pool', [permPoolIx(1)], [erin]);
    check('X13', 'create_permissioned_pool', 'a permission holder can open another pool for a pair that has one', r.ok && !!(await conn.getAccountInfo(seeded(1))), r.ok ? 'pool #1 opened' : errName(r));
    if (!mut('X14')) await mustVault("vault withdraws erin's permission", [permIx('close_permission_pda', VAULT)]);
    const r2 = await send('erin tries pool #2 without it', [permPoolIx(2)], [erin], { expectFail: true });
    check('X14', 'close_permission_pda', 'once the vault withdraws the permission, no more extra pools', !r2.ok && !(await conn.getAccountInfo(perm)), `refused: ${errName(r2)}`);
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
