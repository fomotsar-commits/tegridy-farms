//! The order program and the venue's swap program (the mainnet build of
//! solana/tegridy-amm/programs/cp-swap, swap guard on, keeper named) run together in LiteSVM,
//! with the clock in hand. Build the three programs first (docs/VWAP_ORDER_PROGRAM.md, Tests):
//! `VWAP_ORDER_SO`, `CP_SWAP_SO` and `CPI_CALLER_SO` name the files, defaulting to the builds'
//! own places in this checkout.
#![cfg(test)]

use anchor_lang::prelude::{Clock, Pubkey};
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::solana_program::{system_instruction, system_program, sysvar};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::ExtensionType;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use vwap_order::{OpenArgs, Order, OrderError};

const CP: Pubkey = anchor_lang::pubkey!("EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT");
const POOL_FEE_RECEIVER: Pubkey = anchor_lang::pubkey!("2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa");
const T0: i64 = 1_800_000_000;
const RESERVE: u64 = 100_000_000_000;
const TIP: u64 = 10_000;
const CPI_CALLER: &str = "../../tegridy-amm/tests/cpi-caller/target/deploy/cpi_caller.so";

/// A program file: the one `var` names, or `default` from this folder (cargo test runs here).
fn so(var: &str, default: &str) -> Vec<u8> {
    let path = std::env::var(var).unwrap_or_else(|_| default.to_string());
    std::fs::read(&path).unwrap_or_else(|e| panic!("{var}: cannot read {path}: {e}"))
}

fn name(preimage: &str) -> [u8; 8] {
    solana_sha256_hasher::hash(preimage.as_bytes()).to_bytes()[..8]
        .try_into()
        .unwrap()
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

/// The custom error a failed transaction ended on, if any.
fn code<T, E: std::fmt::Debug>(r: &Result<T, E>) -> Option<u32> {
    let e = format!("{:?}", r.as_ref().err()?);
    let at = e.find("Custom(")? + 7;
    e[at..].split(')').next()?.parse().ok()
}

fn err(e: OrderError) -> Option<u32> {
    Some(u32::from(e))
}

struct World {
    svm: LiteSVM,
    payer: Keypair,
    keeper: Keypair,
    config: Pubkey,
    pool: Pubkey,
    observation: Pubkey,
    /// A classic SPL coin (9 places, like wrapped SOL) and a Token-2022 coin (6, like BAYLA).
    classic: Pubkey,
    t22: Pubkey,
    token_0: Pubkey,
    token_1: Pubkey,
    vault_0: Pubkey,
    vault_1: Pubkey,
}

/// The token program that owns `mint`.
fn program_of(mint: &Pubkey, w: &World) -> Pubkey {
    w.svm.get_account(mint).unwrap().owner
}

impl World {
    fn new() -> World {
        let mut svm = LiteSVM::new();
        let _ = svm.add_program(vwap_order::ID, &so("VWAP_ORDER_SO", "../target/deploy/vwap_order.so"));
        let _ = svm.add_program(
            CP,
            &so("CP_SWAP_SO", "../../tegridy-amm/target/deploy/raydium_cp_swap.so"),
        );
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
        let mut w = World {
            svm,
            payer,
            keeper: Keypair::new(),
            config: Pubkey::default(),
            pool: Pubkey::default(),
            observation: Pubkey::default(),
            classic: Pubkey::default(),
            t22: Pubkey::default(),
            token_0: Pubkey::default(),
            token_1: Pubkey::default(),
            vault_0: Pubkey::default(),
            vault_1: Pubkey::default(),
        };
        w.at(T0);
        w.classic = w.mint(spl_token::ID, 9, &[]);
        w.t22 = w.mint(spl_token_2022::ID, 6, &[ExtensionType::MetadataPointer]);
        w.open_tier();
        w.open_pool();
        w
    }

    fn at(&mut self, t: i64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = t;
        c.slot += 1;
        self.svm.set_sysvar(&c);
    }

    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<u64, String> {
        let mut all: Vec<&Keypair> = vec![&self.payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&self.payer.pubkey()),
            &all,
            self.svm.latest_blockhash(),
        );
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        match r {
            Ok(m) => Ok(m.compute_units_consumed),
            Err(f) => Err(format!("{:?} {:?}", f.err, f.meta.logs)),
        }
    }

    fn lamports(&self, k: &Pubkey) -> u64 {
        self.svm.get_account(k).map(|a| a.lamports).unwrap_or(0)
    }

    fn exists(&self, k: &Pubkey) -> bool {
        self.svm.get_account(k).is_some_and(|a| a.lamports > 0)
    }

    fn balance(&self, k: &Pubkey) -> u64 {
        let a = self.svm.get_account(k).unwrap();
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    }

    /// A mint with the payer as its authority, with these Token-2022 extensions set up first.
    fn mint(&mut self, program: Pubkey, decimals: u8, extensions: &[ExtensionType]) -> Pubkey {
        let m = Keypair::new();
        let len = if program == spl_token::ID {
            spl_token::state::Mint::LEN
        } else {
            ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(extensions).unwrap()
        };
        let mut ixs = vec![system_instruction::create_account(
            &self.payer.pubkey(),
            &m.pubkey(),
            self.svm.minimum_balance_for_rent_exemption(len),
            len as u64,
            &program,
        )];
        for e in extensions {
            ixs.push(match e {
                ExtensionType::MetadataPointer => {
                    spl_token_2022::extension::metadata_pointer::instruction::initialize(
                        &program,
                        &m.pubkey(),
                        Some(self.payer.pubkey()),
                        Some(m.pubkey()),
                    )
                    .unwrap()
                }
                ExtensionType::PermanentDelegate => {
                    spl_token_2022::instruction::initialize_permanent_delegate(
                        &program,
                        &m.pubkey(),
                        &self.payer.pubkey(),
                    )
                    .unwrap()
                }
                _ => unreachable!(),
            });
        }
        ixs.push(
            spl_token_2022::instruction::initialize_mint2(
                &program,
                &m.pubkey(),
                &self.payer.pubkey(),
                None,
                decimals,
            )
            .unwrap(),
        );
        self.send(&ixs, &[&m]).unwrap();
        m.pubkey()
    }

    /// A token account of `mint` for `owner`, holding `amount` minted to it.
    fn account(&mut self, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
        let program = self.svm.get_account(mint).unwrap().owner;
        let a = Keypair::new();
        let len = spl_token::state::Account::LEN;
        let mut ixs = vec![
            system_instruction::create_account(
                &self.payer.pubkey(),
                &a.pubkey(),
                self.svm.minimum_balance_for_rent_exemption(len),
                len as u64,
                &program,
            ),
            spl_token_2022::instruction::initialize_account3(&program, &a.pubkey(), mint, owner)
                .unwrap(),
        ];
        if amount > 0 {
            ixs.push(
                spl_token_2022::instruction::mint_to(
                    &program,
                    mint,
                    &a.pubkey(),
                    &self.payer.pubkey(),
                    &[],
                    amount,
                )
                .unwrap(),
            );
        }
        self.send(&ixs, &[&a]).unwrap();
        a.pubkey()
    }

    /// Fee tier 1 as mainnet's 1% tier holds it (states/config.rs), guard on, keeper named.
    fn open_tier(&mut self) {
        let (config, bump) = Pubkey::find_program_address(&[b"amm_config", &1u16.to_be_bytes()], &CP);
        let mut d = Vec::with_capacity(236);
        d.extend_from_slice(&name("account:AmmConfig"));
        d.push(bump);
        d.push(0); // disable_create_pool
        d.extend_from_slice(&1u16.to_le_bytes());
        for rate in [10_000u64, 104_000, 56_000, 0] {
            d.extend_from_slice(&rate.to_le_bytes()); // trade, protocol, fund, create_pool_fee
        }
        d.extend_from_slice(Pubkey::new_unique().as_ref()); // protocol_owner
        d.extend_from_slice(Pubkey::new_unique().as_ref()); // fund_owner
        d.extend_from_slice(&0u64.to_le_bytes()); // creator_fee_rate
        d.extend_from_slice(&1u64.to_le_bytes()); // swap_guard on
        d.extend_from_slice(self.keeper.pubkey().as_ref());
        d.resize(236, 0);
        let lamports = self.svm.minimum_balance_for_rent_exemption(236);
        self.svm
            .set_account(config, Account { lamports, data: d, owner: CP, executable: false, rent_epoch: 0 })
            .unwrap();
        // The opening fee's wrapped-SOL account must exist; tier 1 here charges no fee.
        let mut acct = vec![0u8; spl_token::state::Account::LEN];
        spl_token::state::Account {
            mint: spl_token::native_mint::ID,
            owner: Pubkey::new_unique(),
            state: spl_token::state::AccountState::Initialized,
            ..Default::default()
        }
        .pack_into_slice(&mut acct);
        let lamports = self.svm.minimum_balance_for_rent_exemption(acct.len());
        self.svm
            .set_account(
                POOL_FEE_RECEIVER,
                Account { lamports, data: acct, owner: spl_token::ID, executable: false, rent_epoch: 0 },
            )
            .unwrap();
        self.config = config;
    }

    fn open_pool(&mut self) {
        let (t0, t1) = if self.classic < self.t22 { (self.classic, self.t22) } else { (self.t22, self.classic) };
        let creator = self.payer.pubkey();
        let c0 = self.account(&t0, &creator, RESERVE);
        let c1 = self.account(&t1, &creator, RESERVE);
        let pool = pda(&[b"pool", self.config.as_ref(), t0.as_ref(), t1.as_ref()], &CP);
        let lp_mint = pda(&[b"pool_lp_mint", pool.as_ref()], &CP);
        let lp_ata = pda(
            &[creator.as_ref(), spl_token::ID.as_ref(), lp_mint.as_ref()],
            &anchor_spl::associated_token::ID,
        );
        let v0 = pda(&[b"pool_vault", pool.as_ref(), t0.as_ref()], &CP);
        let v1 = pda(&[b"pool_vault", pool.as_ref(), t1.as_ref()], &CP);
        let obs = pda(&[b"observation", pool.as_ref()], &CP);
        let (p0, p1) = (program_of(&t0, self), program_of(&t1, self));
        let accounts = vec![
            AccountMeta::new(creator, true),
            AccountMeta::new_readonly(self.config, false),
            AccountMeta::new_readonly(pda(&[b"vault_and_lp_mint_auth_seed"], &CP), false),
            AccountMeta::new(pool, false),
            AccountMeta::new_readonly(t0, false),
            AccountMeta::new_readonly(t1, false),
            AccountMeta::new(lp_mint, false),
            AccountMeta::new(c0, false),
            AccountMeta::new(c1, false),
            AccountMeta::new(lp_ata, false),
            AccountMeta::new(v0, false),
            AccountMeta::new(v1, false),
            AccountMeta::new(POOL_FEE_RECEIVER, false),
            AccountMeta::new(obs, false),
            AccountMeta::new_readonly(spl_token::ID, false),
            AccountMeta::new_readonly(p0, false),
            AccountMeta::new_readonly(p1, false),
            AccountMeta::new_readonly(anchor_spl::associated_token::ID, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(sysvar::rent::ID, false),
        ];
        let mut data = name("global:initialize").to_vec();
        for v in [RESERVE, RESERVE, 0u64] {
            data.extend_from_slice(&v.to_le_bytes());
        }
        self.send(&[Instruction { program_id: CP, accounts, data }], &[]).unwrap();
        (self.pool, self.observation, self.token_0, self.token_1, self.vault_0, self.vault_1) =
            (pool, obs, t0, t1, v0, v1);
        // The pool opens a second later; its first swap starts its price record.
        self.at(T0 + 2);
        let trader = Keypair::new();
        self.svm.airdrop(&trader.pubkey(), 1_000_000_000).unwrap();
        let a = self.account(&self.classic.clone(), &trader.pubkey(), 1_000);
        let b = self.account(&self.t22.clone(), &trader.pubkey(), 0);
        self.swap_by(&trader, &a, &b, &self.classic.clone(), 1_000).unwrap();
    }

    /// cp-swap's own `swap_base_input`, from `from` (a `mint_in` account) into `to`.
    fn swap_ix(&self, payer: &Pubkey, from: &Pubkey, to: &Pubkey, mint_in: &Pubkey, amount: u64) -> Instruction {
        let mint_out = if *mint_in == self.token_0 { self.token_1 } else { self.token_0 };
        let (vin, vout) = if *mint_in == self.token_0 { (self.vault_0, self.vault_1) } else { (self.vault_1, self.vault_0) };
        let mut data = name("global:swap_base_input").to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        Instruction {
            program_id: CP,
            accounts: vec![
                AccountMeta::new_readonly(*payer, true),
                AccountMeta::new_readonly(pda(&[b"vault_and_lp_mint_auth_seed"], &CP), false),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.pool, false),
                AccountMeta::new(*from, false),
                AccountMeta::new(*to, false),
                AccountMeta::new(vin, false),
                AccountMeta::new(vout, false),
                AccountMeta::new_readonly(program_of(mint_in, self), false),
                AccountMeta::new_readonly(program_of(&mint_out, self), false),
                AccountMeta::new_readonly(*mint_in, false),
                AccountMeta::new_readonly(mint_out, false),
                AccountMeta::new(self.observation, false),
            ],
            data,
        }
    }

    fn swap_by(&mut self, who: &Keypair, from: &Pubkey, to: &Pubkey, mint_in: &Pubkey, amount: u64) -> Result<u64, String> {
        let ix = self.swap_ix(&who.pubkey(), from, to, mint_in, amount);
        self.send(&[ix], &[who])
    }

    /// Bytes 341.. of PoolState: the venue's (protocol) and the island's (fund) fees owed.
    fn fees_owed(&self) -> [u64; 4] {
        let d = self.svm.get_account(&self.pool).unwrap().data;
        let at = |i: usize| u64::from_le_bytes(d[341 + 8 * i..349 + 8 * i].try_into().unwrap());
        [at(0), at(1), at(2), at(3)]
    }
}

/// One person's order: their wallet, their two token accounts, its three accounts.
struct Person {
    who: Keypair,
    input: Pubkey,
    output: Pubkey,
    input_mint: Pubkey,
    output_mint: Pubkey,
    order: Pubkey,
    in_vault: Pubkey,
    out_vault: Pubkey,
}

fn args(total_in: u64, start_at: i64, slices: u8) -> OpenArgs {
    OpenArgs {
        id: 7,
        total_in,
        min_out_total: total_in / 2,
        start_at,
        interval: 600,
        slices,
        band_bps: 200,
        tip_lamports: TIP,
        weights: vec![],
    }
}

/// A person selling the Token-2022 coin (`sells_t22`) or the classic one.
fn person(w: &mut World, sells_t22: bool, holds: u64) -> Person {
    let input_mint = if sells_t22 { w.t22 } else { w.classic };
    let who = Keypair::new();
    w.svm.airdrop(&who.pubkey(), 1_000_000_000).unwrap();
    let output_mint = if input_mint == w.classic { w.t22 } else { w.classic };
    let input = w.account(&input_mint, &who.pubkey(), holds);
    let output = w.account(&output_mint, &who.pubkey(), 0);
    let order = pda(&[b"order", who.pubkey().as_ref(), &7u64.to_le_bytes()], &vwap_order::ID);
    Person {
        input,
        output,
        input_mint,
        output_mint,
        in_vault: pda(&[b"in", order.as_ref()], &vwap_order::ID),
        out_vault: pda(&[b"out", order.as_ref()], &vwap_order::ID),
        order,
        who,
    }
}

fn open_ix(w: &World, p: &Person, a: OpenArgs, pool: Pubkey, observation: Pubkey) -> Instruction {
    Instruction {
        program_id: vwap_order::ID,
        accounts: vwap_order::accounts::OpenOrder {
            owner: p.who.pubkey(),
            order: p.order,
            pool,
            observation,
            input_mint: p.input_mint,
            output_mint: p.output_mint,
            owner_input: p.input,
            in_vault: p.in_vault,
            out_vault: p.out_vault,
            input_token_program: program_of(&p.input_mint, w),
            output_token_program: program_of(&p.output_mint, w),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: vwap_order::instruction::OpenOrder { args: a }.data(),
    }
}

fn open(w: &mut World, p: &Person, a: OpenArgs) -> Result<u64, String> {
    let ix = open_ix(w, p, a, w.pool, w.observation);
    let who = p.who.insecure_clone();
    w.send(&[ix], &[&who])
}

fn begin_ix(w: &World, p: &Person, cranker: &Pubkey) -> Instruction {
    Instruction {
        program_id: vwap_order::ID,
        accounts: vwap_order::accounts::BeginSlice {
            cranker: *cranker,
            order: p.order,
            amm_config: w.config,
            in_vault: p.in_vault,
            out_vault: p.out_vault,
            input_mint: p.input_mint,
            input_token_program: program_of(&p.input_mint, w),
            instructions: sysvar::instructions::ID,
        }
        .to_account_metas(None),
        data: vwap_order::instruction::BeginSlice {}.data(),
    }
}

fn end_ix(w: &World, p: &Person, cranker: &Pubkey) -> Instruction {
    Instruction {
        program_id: vwap_order::ID,
        accounts: vwap_order::accounts::EndSlice {
            cranker: *cranker,
            order: p.order,
            observation: w.observation,
            in_vault: p.in_vault,
            out_vault: p.out_vault,
        }
        .to_account_metas(None),
        data: vwap_order::instruction::EndSlice {}.data(),
    }
}

/// The three instructions of a slice, the runner signing.
fn slice(w: &mut World, p: &Person, runner: &Keypair, amount: u64) -> Result<u64, String> {
    let r = runner.pubkey();
    let ixs = [
        begin_ix(w, p, &r),
        w.swap_ix(&r, &p.in_vault, &p.out_vault, &p.input_mint, amount),
        end_ix(w, p, &r),
    ];
    w.send(&ixs, &[runner])
}

fn close_ix(w: &World, p: &Person, owner: &Pubkey, to_in: &Pubkey, to_out: &Pubkey) -> Instruction {
    Instruction {
        program_id: vwap_order::ID,
        accounts: vwap_order::accounts::CloseOrder {
            owner: *owner,
            order: p.order,
            in_vault: p.in_vault,
            out_vault: p.out_vault,
            input_mint: p.input_mint,
            output_mint: p.output_mint,
            owner_input: *to_in,
            owner_output: *to_out,
            input_token_program: program_of(&p.input_mint, w),
            output_token_program: program_of(&p.output_mint, w),
        }
        .to_account_metas(None),
        data: vwap_order::instruction::CloseOrder {}.data(),
    }
}

fn order(w: &World, p: &Person) -> Order {
    let a = w.svm.get_account(&p.order).unwrap();
    Order::try_deserialize(&mut a.data.as_slice()).unwrap()
}

fn runner(w: &mut World) -> Keypair {
    let r = Keypair::new();
    w.svm.airdrop(&r.pubkey(), 1_000_000_000).unwrap();
    r
}

const START: i64 = T0 + 600;

// ── what a slice does ─────────────────────────────────────────────────────────

#[test]
fn a_slice_sells_through_the_venue_pool_pays_its_fee_and_tips_the_runner() {
    let mut w = World::new();
    let p = person(&mut w, true, 1_000_000_000);
    open(&mut w, &p, args(1_000_000_000, START, 4)).unwrap();
    assert_eq!(w.balance(&p.in_vault), 1_000_000_000);
    assert_eq!(w.balance(&p.input), 0);

    let r = runner(&mut w);
    let before = (w.fees_owed(), w.lamports(&r.pubkey()));
    w.at(START);
    let cu = slice(&mut w, &p, &r, 250_000_000).unwrap();
    println!("a slice's three instructions used {cu} compute units");

    assert_eq!(w.balance(&p.in_vault), 750_000_000);
    let got = w.balance(&p.out_vault);
    // Mid price 1:1, the pool's 1% fee, a 0.25% move: about 98.5% of the slice.
    assert!(got > 980_000_000 / 4 && got < 990_000_000 / 4, "got {got}");
    // The venue's and the island's shares of the trade fee, in the coin sold.
    let after = w.fees_owed();
    let i = if p.input_mint == w.token_0 { 0 } else { 1 };
    assert_eq!(after[i] - before.0[i], 260_000, "venue: 10.4% of the 2,500,000 fee");
    assert_eq!(after[2 + i] - before.0[2 + i], 140_000, "island: 5.6% of the fee");
    assert_eq!(w.lamports(&r.pubkey()) - before.1, TIP);
    let o = order(&w, &p);
    assert_eq!((o.next_slice, o.slices_filled, o.spent_in, o.received_out), (1, 1, 250_000_000, got));
}

#[test]
fn token_2022_works_both_ways_in_and_out_of_the_escrow() {
    let mut w = World::new();
    let buyer = person(&mut w, false, 400_000_000);
    open(&mut w, &buyer, args(400_000_000, START, 4)).unwrap();
    let r = runner(&mut w);
    w.at(START);
    slice(&mut w, &buyer, &r, 100_000_000).unwrap();
    assert!(w.balance(&buyer.out_vault) > 98_000_000);
    let to_in = buyer.input;
    let to_out = buyer.output;
    let ix = close_ix(&w, &buyer, &buyer.who.pubkey(), &to_in, &to_out);
    let who = buyer.who.insecure_clone();
    w.send(&[ix], &[&who]).unwrap();
    assert_eq!(w.balance(&buyer.input), 300_000_000);
    assert!(w.balance(&buyer.output) > 98_000_000);
}

#[test]
fn volume_weights_set_each_slice_and_the_swap_must_spend_exactly_it() {
    let mut w = World::new();
    let p = person(&mut w, true, 1_000_000_000);
    let mut a = args(1_000_000_000, START, 2);
    a.weights = vec![1, 3];
    open(&mut w, &p, a).unwrap();
    let r = runner(&mut w);
    w.at(START);
    assert_eq!(code(&slice(&mut w, &p, &r, 500_000_000)), err(OrderError::SwapWrongAmount));
    slice(&mut w, &p, &r, 250_000_000).unwrap();
    w.at(START + 900);
    slice(&mut w, &p, &r, 750_000_000).unwrap();
    assert_eq!(w.balance(&p.in_vault), 0);
}

// ── when a slice may run ──────────────────────────────────────────────────────

#[test]
fn a_slice_runs_in_its_own_window_once_and_a_missed_window_stays_in_the_escrow() {
    let mut w = World::new();
    let p = person(&mut w, true, 1_000_000_000);
    open(&mut w, &p, args(1_000_000_000, START, 4)).unwrap();
    let r = runner(&mut w);
    w.at(START - 1);
    assert_eq!(code(&slice(&mut w, &p, &r, 250_000_000)), err(OrderError::NoWindow));
    w.at(START);
    slice(&mut w, &p, &r, 250_000_000).unwrap();
    w.at(START + 400);
    assert_eq!(code(&slice(&mut w, &p, &r, 250_000_000)), err(OrderError::SliceDone));
    // Window 1 passes with nobody running it; window 2 runs.
    w.at(START + 1_300);
    slice(&mut w, &p, &r, 250_000_000).unwrap();
    assert_eq!(order(&w, &p).next_slice, 3);
    w.at(START + 2_400);
    assert_eq!(code(&slice(&mut w, &p, &r, 250_000_000)), err(OrderError::NoWindow));
    assert_eq!(w.balance(&p.in_vault), 500_000_000);
}

#[test]
fn the_average_needs_five_minutes_since_the_previous_slice() {
    let mut w = World::new();
    let p = person(&mut w, true, 1_000_000_000);
    open(&mut w, &p, args(1_000_000_000, START, 4)).unwrap();
    let r = runner(&mut w);
    w.at(START + 599);
    slice(&mut w, &p, &r, 250_000_000).unwrap();
    w.at(START + 600);
    assert_eq!(code(&slice(&mut w, &p, &r, 250_000_000)), err(OrderError::AverageTooShort));
    w.at(START + 899);
    slice(&mut w, &p, &r, 250_000_000).unwrap();
}

// ── what the runner cannot do ─────────────────────────────────────────────────

#[test]
fn the_runner_cannot_spend_the_slice_any_other_way() {
    let mut w = World::new();
    let p = person(&mut w, true, 1_000_000_000);
    open(&mut w, &p, args(1_000_000_000, START, 4)).unwrap();
    let r = runner(&mut w);
    let rk = r.pubkey();
    let mine = w.account(&p.input_mint.clone(), &rk, 0);
    let mine_out = w.account(&p.output_mint.clone(), &rk, 0);
    w.at(START);

    // The lent slice moved to the runner's own account by a plain transfer.
    let steal = spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::ID, &p.in_vault, &p.input_mint, &mine, &rk, &[], 250_000_000, 6,
    )
    .unwrap();
    let ixs = [begin_ix(&w, &p, &rk), steal, end_ix(&w, &p, &rk)];
    assert_eq!(code(&w.send(&ixs, &[&r])), err(OrderError::SwapMissing));
    // A begin alone, and a begin and a swap with no end.
    assert_eq!(code(&w.send(&[begin_ix(&w, &p, &rk)], &[&r])), err(OrderError::SwapMissing));
    let swap = w.swap_ix(&rk, &p.in_vault, &p.out_vault, &p.input_mint, 250_000_000);
    assert_eq!(code(&w.send(&[begin_ix(&w, &p, &rk), swap], &[&r])), err(OrderError::EndMissing));
    // A begin and a swap, then anything but this order's end (the slice would skip both price
    // checks and leave the order taking no more slices).
    let swap = w.swap_ix(&rk, &p.in_vault, &p.out_vault, &p.input_mint, 250_000_000);
    let other = system_instruction::transfer(&rk, &rk, 1);
    let ixs = [begin_ix(&w, &p, &rk), swap, other];
    assert_eq!(code(&w.send(&ixs, &[&r])), err(OrderError::EndMissing));
    // The swap's output sent to the runner instead of the order.
    let swap = w.swap_ix(&rk, &p.in_vault, &mine_out, &p.input_mint, 250_000_000);
    let ixs = [begin_ix(&w, &p, &rk), swap, end_ix(&w, &p, &rk)];
    assert_eq!(code(&w.send(&ixs, &[&r])), err(OrderError::SwapWrongAccounts));
    // The swap naming a pool account other than the order's own (a byte-for-byte twin).
    let twin = Pubkey::new_unique();
    let twin_account = w.svm.get_account(&w.pool).unwrap();
    w.svm.set_account(twin, twin_account).unwrap();
    let mut swap = w.swap_ix(&rk, &p.in_vault, &p.out_vault, &p.input_mint, 250_000_000);
    swap.accounts[3].pubkey = twin;
    let ixs = [begin_ix(&w, &p, &rk), swap, end_ix(&w, &p, &rk)];
    assert_eq!(code(&w.send(&ixs, &[&r])), err(OrderError::SwapWrongAccounts));
    // The other swap instruction, by its exact output.
    let mut swap = w.swap_ix(&rk, &p.in_vault, &p.out_vault, &p.input_mint, 250_000_000);
    swap.data[..8].copy_from_slice(&name("global:swap_base_output"));
    let ixs = [begin_ix(&w, &p, &rk), swap, end_ix(&w, &p, &rk)];
    assert_eq!(code(&w.send(&ixs, &[&r])), err(OrderError::SwapMissing));
    // The swap's exact bytes and accounts, sent to another program (the test-only caller,
    // which would hand them on to our pool from inside itself).
    let caller = Pubkey::new_unique();
    let _ = w.svm.add_program(caller, &so("CPI_CALLER_SO", CPI_CALLER));
    let mut inner = w.swap_ix(&rk, &p.in_vault, &p.out_vault, &p.input_mint, 250_000_000);
    let mut accounts = vec![AccountMeta::new_readonly(CP, false)];
    accounts.append(&mut inner.accounts);
    let forwarded = Instruction { program_id: caller, accounts, data: inner.data };
    let ixs = [begin_ix(&w, &p, &rk), forwarded, end_ix(&w, &p, &rk)];
    assert_eq!(code(&w.send(&ixs, &[&r])), err(OrderError::SwapMissing));
    // An end with no begin.
    assert_eq!(code(&w.send(&[end_ix(&w, &p, &rk)], &[&r])), err(OrderError::NoSliceOpen));
    assert_eq!(w.balance(&p.in_vault), 1_000_000_000);
    assert_eq!(w.balance(&mine), 0);
}

#[test]
fn the_pools_keeper_pays_no_fee_so_it_may_not_run_a_slice() {
    let mut w = World::new();
    let p = person(&mut w, true, 1_000_000_000);
    open(&mut w, &p, args(1_000_000_000, START, 4)).unwrap();
    let keeper = w.keeper.insecure_clone();
    w.svm.airdrop(&keeper.pubkey(), 1_000_000_000).unwrap();
    w.at(START);
    assert_eq!(code(&slice(&mut w, &p, &keeper, 250_000_000)), err(OrderError::KeeperPaysNoFee));
    let r = runner(&mut w);
    slice(&mut w, &p, &r, 250_000_000).unwrap();
}

#[test]
fn a_slice_called_from_inside_another_program_is_refused() {
    let mut w = World::new();
    let caller = Pubkey::new_unique();
    let _ = w.svm.add_program(caller, &so("CPI_CALLER_SO", CPI_CALLER));
    let p = person(&mut w, true, 1_000_000_000);
    open(&mut w, &p, args(1_000_000_000, START, 4)).unwrap();
    let r = runner(&mut w);
    let rk = r.pubkey();
    w.at(START);
    let mut inner = begin_ix(&w, &p, &rk);
    let mut accounts = vec![AccountMeta::new_readonly(vwap_order::ID, false)];
    accounts.append(&mut inner.accounts);
    let wrapped = Instruction { program_id: caller, accounts, data: inner.data };
    let ixs = [
        wrapped,
        w.swap_ix(&rk, &p.in_vault, &p.out_vault, &p.input_mint, 250_000_000),
        end_ix(&w, &p, &rk),
    ];
    assert_eq!(code(&w.send(&ixs, &[&r])), err(OrderError::NotDirect));
}

// ── the price checks ──────────────────────────────────────────────────────────

#[test]
fn a_slice_below_the_persons_worst_price_is_refused_and_nothing_moves() {
    let mut w = World::new();
    let p = person(&mut w, true, 1_000_000_000);
    let mut a = args(1_000_000_000, START, 4);
    a.min_out_total = 999_000_000; // better than the pool can give after its 1% fee
    open(&mut w, &p, a).unwrap();
    let r = runner(&mut w);
    w.at(START);
    assert_eq!(code(&slice(&mut w, &p, &r, 250_000_000)), err(OrderError::BelowLimit));
    assert_eq!(w.balance(&p.in_vault), 1_000_000_000);
    assert_eq!(w.balance(&p.out_vault), 0);
}

#[test]
fn a_price_pushed_just_before_the_slice_is_refused_by_the_pools_average() {
    let mut w = World::new();
    let p = person(&mut w, true, 1_000_000_000);
    open(&mut w, &p, args(1_000_000_000, START, 4)).unwrap(); // worst price: half
    let attacker = runner(&mut w);
    let ak = attacker.pubkey();
    let push_from = w.account(&p.input_mint.clone(), &ak, 10_000_000_000);
    let push_to = w.account(&p.output_mint.clone(), &ak, 0);
    w.at(START);
    // The runner sells 10% of the pool's depth first, in the same second, then the slice.
    let r = ak;
    let ixs = [
        w.swap_ix(&ak, &push_from, &push_to, &p.input_mint, 10_000_000_000),
        begin_ix(&w, &p, &r),
        w.swap_ix(&r, &p.in_vault, &p.out_vault, &p.input_mint, 250_000_000),
        end_ix(&w, &p, &r),
    ];
    assert_eq!(code(&w.send(&ixs, &[&attacker])), err(OrderError::BelowAverage));
    // The same slice, unpushed, runs.
    slice(&mut w, &p, &attacker, 250_000_000).unwrap();
}

// ── what the person signs ─────────────────────────────────────────────────────

#[test]
fn a_coin_with_a_permanent_delegate_is_refused() {
    let mut w = World::new();
    let bad = w.mint(spl_token_2022::ID, 6, &[ExtensionType::PermanentDelegate]);
    let mut p = person(&mut w, true, 1_000_000_000);
    p.output_mint = bad;
    assert_eq!(code(&open(&mut w, &p, args(1_000_000_000, START, 4))), err(OrderError::UnsupportedMint));
}

#[test]
fn a_pool_that_is_not_the_venues_is_refused() {
    let mut w = World::new();
    let p = person(&mut w, true, 1_000_000_000);
    // The real pool's bytes, owned by another program.
    let mut fake = w.svm.get_account(&w.pool).unwrap();
    fake.owner = Pubkey::new_unique();
    let fake_key = Pubkey::new_unique();
    w.svm.set_account(fake_key, fake).unwrap();
    let who = p.who.insecure_clone();
    let ix = open_ix(&w, &p, args(1_000_000_000, START, 4), fake_key, w.observation);
    assert_eq!(code(&w.send(&[ix], &[&who])), err(OrderError::NotOurPool));
    // The real pool with another account as its price record.
    let ix = open_ix(&w, &p, args(1_000_000_000, START, 4), w.pool, w.vault_0);
    assert_eq!(code(&w.send(&[ix], &[&who])), err(OrderError::NotOurPool));
}

#[test]
fn the_order_refuses_a_schedule_it_cannot_keep() {
    let mut w = World::new();
    let p = person(&mut w, true, 1_000_000_000);
    let cases: Vec<(Box<dyn Fn(&mut OpenArgs)>, OrderError)> = vec![
        (Box::new(|a| a.slices = 0), OrderError::BadSlices),
        (Box::new(|a| a.slices = 97), OrderError::BadSlices),
        (Box::new(|a| a.interval = 599), OrderError::IntervalTooShort),
        (Box::new(|a| a.start_at = i64::MAX - 100), OrderError::BadTimes),
        (Box::new(|a| a.min_out_total = 0), OrderError::ZeroAmount),
        (Box::new(|a| a.band_bps = 3_001), OrderError::BandTooWide),
        (Box::new(|a| a.tip_lamports = 1_000_001), OrderError::TipTooHigh),
        (Box::new(|a| a.weights = vec![1, 2]), OrderError::BadWeights),
        (Box::new(|a| a.weights = vec![0, 0, 0, 0]), OrderError::BadWeights),
    ];
    for (change, want) in cases {
        let mut a = args(1_000_000_000, START, 4);
        change(&mut a);
        assert_eq!(code(&open(&mut w, &p, a)), err(want));
    }
    open(&mut w, &p, args(1_000_000_000, START, 4)).unwrap();
}

#[test]
fn closing_returns_every_coin_and_every_lamport_to_the_owner_only() {
    let mut w = World::new();
    let p = person(&mut w, true, 1_000_000_000);
    let owner = p.who.pubkey();
    let before = w.lamports(&owner);
    open(&mut w, &p, args(1_000_000_000, START, 4)).unwrap();
    let held = w.lamports(&p.order) + w.lamports(&p.in_vault) + w.lamports(&p.out_vault);
    assert_eq!(before - w.lamports(&owner), held, "the owner paid every lamport the order holds");
    println!("an order holds {held} lamports of rent and tips while open");
    let r = runner(&mut w);
    w.at(START);
    slice(&mut w, &p, &r, 250_000_000).unwrap();
    let got = w.balance(&p.out_vault);

    // A stranger, or the owner's coins sent to a stranger, are refused.
    let stranger = runner(&mut w);
    let sk = stranger.pubkey();
    let s_in = w.account(&p.input_mint.clone(), &sk, 0);
    let s_out = w.account(&p.output_mint.clone(), &sk, 0);
    let ix = close_ix(&w, &p, &sk, &s_in, &s_out);
    assert!(w.send(&[ix], &[&stranger]).is_err());
    let who = p.who.insecure_clone();
    let ix = close_ix(&w, &p, &owner, &s_in, &s_out);
    assert!(w.send(&[ix], &[&who]).is_err());

    let ix = close_ix(&w, &p, &owner, &p.input, &p.output);
    w.send(&[ix], &[&who]).unwrap();
    assert_eq!(w.balance(&p.input), 750_000_000);
    assert_eq!(w.balance(&p.output), got);
    assert!(!w.exists(&p.order) && !w.exists(&p.in_vault) && !w.exists(&p.out_vault));
    assert_eq!(before - w.lamports(&owner), TIP, "all back but the one tip paid");
    // A slice that comes after the close finds no order.
    assert!(slice(&mut w, &p, &r, 250_000_000).is_err());
}
