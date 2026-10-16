//! Jupiter's quote parity check (jupiter-amm-test-kit): for each swap below, `Amm::quote`
//! must equal what the DEPLOYED program pays out when it runs that swap in LiteSVM.
//!
//!   cargo test --test parity
//!
//! The program is `tests/fixtures/memetics.so`, the ELF read from mainnet (what
//! `solana program dump` writes), not a local build: the parity that matters is with the
//! binary Jupiter would route to. The pool snapshots are `tests/fixtures/accounts/<pool>/`.
//! To take them again, run with `REFRESH=1 RPC=<mainnet url>`: the kit only reads accounts.

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
    let test = PoolTest::new(BAYLA_SOL_POOL)
        .add_swap(WSOL, BAYLA, 100_000_000) // 0.1 SOL
        .add_swap(WSOL, BAYLA, 10_000_000_000) // 10 SOL
        .add_swap(WSOL, BAYLA, 123_456_789) // an amount whose fee does not divide evenly
        .add_swap(BAYLA, WSOL, 10_000_000_000) // 10,000 BAYLA (6 decimals)
        .add_swap(BAYLA, WSOL, 1_000_000_000_000) // 1,000,000 BAYLA
        .add_swap(BAYLA, WSOL, 987_654_321_123);

    assert_pool_parity::<MemeticsAmm>(&test, encode_swap);
}

#[test]
fn bayla_usdc() {
    let test = PoolTest::new(BAYLA_USDC_POOL)
        .add_swap(USDC, BAYLA, 5_000_000) // 5 USDC
        .add_swap(USDC, BAYLA, 200_000_000) // 200 USDC
        .add_swap(USDC, BAYLA, 7_654_321) // an amount whose fee does not divide evenly
        .add_swap(BAYLA, USDC, 20_000_000_000) // 20,000 BAYLA
        .add_swap(BAYLA, USDC, 500_000_000_000) // 500,000 BAYLA
        .add_swap(BAYLA, USDC, 33_333_333_333);

    assert_pool_parity::<MemeticsAmm>(&test, encode_swap);
}

/// The ELF under test is the one on mainnet: 691,640 bytes, the release build
/// `cp_swap.mainnet.so` (MAINNET_RUNBOOK.md). A program upgrade changes it: delete the file,
/// rerun with `RPC` set to dump the new one, and pin its hash here.
#[test]
fn the_program_is_the_deployed_binary() {
    use sha2::{Digest, Sha256};
    let elf = std::fs::read("tests/fixtures/memetics.so").expect("read tests/fixtures/memetics.so");
    let hex: String = Sha256::digest(&elf)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        hex,
        "88b98aa91559824c682f6e6c31906abf222d189ce7a45f16af117368b33db882"
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
