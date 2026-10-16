//! Jupiter's quote parity check on the fee paths the live pools do not take. Both BAYLA pools
//! charge no creator fee and no fund fee, so `tests/parity.rs` never runs the program's
//! creator-fee split, its creator fee on the output, or its fund fee. Here the BAYLA/SOL
//! snapshot is copied with those switched on, and the DEPLOYED program
//! (`tests/fixtures/memetics.so`) runs each swap in LiteSVM against the copy: the quote must
//! still equal what it pays out. The kit asks for this ("different fee modes").
//!
//!   cargo test --test fee_paths
//!
//! The copies are written under cargo's `CARGO_TARGET_TMPDIR`, never into `tests/fixtures`.

mod common;

use std::collections::HashMap;
use std::path::PathBuf;

use jupiter_amm_interface::Swap;
use jupiter_amm_test_kit::{PoolSnapshot, PoolTest, assert_pool_parity};
use memetics_jupiter_sdk::math::swap_exact_in;
use memetics_jupiter_sdk::state::{
    AmmConfig, Field, PoolState, config_fields, pool_fields, token_account_amount,
};
use memetics_jupiter_sdk::{MemeticsAmm, swap_base_input_data};
use solana_account::Account;
use solana_pubkey::{Pubkey, pubkey};

const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const BAYLA: Pubkey = pubkey!("7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump");

/// Each copy's swaps: (input, output, amount). Token 0 is WSOL, token 1 is BAYLA.
const SWAPS: [(Pubkey, Pubkey, u64); 2] =
    [(WSOL, BAYLA, 123_456_789), (BAYLA, WSOL, 987_654_321_123)];

/// 0.5% creator fee and a fund fee of 4% of the trade fee, on top of the tier's own rates.
const CREATOR_FEE_RATE: u64 = 5_000;
const FUND_FEE_RATE: u64 = 40_000;
/// Fees already booked in the pool to the venue's fund (SOL) and to the creator (BAYLA):
/// the curve must trade against the vaults less these.
const BOOKED_FUND_FEES_TOKEN_0: u64 = 1_000_000;
const BOOKED_CREATOR_FEES_TOKEN_1: u64 = 1_000_000_000;

fn set(data: &mut [u8], f: Field, bytes: &[u8]) {
    assert_eq!(bytes.len(), f.size, "{}", f.name);
    data[f.offset..f.offset + f.size].copy_from_slice(bytes);
}

/// The BAYLA/SOL snapshot with the pool's `creator_fee_on` and `enable_creator_fee` set,
/// written to its own directory. Every copy also turns on the tier's creator and fund rates
/// and books fund and creator fees in the pool.
fn copy_with(name: &str, creator_fee_on: u8, enable_creator_fee: bool) -> PathBuf {
    let pool_key = common::BAYLA_SOL_POOL;
    let snapshot = common::snapshot(&pool_key);
    let mut accounts: HashMap<Pubkey, Account> =
        std::fs::read_dir(format!("tests/fixtures/accounts/{pool_key}"))
            .expect("read the snapshot")
            .map(|e| {
                let path = e.unwrap().path();
                let key: Pubkey = path.file_stem().unwrap().to_str().unwrap().parse().unwrap();
                (key, common::account(&snapshot, &key))
            })
            .collect();
    let amm_config = PoolState::decode(&accounts[&pool_key].data)
        .unwrap()
        .amm_config;

    let pool = &mut accounts.get_mut(&pool_key).unwrap().data;
    set(pool, pool_fields::CREATOR_FEE_ON, &[creator_fee_on]);
    set(
        pool,
        pool_fields::ENABLE_CREATOR_FEE,
        &[u8::from(enable_creator_fee)],
    );
    set(
        pool,
        pool_fields::FUND_FEES_TOKEN_0,
        &BOOKED_FUND_FEES_TOKEN_0.to_le_bytes(),
    );
    set(
        pool,
        pool_fields::CREATOR_FEES_TOKEN_1,
        &BOOKED_CREATOR_FEES_TOKEN_1.to_le_bytes(),
    );
    let config = &mut accounts.get_mut(&amm_config).unwrap().data;
    set(
        config,
        config_fields::CREATOR_FEE_RATE,
        &CREATOR_FEE_RATE.to_le_bytes(),
    );
    set(
        config,
        config_fields::FUND_FEE_RATE,
        &FUND_FEE_RATE.to_le_bytes(),
    );

    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("fee-paths/{name}"));
    PoolSnapshot::from_accounts(accounts)
        .save_dir(&dir)
        .expect("write the copy");
    dir
}

/// The amount out of each of `SWAPS` on the copy in `dir`, after checking the copy really
/// takes the path under test: every swap books a fund fee, and a creator fee exactly when
/// the pool charges one. A copy that took the live path would pass the parity check and
/// prove nothing.
fn quotes_on(dir: &PathBuf, enable_creator_fee: bool) -> Vec<u64> {
    let snapshot = PoolSnapshot::load_dir(dir).expect("read the copy back");
    let pool =
        PoolState::decode(&common::account(&snapshot, &common::BAYLA_SOL_POOL).data).unwrap();
    let config = AmmConfig::decode(&common::account(&snapshot, &pool.amm_config).data).unwrap();
    let vault = |k: &Pubkey| token_account_amount(&common::account(&snapshot, k).data).unwrap();
    let now = snapshot.clock().expect("clock in snapshot").unix_timestamp;
    SWAPS
        .iter()
        .map(|&(input, _, amount)| {
            let r = swap_exact_in(
                &pool,
                &config,
                vault(&pool.token_0_vault),
                vault(&pool.token_1_vault),
                input == pool.token_0_mint,
                amount,
                now,
            )
            .expect("the copy quotes");
            assert!(r.fund_fee > 0, "no fund fee booked");
            assert_eq!(r.creator_fee > 0, enable_creator_fee, "creator fee");
            r.output_amount
        })
        .collect()
}

/// Each of `SWAPS` on the copy: the quote equals what the deployed program pays. Returns the
/// amounts out.
fn assert_parity(name: &str, creator_fee_on: u8, enable_creator_fee: bool) -> Vec<u64> {
    let dir = copy_with(name, creator_fee_on, enable_creator_fee);
    let paid = quotes_on(&dir, enable_creator_fee);
    let mut test = PoolTest::new(common::BAYLA_SOL_POOL);
    for (input, output, amount) in SWAPS {
        test = test.add_swap(input, output, amount);
    }
    test.fixtures_dir = dir;
    assert_pool_parity::<MemeticsAmm>(&test, encode_swap);
    paid
}

/// pool.rs `CreatorFeeOn::BothToken`: the creator's cut is split out of the input fee.
#[test]
fn creator_fee_on_both_tokens() {
    assert_parity("both", 0, true);
}

/// `OnlyToken0`: on the input when SOL goes in, off the output when SOL comes out.
///
/// The two `quote_vectors.json` cases named "fee_paths token-0 copy" are these swaps, so the
/// site's own quote (jupiterSdkParity.test.ts) meets the deployed program on the fund fee,
/// the creator fee and fees booked to both.
#[test]
fn creator_fee_on_token_0() {
    let paid = assert_parity("token-0", 1, true);
    let doc: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("tests/fixtures/quote_vectors.json").expect("read vectors"),
    )
    .expect("vectors are JSON");
    let named: Vec<_> = doc["synthetic"]
        .as_array()
        .expect("synthetic cases")
        .iter()
        .filter(|c| {
            c["name"]
                .as_str()
                .unwrap()
                .starts_with("fee_paths token-0 copy")
        })
        .collect();
    assert_eq!(named.len(), SWAPS.len(), "a vector per swap");
    for (c, ((input, _, amount), out)) in named.iter().zip(SWAPS.iter().zip(paid)) {
        assert_eq!(
            c["inputIsToken0"].as_bool(),
            Some(*input == WSOL),
            "{}",
            c["name"]
        );
        assert_eq!(
            c["amountIn"].as_str(),
            Some(amount.to_string().as_str()),
            "{}",
            c["name"]
        );
        assert_eq!(
            c["out"].as_str(),
            Some(out.to_string().as_str()),
            "{}",
            c["name"]
        );
    }
}

/// `OnlyToken1`: the other way round.
#[test]
fn creator_fee_on_token_1() {
    assert_parity("token-1", 2, true);
}

/// A tier with a creator rate on a pool that charges none: pool.rs `adjust_creator_fee_rate`.
#[test]
fn creator_fee_rate_on_a_pool_without_one() {
    assert_parity("off", 1, false);
}

/// As in `tests/parity.rs`.
fn encode_swap(swap: &Swap, in_amount: u64) -> Vec<u8> {
    match swap {
        Swap::Placeholder { data: None } => swap_base_input_data(in_amount, 0),
        other => panic!("unexpected swap variant: {other:?}"),
    }
}
