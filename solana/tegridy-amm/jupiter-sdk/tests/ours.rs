//! Every key this SDK names, and every account a swap through it touches, is the venue's
//! own, the island's Workshop or a public token program. Owner rulings: venue money and
//! liquidity never go to another venue; every fee owner, receiver and authority is ours,
//! except the island's share, which the split of 2026-10-18 gives to the island's Workshop.

mod common;

use std::collections::HashMap;

use jupiter_amm_interface::{Amm, QuoteParams, SwapMode, SwapParams};
use memetics_jupiter_sdk::state::{AmmConfig, Field, PoolState, config_fields};
use memetics_jupiter_sdk::{
    AUTHORITY, ISLAND_WORKSHOP, PROGRAM_ID, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, VENUE_VAULT,
};
use solana_pubkey::Pubkey;

/// The keys the SDK may name, each with what it is. Written out as text, so changing a
/// constant in src/ cannot also change what it is checked against.
const ALLOWED: &[(&str, &str)] = &[
    (
        "EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT",
        "the venue's pool program (owner ruling 2026-09-25)",
    ),
    (
        "Bkr8XPZySJmcUAxKSDNCcH5KE2WDs2Y3GeZLRbeATSfB",
        "the pool program's own signer over every pool's token accounts",
    ),
    (
        "GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd",
        "the venue's Squads vault: admin and every fee tier's collector",
    ),
    (
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "the SPL token program",
    ),
    (
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        "the Token-2022 program",
    ),
    (
        "G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu",
        "the island's Workshop: collects the island's share of the fee under the split of 2026-10-18",
    ),
];

const REFUSED_COLLECTOR: &str =
    "fee tier names a fee collector that is not the venue's vault (or, for the island's share, the island's Workshop)";

fn allowed(key: &Pubkey) -> bool {
    ALLOWED
        .iter()
        .any(|(k, _)| k.parse::<Pubkey>().unwrap() == *key)
}

#[test]
fn the_named_keys_are_ours() {
    assert_eq!(PROGRAM_ID.to_string(), ALLOWED[0].0);
    assert_eq!(AUTHORITY.to_string(), ALLOWED[1].0);
    assert_eq!(VENUE_VAULT.to_string(), ALLOWED[2].0);
    assert_eq!(TOKEN_PROGRAM.to_string(), ALLOWED[3].0);
    assert_eq!(TOKEN_2022_PROGRAM.to_string(), ALLOWED[4].0);
    assert_eq!(ISLAND_WORKSHOP.to_string(), ALLOWED[5].0);
    // lib.rs `AUTH_SEED` under our program, not a key copied from anywhere.
    let (derived, _) = Pubkey::find_program_address(&[b"vault_and_lp_mint_auth_seed"], &PROGRAM_ID);
    assert_eq!(AUTHORITY, derived);
}

/// Every key written anywhere in the SDK's source and manifest is on `ALLOWED`. A base58
/// word that parses as a 32-byte key is a key, wherever it sits (code, comment or string).
#[test]
fn the_sdk_names_no_other_key() {
    let mut files: Vec<String> = std::fs::read_dir("src")
        .expect("read src")
        .map(|e| e.unwrap().path().to_string_lossy().into_owned())
        .collect();
    files.push("Cargo.toml".into());
    assert!(
        files.iter().any(|f| f.ends_with("lib.rs")),
        "src/lib.rs not found"
    );
    let mut seen = 0;
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap();
        for word in text.split(|c: char| !c.is_ascii_alphanumeric()) {
            if !(32..=44).contains(&word.len()) {
                continue;
            }
            if let Ok(key) = word.parse::<Pubkey>() {
                seen += 1;
                assert!(
                    allowed(&key),
                    "{file} names {key}, which is not on this test's list"
                );
            }
        }
    }
    assert!(
        seen >= ALLOWED.len(),
        "the scan found {seen} keys: it is not reading the source"
    );
}

/// The live pools, as snapshotted: owned by our program, priced by a fee tier our program
/// owns whose venue share goes to the venue's vault and island share to the vault or the
/// island's Workshop, holding their tokens in accounts only our program's signer controls.
#[test]
fn the_live_pools_pay_only_the_venue_and_the_island() {
    for pool_key in common::POOLS {
        let snapshot = common::snapshot(&pool_key);
        let pool_account = common::account(&snapshot, &pool_key);
        assert_eq!(pool_account.owner, PROGRAM_ID, "{pool_key}");
        let pool = PoolState::decode(&pool_account.data).expect("pool decodes");

        let config_account = common::account(&snapshot, &pool.amm_config);
        assert_eq!(config_account.owner, PROGRAM_ID, "{pool_key} fee tier");
        let config = AmmConfig::decode(&config_account.data).expect("fee tier decodes");
        assert_eq!(
            config.protocol_owner, VENUE_VAULT,
            "{pool_key} protocol fee owner"
        );
        assert!(
            [VENUE_VAULT, ISLAND_WORKSHOP].contains(&config.fund_owner),
            "{pool_key} fund fee owner"
        );

        for vault in [pool.token_0_vault, pool.token_1_vault] {
            let data = common::account(&snapshot, &vault).data;
            // spl-token account: mint(32) owner(32): the owner is who may move its tokens.
            assert_eq!(
                Pubkey::try_from(&data[32..64]).unwrap(),
                AUTHORITY,
                "{pool_key} vault {vault}"
            );
        }
    }
}

/// A swap's accounts: the trader's own three, and otherwise only accounts our program owns
/// or controls, the two mints, and the token programs. No account outside the pool is paid.
#[test]
fn a_swap_touches_only_the_pool_and_the_trader() {
    for pool_key in common::POOLS {
        let amm = common::amm(&pool_key);
        let pool =
            PoolState::decode(&common::account(&common::snapshot(&pool_key), &pool_key).data)
                .unwrap();
        let mints = amm.get_reserve_mints();
        let (trader, source, destination) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        for (input, output) in [(mints[0], mints[1]), (mints[1], mints[0])] {
            let metas = amm
                .get_swap_and_account_metas(&SwapParams {
                    swap_mode: SwapMode::ExactIn,
                    in_amount: 1_000,
                    out_amount: 1,
                    source_mint: input,
                    destination_mint: output,
                    source_token_account: source,
                    destination_token_account: destination,
                    token_transfer_authority: trader,
                    user: trader,
                    payer: trader,
                    quote_mint_to_referrer: None,
                    jupiter_program_id: &Pubkey::new_unique(),
                    missing_dynamic_accounts_as_default: false,
                })
                .expect("account metas")
                .account_metas;
            assert_eq!(metas.len(), amm.get_accounts_len());
            let venue = [
                AUTHORITY,
                pool.amm_config,
                pool_key,
                pool.token_0_vault,
                pool.token_1_vault,
                pool.observation_key,
            ];
            for meta in &metas {
                let k = meta.pubkey;
                assert!(
                    [trader, source, destination].contains(&k)
                        || venue.contains(&k)
                        || mints.contains(&k)
                        || allowed(&k),
                    "{pool_key}: a swap names {k}, which is neither the trader's, the pool's nor ours",
                );
                if meta.is_signer {
                    assert_eq!(k, trader, "{pool_key}: only the trader signs");
                }
            }
        }
        assert_eq!(amm.program_id(), PROGRAM_ID);
    }
}

/// `update` refuses a fee tier naming any other fee collector, so no quote is ever given for
/// a pool whose venue cut would be paid somewhere else.
#[test]
fn a_fee_tier_paying_anyone_else_is_refused() {
    let pool_key = common::BAYLA_SOL_POOL;
    let snapshot = common::snapshot(&pool_key);
    let pool = PoolState::decode(&common::account(&snapshot, &pool_key).data).unwrap();
    let outsider = Pubkey::new_unique();
    for f in [config_fields::PROTOCOL_OWNER, config_fields::FUND_OWNER] {
        let mut accounts: HashMap<_, _> = common::accounts_to_update(&snapshot, &pool_key);
        assert!(
            common::amm_from(&snapshot, &pool_key, &accounts).is_ok(),
            "the snapshot as taken updates"
        );
        let config = accounts.get_mut(&pool.amm_config).unwrap();
        config.data[f.offset..f.offset + f.size].copy_from_slice(outsider.as_ref());
        let refused = common::amm_from(&snapshot, &pool_key, &accounts)
            .err()
            .map(|e| e.to_string());
        assert_eq!(refused.as_deref(), Some(REFUSED_COLLECTOR), "{}", f.name);
    }
}

/// Under the split the island's share (`fund_owner`) may be collected by the vault or by the
/// island's Workshop, and the pool is quoted either way. The venue's share stays the vault's.
#[test]
fn the_islands_share_may_go_to_its_workshop_but_the_venues_may_not() {
    let pool_key = common::BAYLA_SOL_POOL;
    let snapshot = common::snapshot(&pool_key);
    let pool = PoolState::decode(&common::account(&snapshot, &pool_key).data).unwrap();
    let workshop: Pubkey = ALLOWED[5].0.parse().unwrap();
    let with = |f: Field, key: &Pubkey| {
        let mut accounts: HashMap<_, _> = common::accounts_to_update(&snapshot, &pool_key);
        let config = accounts.get_mut(&pool.amm_config).unwrap();
        config.data[f.offset..f.offset + f.size].copy_from_slice(key.as_ref());
        common::amm_from(&snapshot, &pool_key, &accounts).map_err(|e| e.to_string())
    };
    let mints = common::amm(&pool_key).get_reserve_mints();
    for key in [VENUE_VAULT, workshop] {
        let amm = with(config_fields::FUND_OWNER, &key)
            .unwrap_or_else(|e| panic!("the island's share to {key}: {e}"));
        let quote = amm.quote(&QuoteParams {
            amount: 1_000_000_000,
            input_mint: mints[0],
            output_mint: mints[1],
            swap_mode: SwapMode::ExactIn,
            fee_mode: Default::default(),
        });
        assert!(quote.is_ok(), "the island's share to {key}: {quote:?}");
    }
    assert_eq!(
        with(config_fields::PROTOCOL_OWNER, &workshop).err().as_deref(),
        Some(REFUSED_COLLECTOR),
        "the venue's share to the Workshop",
    );
}

/// `update` refuses a fee tier whose swap guard is on: Jupiter calls every swap from its own
/// program, which such a tier refuses, so a quote would fail every route. Off, as the snapshot
/// was taken, it updates.
#[test]
fn a_fee_tier_with_its_swap_guard_on_is_refused() {
    let pool_key = common::BAYLA_SOL_POOL;
    let snapshot = common::snapshot(&pool_key);
    let pool = PoolState::decode(&common::account(&snapshot, &pool_key).data).unwrap();
    let f = config_fields::SWAP_GUARD;
    let mut accounts: HashMap<_, _> = common::accounts_to_update(&snapshot, &pool_key);
    let config = accounts.get(&pool.amm_config).unwrap();
    assert_eq!(&config.data[f.offset..f.offset + f.size], &[0u8; 8], "the snapshot's guard is off");
    assert!(common::amm_from(&snapshot, &pool_key, &accounts).is_ok(), "the snapshot as taken updates");
    let config = accounts.get_mut(&pool.amm_config).unwrap();
    config.data[f.offset..f.offset + f.size].copy_from_slice(&1u64.to_le_bytes());
    let refused = common::amm_from(&snapshot, &pool_key, &accounts)
        .err()
        .map(|e| e.to_string());
    assert_eq!(
        refused.as_deref(),
        Some("fee tier's swap guard is on: it refuses a swap another program calls, as Jupiter's are"),
    );
}

/// A pool account another program owns is not built, whatever its bytes say.
#[test]
fn a_pool_owned_by_another_program_is_refused() {
    let pool_key = common::BAYLA_SOL_POOL;
    let snapshot = common::snapshot(&pool_key);
    let mut accounts = common::accounts_to_update(&snapshot, &pool_key);
    accounts.get_mut(&pool_key).unwrap().owner = Pubkey::new_unique();
    let refused = common::amm_from(&snapshot, &pool_key, &accounts)
        .err()
        .map(|e| e.to_string());
    assert_eq!(
        refused.as_deref(),
        Some("pool is not owned by the Memetics pool program")
    );
}
