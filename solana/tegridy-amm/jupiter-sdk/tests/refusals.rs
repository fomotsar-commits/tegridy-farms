//! What this SDK gives no quote for, so Jupiter never routes a trade the program would price
//! differently: a transfer-fee token, ExactOut, a pair the pool does not hold, token accounts
//! that are not the pool's, and a pool as it stood before its last update.
//!
//! Not tested: the owner checks on the fee tier and on the mints. The program checks both when
//! it opens a pool and nothing can change either after, so no state on chain reaches them.

mod common;

use std::collections::HashMap;

use jupiter_amm_interface::{Amm, QuoteParams, SwapMode};
use memetics_jupiter_sdk::math::swap_exact_in;
use memetics_jupiter_sdk::state::{
    AmmConfig, Field, PoolState, config_fields, has_transfer_fee, pool_fields, token_account_amount,
};
use solana_account::Account;
use solana_pubkey::{Pubkey, pubkey};

const BAYLA: Pubkey = pubkey!("7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump");
const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const NO_QUOTE: &str = "no quote: the pool's last update was refused, or none has run";

fn quote(amm: &impl Amm, input: Pubkey, output: Pubkey, mode: SwapMode) -> Result<u64, String> {
    amm.quote(&QuoteParams {
        amount: 1_000_000_000,
        input_mint: input,
        output_mint: output,
        swap_mode: mode,
        fee_mode: Default::default(),
    })
    .map(|q| q.out_amount)
    .map_err(|e| e.to_string())
}

/// BAYLA is a Token-2022 mint whose only extensions name it (a metadata pointer and its
/// metadata). Its first extension relabelled as a transfer fee must be read as one.
#[test]
fn a_transfer_fee_mint_is_read_as_one() {
    let mint = common::account(&common::snapshot(&common::BAYLA_SOL_POOL), &BAYLA).data;
    assert_eq!(has_transfer_fee(&mint), Some(false));
    assert_eq!(
        has_transfer_fee(&[0u8; 82]),
        Some(false),
        "a mint with no extensions"
    );

    let mut fee = mint.clone();
    fee[166..168].copy_from_slice(&1u16.to_le_bytes());
    assert_eq!(has_transfer_fee(&fee), Some(true));

    let mut second = mint.clone();
    let first_len = u16::from_le_bytes([mint[168], mint[169]]) as usize;
    let at = 166 + 4 + first_len;
    second[at..at + 2].copy_from_slice(&1u16.to_le_bytes());
    assert_eq!(
        has_transfer_fee(&second),
        Some(true),
        "a transfer fee after another extension"
    );

    assert_eq!(
        has_transfer_fee(&mint[..170]),
        None,
        "an extension cut short"
    );
    assert_eq!(
        has_transfer_fee(&mint[..100]),
        None,
        "neither a bare mint nor one with extensions"
    );
}

/// BAYLA is token 1 of BAYLA/SOL and token 0 of BAYLA/USDC, so its fee is read on both sides.
#[test]
fn a_pool_with_a_transfer_fee_mint_gets_no_quote() {
    for (pool, other, bayla_is_token_0) in [
        (common::BAYLA_SOL_POOL, WSOL, false),
        (common::BAYLA_USDC_POOL, USDC, true),
    ] {
        let snapshot = common::snapshot(&pool);
        let decoded = PoolState::decode(&common::account(&snapshot, &pool).data).unwrap();
        assert_eq!(decoded.token_0_mint == BAYLA, bayla_is_token_0, "{pool}");
        let mut accounts = common::accounts_to_update(&snapshot, &pool);
        let amm = common::amm_from(&snapshot, &pool, &accounts).unwrap();
        assert!(
            quote(&amm, other, BAYLA, SwapMode::ExactIn).is_ok(),
            "{pool}"
        );

        accounts.get_mut(&BAYLA).unwrap().data[166..168].copy_from_slice(&1u16.to_le_bytes());
        let amm =
            common::amm_from(&snapshot, &pool, &accounts).expect("update still reads the pool");
        for (input, output) in [(other, BAYLA), (BAYLA, other)] {
            assert_eq!(
                quote(&amm, input, output, SwapMode::ExactIn),
                Err("a mint in this pool charges a transfer fee; no quote is given".into()),
                "{pool}",
            );
        }
    }
}

#[test]
fn exact_out_and_other_pairs_get_no_quote() {
    let amm = common::amm(&common::BAYLA_SOL_POOL);
    assert_eq!(
        quote(&amm, WSOL, BAYLA, SwapMode::ExactOut),
        Err("only ExactIn swaps are quoted".into()),
    );
    for (input, output) in [
        (WSOL, WSOL),
        (WSOL, Pubkey::new_unique()),
        (Pubkey::new_unique(), BAYLA),
    ] {
        assert_eq!(
            quote(&amm, input, output, SwapMode::ExactIn),
            Err("mints are not this pool's pair".into()),
        );
    }
}

/// One way to change the accounts an update reads: (accounts, the pool, its fee tier).
type Change = fn(&mut HashMap<Pubkey, Account>, &Pubkey, &Pubkey);

fn fill(accounts: &mut HashMap<Pubkey, Account>, key: &Pubkey, f: Field) {
    accounts.get_mut(key).unwrap().data[f.offset..f.offset + f.size].fill(0xff);
}

/// A refused `update` leaves no quote, at whichever step it refuses: the pool account gone,
/// the fee tier unreadable, its guard on, or its venue share naming someone else. The state
/// read by the good update before must not go on quoting.
#[test]
fn a_refused_update_leaves_no_quote() {
    let pool_key = common::BAYLA_SOL_POOL;
    let snapshot = common::snapshot(&pool_key);
    let tier = PoolState::decode(&common::account(&snapshot, &pool_key).data)
        .unwrap()
        .amm_config;
    let cases: [(&str, Change, String); 4] = [
        (
            "the pool account missing",
            |a, pool, _| {
                a.remove(pool);
            },
            format!("Could not find address: {pool_key}"),
        ),
        (
            "the fee tier unreadable",
            |a, _, tier| a.get_mut(tier).unwrap().data[..8].fill(0),
            "account is not a Memetics fee tier".into(),
        ),
        (
            "the swap guard on",
            |a, _, tier| fill(a, tier, config_fields::SWAP_GUARD),
            "fee tier's swap guard is on: it refuses a swap another program calls, as Jupiter's are".into(),
        ),
        (
            "the venue's share to someone else",
            |a, _, tier| fill(a, tier, config_fields::PROTOCOL_OWNER),
            "fee tier names a fee collector that is not the venue's vault (or, for the island's share, the island's Workshop)".into(),
        ),
    ];
    for (name, change, refusal) in cases {
        let mut accounts = common::accounts_to_update(&snapshot, &pool_key);
        let mut amm = common::amm_from(&snapshot, &pool_key, &accounts).expect("first update");
        assert!(
            quote(&amm, WSOL, BAYLA, SwapMode::ExactIn).is_ok(),
            "{name}"
        );

        change(&mut accounts, &pool_key, &tier);
        let provider: HashMap<Pubkey, &Account> = accounts.iter().map(|(k, a)| (*k, a)).collect();
        let refused = amm.update(provider).err().map(|e| e.to_string());
        assert_eq!(refused, Some(refusal), "{name}: the second update");
        for (input, output) in [(WSOL, BAYLA), (BAYLA, WSOL)] {
            assert_eq!(
                quote(&amm, input, output, SwapMode::ExactIn),
                Err(NO_QUOTE.into()),
                "{name}",
            );
        }
    }
}

/// Each `update` reads the pool again: the quote follows fees booked in it since, and a swap
/// switch turned off since stops it, `is_active` too. A quote from the pool as first read
/// would price the swap as the program no longer does.
#[test]
fn an_update_reads_the_pool_again() {
    let pool_key = common::BAYLA_SOL_POOL;
    let snapshot = common::snapshot(&pool_key);
    let now = snapshot.clock().expect("clock in snapshot").unix_timestamp;
    let first = common::amm(&pool_key);
    assert!(first.is_active());
    let before = quote(&first, WSOL, BAYLA, SwapMode::ExactIn).unwrap();

    // One SOL more booked to the venue: the curve trades against one SOL less.
    let mut accounts = common::accounts_to_update(&snapshot, &pool_key);
    let f = pool_fields::PROTOCOL_FEES_TOKEN_0;
    let data = &mut accounts.get_mut(&pool_key).unwrap().data;
    let booked = u64::from_le_bytes(data[f.offset..f.offset + f.size].try_into().unwrap());
    data[f.offset..f.offset + f.size].copy_from_slice(&(booked + 1_000_000_000).to_le_bytes());
    let pool = PoolState::decode(data).unwrap();
    let config = AmmConfig::decode(&accounts[&pool.amm_config].data).unwrap();
    let vault = |k: &Pubkey| token_account_amount(&accounts[k].data).unwrap();
    let (vault_0, vault_1) = (vault(&pool.token_0_vault), vault(&pool.token_1_vault));
    let paid = swap_exact_in(&pool, &config, vault_0, vault_1, true, 1_000_000_000, now)
        .unwrap()
        .output_amount;
    assert_ne!(
        paid, before,
        "the booked fee must change what the program pays"
    );
    let amm = common::amm_from(&snapshot, &pool_key, &accounts).unwrap();
    assert_eq!(quote(&amm, WSOL, BAYLA, SwapMode::ExactIn), Ok(paid));

    // The swap switch off (pool.rs `PoolStatusBitIndex::Swap`, bit 2 set).
    let mut accounts = common::accounts_to_update(&snapshot, &pool_key);
    accounts.get_mut(&pool_key).unwrap().data[pool_fields::STATUS.offset] |= 1 << 2;
    let amm = common::amm_from(&snapshot, &pool_key, &accounts).expect("update reads the pool");
    assert!(!amm.is_active());
    assert_eq!(
        quote(&amm, WSOL, BAYLA, SwapMode::ExactIn),
        Err("the program refuses this swap: NotApproved".into()),
    );
}

/// The swap moves both legs with the token program, which refuses a frozen account. A pool
/// token account that is frozen (state 2 at byte 108) or not initialized (0) is refused.
#[test]
fn a_frozen_pool_token_account_is_refused() {
    let pool_key = common::BAYLA_SOL_POOL;
    let snapshot = common::snapshot(&pool_key);
    let pool = PoolState::decode(&common::account(&snapshot, &pool_key).data).unwrap();
    for vault in [pool.token_0_vault, pool.token_1_vault] {
        for state in [2u8, 0] {
            let mut accounts = common::accounts_to_update(&snapshot, &pool_key);
            let data = &mut accounts.get_mut(&vault).unwrap().data;
            assert_eq!(
                data[108], 1,
                "{vault} as snapshotted is initialized and not frozen"
            );
            data[108] = state;
            let refused = common::amm_from(&snapshot, &pool_key, &accounts)
                .err()
                .map(|e| e.to_string());
            assert_eq!(
                refused,
                Some(format!(
                    "pool token account {vault} is frozen or not initialized: the program cannot move its tokens"
                )),
                "state {state}",
            );
        }
    }
}

/// A token account the pool names must hold the pool's mint under the pool's token program,
/// or its balance is not the pool's liquidity.
#[test]
fn a_token_account_that_is_not_the_pools_is_refused() {
    let pool_key = common::BAYLA_SOL_POOL;
    let snapshot = common::snapshot(&pool_key);
    let pool = PoolState::decode(&common::account(&snapshot, &pool_key).data).unwrap();

    let mut wrong_mint = common::accounts_to_update(&snapshot, &pool_key);
    wrong_mint.get_mut(&pool.token_0_vault).unwrap().data[..32].copy_from_slice(BAYLA.as_ref());
    let mut wrong_program = common::accounts_to_update(&snapshot, &pool_key);
    wrong_program.get_mut(&pool.token_0_vault).unwrap().owner = Pubkey::new_unique();

    for accounts in [wrong_mint, wrong_program] {
        let refused = common::amm_from(&snapshot, &pool_key, &accounts)
            .err()
            .map(|e| e.to_string());
        assert_eq!(
            refused,
            Some(format!(
                "pool token account {} is not the pool's",
                pool.token_0_vault
            )),
        );
    }
}
