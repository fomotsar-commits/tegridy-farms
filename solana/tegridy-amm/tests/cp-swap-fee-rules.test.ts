/**
 * cp-swap's fee rules of 2026-11-03 on a local validator. solana-ci.yml's migration-rehearsal
 * job builds cp-swap with this wallet as `admin::ID` and its WSOL ATA as the pool-opening fee
 * receiver, then runs this file.
 *
 * The range-pool program's rules, carried over:
 *  - A tier charges a trader more than 0 and at most 4% (trade fee and creator fee together),
 *    and keeps at most 20% of its trade fee for the protocol and fund owners together.
 *  - Only a tier's fund owner collects the fund fee. The admin (the vault on mainnet) cannot.
 * Our own:
 *  - The admin hands a tier's fund fee over once, while it still holds it, and never again.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAssociatedTokenAddressSync,
  mintTo,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";

const AMM_CONFIG_SEED = Buffer.from("amm_config");
const POOL_SEED = Buffer.from("pool");
const POOL_VAULT_SEED = Buffer.from("pool_vault");
const POOL_LP_MINT_SEED = Buffer.from("pool_lp_mint");
const OBSERVATION_SEED = Buffer.from("observation");
const AUTH_SEED = Buffer.from("vault_and_lp_mint_auth_seed");
const U64_MAX = new BN("18446744073709551615");

/** What a failed send says, its last logs included: a refused `assert!` names its condition there. */
const failure = (e: unknown) => `${String(e)}\n${((e as { logs?: string[] }).logs ?? []).join("\n")}`;

describe("cp-swap fee rules", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as AnchorProvider;
  const conn = provider.connection;
  /** cp-swap's admin in this build. */
  const wallet = anchor.Wallet.local().payer;
  const cpSwap = new Program(
    JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/raydium_cp_swap.json"), "utf8")) as Idl,
    provider
  ) as Program<Idl>;
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, cpSwap.programId)[0];
  const tierAt = (index: number) => pda([AMM_CONFIG_SEED, new BN(index).toArrayLike(Buffer, "be", 2)]);
  const feeReceiver = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);

  /** Makes a tier as the admin; "" when it went through, else what refused it. */
  const makeTier = async (index: number, trade: number, protocol: number, fund: number, creator: number) => {
    try {
      await cpSwap.methods
        .createAmmConfig(index, new BN(trade), new BN(protocol), new BN(fund), new BN(0), new BN(creator))
        .accountsPartial({ owner: wallet.publicKey, ammConfig: tierAt(index), systemProgram: SystemProgram.programId })
        .rpc();
      return "";
    } catch (e) {
      return failure(e) || "refused";
    }
  };

  before(async () => {
    try {
      await createAssociatedTokenAccount(conn, wallet, NATIVE_MINT, wallet.publicKey);
    } catch {
      /* the rehearsal made it already */
    }
  });

  // [what, index, trade, protocol, fund, creator, the refusal's own words]
  const refused: [string, number, number, number, number, number, string][] = [
    ["a trade fee above 4%", 20, 40_001, 104_000, 56_000, 0, "assertion failed: trade_fee_rate + creator_fee_rate <= MAX_FEE_RATE_NUMERATOR"],
    ["a creator fee taking the total above 4%", 21, 30_000, 104_000, 56_000, 10_001, "assertion failed: trade_fee_rate + creator_fee_rate <= MAX_FEE_RATE_NUMERATOR"],
    ["a trade fee of 0", 22, 0, 104_000, 56_000, 0, "assertion failed: trade_fee_rate > 0"],
    ["protocol and fund rates above 20% together", 23, 10_000, 144_001, 56_000, 0, "assertion failed: fund_fee_rate + protocol_fee_rate <= MAX_PROTOCOL_AND_FUND_FEE_RATE"],
  ];
  for (const [what, index, trade, protocol, fund, creator, why] of refused) {
    it(`refuses a tier with ${what}`, async () => {
      assert.include(await makeTier(index, trade, protocol, fund, creator), why);
      assert.isNull(await conn.getAccountInfo(tierAt(index)), `no tier ${index} may exist`);
    });
  }

  // Controls: each ceiling itself, and the launch tier's own shape (it sits on the 20% one).
  it("makes a tier on each ceiling, and one shaped like the launch tier", async () => {
    assert.equal(await makeTier(24, 40_000, 140_000, 60_000, 0), "");
    assert.equal(await makeTier(25, 2_500, 130_000, 70_000, 5_000), "");
  });

  it("lets only the fund owner collect the fund fee, never the admin", async () => {
    const index = 30;
    assert.equal(await makeTier(index, 10_000, 104_000, 56_000, 0), "", "the 1% tier's shape");
    const tier = tierAt(index);
    const fundOwner = Keypair.generate();
    await cpSwap.methods
      .updateAmmConfig(4, new BN(0))
      .accountsPartial({ owner: wallet.publicKey, ammConfig: tier })
      .remainingAccounts([{ pubkey: fundOwner.publicKey, isSigner: false, isWritable: false }])
      .rpc();

    const a = await createMint(conn, wallet, wallet.publicKey, null, 6);
    const b = await createMint(conn, wallet, wallet.publicKey, null, 6);
    const [m0, m1] = Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
    const own = (m: PublicKey, who: PublicKey) => getAssociatedTokenAddressSync(m, who);
    for (const m of [m0, m1]) {
      await createAssociatedTokenAccount(conn, wallet, m, wallet.publicKey);
      await mintTo(conn, wallet, m, own(m, wallet.publicKey), wallet, 10_000_000_000);
      await createAssociatedTokenAccount(conn, wallet, m, fundOwner.publicKey);
    }

    const pool = pda([POOL_SEED, tier.toBuffer(), m0.toBuffer(), m1.toBuffer()]);
    const lp = pda([POOL_LP_MINT_SEED, pool.toBuffer()]);
    const vault0 = pda([POOL_VAULT_SEED, pool.toBuffer(), m0.toBuffer()]);
    const vault1 = pda([POOL_VAULT_SEED, pool.toBuffer(), m1.toBuffer()]);
    const authority = pda([AUTH_SEED]);
    const observationState = pda([OBSERVATION_SEED, pool.toBuffer()]);
    await cpSwap.methods
      .initialize(new BN(1_000_000_000), new BN(1_000_000_000), new BN(0))
      .accountsPartial({
        creator: wallet.publicKey,
        ammConfig: tier,
        authority,
        poolState: pool,
        token0Mint: m0,
        token1Mint: m1,
        lpMint: lp,
        creatorToken0: own(m0, wallet.publicKey),
        creatorToken1: own(m1, wallet.publicKey),
        creatorLpToken: own(lp, wallet.publicKey),
        token0Vault: vault0,
        token1Vault: vault1,
        createPoolFee: feeReceiver,
        observationState,
        tokenProgram: TOKEN_PROGRAM_ID,
        token0Program: TOKEN_PROGRAM_ID,
        token1Program: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // A pool opens one second after it is made; swap once it has.
    const opens = Number((await (cpSwap.account as any).poolState.fetch(pool)).openTime);
    for (let i = 0; i < 40 && ((await conn.getBlockTime(await conn.getSlot())) ?? 0) < opens; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    await cpSwap.methods
      .swapBaseInput(new BN(100_000_000), new BN(0))
      .accountsPartial({
        payer: wallet.publicKey,
        authority,
        ammConfig: tier,
        poolState: pool,
        inputTokenAccount: own(m0, wallet.publicKey),
        outputTokenAccount: own(m1, wallet.publicKey),
        inputVault: vault0,
        outputVault: vault1,
        inputTokenProgram: TOKEN_PROGRAM_ID,
        outputTokenProgram: TOKEN_PROGRAM_ID,
        inputTokenMint: m0,
        outputTokenMint: m1,
        observationState,
      })
      .rpc();
    const owed = BigInt((await (cpSwap.account as any).poolState.fetch(pool)).fundFeesToken0.toString());
    assert.isTrue(owed > 0n, "the swap built up a fund fee");

    const collect = (signer: Keypair) =>
      cpSwap.methods
        .collectFundFee(U64_MAX, U64_MAX)
        .accountsPartial({
          owner: signer.publicKey,
          authority,
          poolState: pool,
          ammConfig: tier,
          token0Vault: vault0,
          token1Vault: vault1,
          vault0Mint: m0,
          vault1Mint: m1,
          recipientToken0Account: own(m0, signer.publicKey),
          recipientToken1Account: own(m1, signer.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        })
        .signers([signer])
        .rpc();

    let refused = "";
    try {
      await collect(wallet);
    } catch (e) {
      refused = failure(e);
    }
    assert.include(refused, "InvalidOwner", "the admin collecting the fund fee must be refused");
    const after = BigInt((await (cpSwap.account as any).poolState.fetch(pool)).fundFeesToken0.toString());
    assert.equal(after.toString(), owed.toString(), "the fund fee stays owed to the fund owner");

    await collect(fundOwner);
    const got = BigInt((await conn.getTokenAccountBalance(own(m0, fundOwner.publicKey))).value.amount);
    assert.equal(got.toString(), owed.toString(), "the fund owner collects exactly what built up");
    const left = BigInt((await (cpSwap.account as any).poolState.fetch(pool)).fundFeesToken0.toString());
    assert.equal(left.toString(), "0");
  });

  // The admin hands a new tier's fund fee over once (create_amm_config makes the admin its fund
  // owner). After that it cannot point it anywhere else. One tier per target, so one target
  // going through cannot hide the other.
  const targets: [string, number, () => PublicKey][] = [
    ["back at the admin", 31, () => wallet.publicKey],
    ["at another wallet", 32, () => Keypair.generate().publicKey],
  ];
  for (const [what, index, target] of targets) {
    it(`never lets the admin point a handed-over fund fee ${what}`, async () => {
      assert.equal(await makeTier(index, 10_000, 104_000, 56_000, 0), "", "the 1% tier's shape");
      const tier = tierAt(index);
      const pointAt = async (who: PublicKey) => {
        try {
          await cpSwap.methods
            .updateAmmConfig(4, new BN(0))
            .accountsPartial({ owner: wallet.publicKey, ammConfig: tier })
            .remainingAccounts([{ pubkey: who, isSigner: false, isWritable: false }])
            .rpc();
          return "";
        } catch (e) {
          return failure(e) || "refused";
        }
      };
      const fundOwner = async () => ((await (cpSwap.account as any).ammConfig.fetch(tier)).fundOwner as PublicKey).toBase58();
      const island = Keypair.generate().publicKey;
      assert.equal(await pointAt(island), "", "the first hand-over goes through");
      assert.equal(await fundOwner(), island.toBase58());

      const refused = await pointAt(target());
      assert.include(refused, "InvalidOwner", "a second hand-over must be refused");
      assert.include(refused, "update_config.rs", "by the hand-over rule, not the signer check");
      assert.equal(await fundOwner(), island.toBase58(), "the fund fee stays with its owner");
    });
  }
});
