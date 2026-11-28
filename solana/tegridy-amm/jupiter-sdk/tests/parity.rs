//! Jupiter's quote parity check (jupiter-amm-test-kit): for each swap below, `Amm::quote`
//! must equal what the program pays out when it runs that swap in LiteSVM.
//!
//!   cargo test --test parity
//!
//! The program is `tests/fixtures/memetics.so`, a build read from mainnet, not a local build.
//! README.md (under the fixtures) says which build, and why parity with it holds for the one
//! mainnet runs. The pools are `tests/fixtures/accounts/<pool>/` with the tier's swap guard
//! cleared (`common::snapshot`). To take both again: `node scripts/take-fixtures.mjs`.

mod common;

use jupiter_amm_interface::Swap;
use jupiter_amm_test_kit::{PoolTest, assert_pool_parity};
use memetics_jupiter_sdk::{MemeticsAmm, swap_base_input_data};
use solana_pubkey::{Pubkey, pubkey};

const BAYLA_SOL_POOL: Pubkey = pubkey!("ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4");
const BAYLA_USDC_POOL: Pubkey = pubkey!("J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm");
const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const BAYLA: Pubkey = pubkey!("7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump");

#[test]
fn bayla_sol() {
    let mut test = PoolTest::new(BAYLA_SOL_POOL)
        .add_swap(WSOL, BAYLA, 100_000_000) // 0.1 SOL
        .add_swap(WSOL, BAYLA, 10_000_000_000) // 10 SOL
        .add_swap(WSOL, BAYLA, 123_456_789) // an amount whose fee does not divide evenly
        .add_swap(BAYLA, WSOL, 10_000_000_000) // 10,000 BAYLA (6 decimals)
        .add_swap(BAYLA, WSOL, 1_000_000_000_000) // 1,000,000 BAYLA
        .add_swap(BAYLA, WSOL, 987_654_321_123);
    test.fixtures_dir = common::snapshot_dir(&BAYLA_SOL_POOL);

    assert_pool_parity::<MemeticsAmm>(&test, encode_swap);
}

#[test]
fn bayla_usdc() {
    let mut test = PoolTest::new(BAYLA_USDC_POOL)
        .add_swap(USDC, BAYLA, 5_000_000) // 5 USDC
        .add_swap(USDC, BAYLA, 200_000_000) // 200 USDC
        .add_swap(USDC, BAYLA, 7_654_321) // an amount whose fee does not divide evenly
        .add_swap(BAYLA, USDC, 20_000_000_000) // 20,000 BAYLA
        .add_swap(BAYLA, USDC, 500_000_000_000) // 500,000 BAYLA
        .add_swap(BAYLA, USDC, 33_333_333_333);
    test.fixtures_dir = common::snapshot_dir(&BAYLA_USDC_POOL);

    assert_pool_parity::<MemeticsAmm>(&test, encode_swap);
}

/// The fixture build: proposal #32's (the swap guard), 714,776 bytes, read at slot 469,908,387.
/// Mainnet has run another since proposal #35 executed (2026-11-17), and the next upgrade
/// installs a third. Neither changes what a router is quoted or paid: with either in place,
/// only this pin fails (README.md, under the fixtures). The fixtures are taken again in that
/// upgrade's same-day release by `scripts/take-fixtures.mjs`, which writes this hash only when
/// it is the one the registry expects.
#[test]
fn the_program_is_the_fixture_build() {
    use sha2::{Digest, Sha256};
    let elf = std::fs::read("tests/fixtures/memetics.so").expect("read tests/fixtures/memetics.so");
    let hex: String = Sha256::digest(&elf)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        hex,
        "01fe923bd9ba3435212d015c2b0d7549592a601ab5707c6222bd0252166e9938"
    );
}

/// `swap_base_input(amount_in, minimum_amount_out)`. The minimum is left at 0: holding the
/// exact amount out is the kit's job, and in a route it is Jupiter's.
fn encode_swap(swap: &Swap, in_amount: u64) -> Vec<u8> {
    match swap {
        Swap::Placeholder { data: None } => swap_base_input_data(in_amount, 0),
        other => panic!("unexpected swap variant: {other:?}"),
    }
}
