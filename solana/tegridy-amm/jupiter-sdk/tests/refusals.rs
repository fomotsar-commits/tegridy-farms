//! What this SDK gives no quote for, so Jupiter never routes a trade the program would price
//! differently: a transfer-fee token, ExactOut, a pair the pool does not hold, and token
//! accounts that are not the pool's.

mod common;

use std::collections::HashMap;

use jupiter_amm_interface::{Amm, QuoteParams, SwapMode};
use memetics_jupiter_sdk::state::{PoolState, config_fields, has_transfer_fee};
use solana_account::Account;
use solana_pubkey::{Pubkey, pubkey};

const BAYLA: Pubkey = pubkey!("7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump");
const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

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

#[test]
fn a_pool_with_a_transfer_fee_mint_gets_no_quote() {
    let pool = common::BAYLA_SOL_POOL;
    let snapshot = common::snapshot(&pool);
    let mut accounts = common::accounts_to_update(&snapshot, &pool);
    assert!(
        quote(
            &common::amm_from(&snapshot, &pool, &accounts).unwrap(),
            WSOL,
            BAYLA,
            SwapMode::ExactIn
        )
        .is_ok()
    );

    accounts.get_mut(&BAYLA).unwrap().data[166..168].copy_from_slice(&1u16.to_le_bytes());
    let amm = common::amm_from(&snapshot, &pool, &accounts).expect("update still reads the pool");
    for (input, output) in [(WSOL, BAYLA), (BAYLA, WSOL)] {
        assert_eq!(
            quote(&amm, input, output, SwapMode::ExactIn),
            Err("a mint in this pool charges a transfer fee; no quote is given".into()),
        );
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

/// A refused `update` leaves no quote. After a good update the tier changes (its guard goes
/// on, or its venue share names someone else); the next update is refused, and the state read
/// before it must not go on quoting.
#[test]
fn a_refused_update_leaves_no_quote() {
    let pool_key = common::BAYLA_SOL_POOL;
    let snapshot = common::snapshot(&pool_key);
    let pool = PoolState::decode(&common::account(&snapshot, &pool_key).data).unwrap();
    for f in [config_fields::SWAP_GUARD, config_fields::PROTOCOL_OWNER] {
        let mut accounts = common::accounts_to_update(&snapshot, &pool_key);
        let mut amm = common::amm_from(&snapshot, &pool_key, &accounts).expect("first update");
        assert!(quote(&amm, WSOL, BAYLA, SwapMode::ExactIn).is_ok(), "{}", f.name);

        let config = accounts.get_mut(&pool.amm_config).unwrap();
        config.data[f.offset..f.offset + f.size].fill(0xff);
        let provider: HashMap<Pubkey, &Account> = accounts.iter().map(|(k, a)| (*k, a)).collect();
        assert!(amm.update(provider).is_err(), "{}: the second update", f.name);
        for (input, output) in [(WSOL, BAYLA), (BAYLA, WSOL)] {
            assert_eq!(
                quote(&amm, input, output, SwapMode::ExactIn),
                Err("no quote: the pool's last update was refused, or none has run".into()),
                "{}",
                f.name,
            );
        }
    }
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
            assert_eq!(data[108], 1, "{vault} as snapshotted is initialized and not frozen");
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
