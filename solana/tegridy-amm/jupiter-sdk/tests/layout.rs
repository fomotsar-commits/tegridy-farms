//! The byte layout this crate reads is the program's own: every offset in `src/state.rs` is
//! recomputed here from the program's source (`../programs/cp-swap`), and the discriminators
//! and the signer's seed from their definitions; a swap's account flags are its IDL's
//! (`../idl`). This test runs inside the repository, where those files are; outside it, it
//! fails rather than pass without reading them.

mod common;

use jupiter_amm_interface::{Amm, SwapMode, SwapParams};
use memetics_jupiter_sdk::SWAP_BASE_INPUT_DISCRIMINATOR;
use memetics_jupiter_sdk::state::{
    AMM_CONFIG_DISCRIMINATOR, AMM_CONFIG_LEN, Field, POOL_STATE_DISCRIMINATOR, POOL_STATE_LEN,
    config_fields, pool_fields,
};
use sha2::{Digest, Sha256};
use solana_pubkey::Pubkey;

const PROGRAM_SRC: &str = "../programs/cp-swap/src";
const IDL: &str = "../idl/raydium_cp_swap.json";

fn program_file(rel: &str) -> String {
    let path = format!("{PROGRAM_SRC}/{rel}");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| {
            panic!("read the program's {path} ({e}): run this inside the repository")
        })
        .replace("\r\n", "\n")
}

/// Size of a field type as the program declares it. Both structs are padding-free (the pool
/// is `#[repr(C, packed)]`, the fee tier Borsh), so a field's offset is the sum before it.
fn size_of(ty: &str) -> usize {
    match ty {
        "Pubkey" => 32,
        "u8" | "bool" => 1,
        "u16" => 2,
        "u64" => 8,
        _ => {
            let inner = ty
                .strip_prefix('[')
                .and_then(|t| t.strip_suffix(']'))
                .unwrap_or_else(|| panic!("a field type this test does not size: {ty}"));
            let (elem, n) = inner.split_once(';').unwrap();
            size_of(elem.trim()) * n.trim().parse::<usize>().unwrap()
        }
    }
}

/// `(name, offset, size)` of every field of `pub struct <name> { ... }` in `source`, after the
/// 8-byte discriminator, and the struct's attribute lines.
fn layout(source: &str, name: &str) -> (Vec<(String, usize, usize)>, String, usize) {
    let head = format!("pub struct {name} {{");
    let start = source
        .find(&head)
        .unwrap_or_else(|| panic!("{head} not in the program source"));
    let attrs = source[..start].rsplit("\n\n").next().unwrap().to_string();
    let body = &source[start + head.len()..];
    let body = &body[..body.find("\n}").unwrap()];
    let mut offset = 8;
    let mut fields = Vec::new();
    for line in body.lines().map(str::trim) {
        let Some(decl) = line.strip_prefix("pub ") else {
            continue;
        };
        let (field, ty) = decl.trim_end_matches(',').split_once(':').unwrap();
        let size = size_of(ty.trim());
        fields.push((field.trim().to_string(), offset, size));
        offset += size;
    }
    (fields, attrs, offset)
}

fn check(fields: &[(String, usize, usize)], ours: &[Field]) {
    for f in ours {
        let theirs = fields
            .iter()
            .find(|(n, ..)| n == f.name)
            .unwrap_or_else(|| panic!("the program has no field {}", f.name));
        assert_eq!((theirs.1, theirs.2), (f.offset, f.size), "{} moved", f.name);
    }
}

#[test]
fn pool_state_matches_the_program() {
    let (fields, attrs, len) = layout(&program_file("states/pool.rs"), "PoolState");
    assert!(
        attrs.contains("#[repr(C, packed)]"),
        "PoolState is no longer packed:\n{attrs}"
    );
    assert_eq!(len, POOL_STATE_LEN);
    check(&fields, pool_fields::ALL);
}

#[test]
fn amm_config_matches_the_program() {
    let (fields, attrs, len) = layout(&program_file("states/config.rs"), "AmmConfig");
    assert!(
        attrs.contains("#[account]"),
        "AmmConfig is no longer a Borsh account:\n{attrs}"
    );
    assert_eq!(len, AMM_CONFIG_LEN);
    check(&fields, config_fields::ALL);
}

#[test]
fn discriminators_and_seed_match_the_program() {
    let disc = |preimage: &str| -> [u8; 8] { Sha256::digest(preimage)[..8].try_into().unwrap() };
    assert_eq!(disc("account:PoolState"), POOL_STATE_DISCRIMINATOR);
    assert_eq!(disc("account:AmmConfig"), AMM_CONFIG_DISCRIMINATOR);
    assert_eq!(
        disc("global:swap_base_input"),
        SWAP_BASE_INPUT_DISCRIMINATOR
    );
    // The instruction this crate encodes is the program's, with these two arguments.
    let lib = program_file("lib.rs");
    assert!(
        lib.contains(
            "pub fn swap_base_input(\n        ctx: Context<Swap>,\n        amount_in: u64,\n        minimum_amount_out: u64,\n    )"
        ),
        "swap_base_input's arguments changed",
    );
    // The seed `tests/ours.rs` derives `AUTHORITY` from.
    assert!(lib.contains(r#"pub const AUTH_SEED: &str = "vault_and_lp_mint_auth_seed";"#));
}

/// The 13 accounts a swap hands the program carry the signer and writable flags the IDL gives
/// `swap_base_input`, in its order: only the trader signs, and the trader's key and the fee
/// tier are read only.
#[test]
fn a_swaps_account_flags_are_the_idls() {
    let text = std::fs::read_to_string(IDL).unwrap_or_else(|e| {
        panic!("read the program's {IDL} ({e}): run this inside the repository")
    });
    let idl: serde_json::Value = serde_json::from_str(&text).expect("the IDL is JSON");
    let ix = idl["instructions"]
        .as_array()
        .expect("instructions")
        .iter()
        .find(|i| i["name"] == "swap_base_input")
        .expect("swap_base_input in the IDL");
    let flag = |a: &serde_json::Value, f: &str| a[f].as_bool().unwrap_or(false);
    let want: Vec<(&str, bool, bool)> = ix["accounts"]
        .as_array()
        .expect("accounts")
        .iter()
        .map(|a| {
            assert!(a.get("accounts").is_none(), "a nested account list: {a}");
            (
                a["name"].as_str().unwrap(),
                flag(a, "signer"),
                flag(a, "writable"),
            )
        })
        .collect();
    for pool in common::POOLS {
        let amm = common::amm(&pool);
        assert_eq!(amm.get_accounts_len(), want.len(), "{pool}");
        let mints = amm.get_reserve_mints();
        let trader = Pubkey::new_unique();
        for (input, output) in [(mints[0], mints[1]), (mints[1], mints[0])] {
            let metas = amm
                .get_swap_and_account_metas(&SwapParams {
                    swap_mode: SwapMode::ExactIn,
                    in_amount: 1_000,
                    out_amount: 1,
                    source_mint: input,
                    destination_mint: output,
                    source_token_account: Pubkey::new_unique(),
                    destination_token_account: Pubkey::new_unique(),
                    token_transfer_authority: trader,
                    user: trader,
                    payer: trader,
                    quote_mint_to_referrer: None,
                    jupiter_program_id: &Pubkey::new_unique(),
                    missing_dynamic_accounts_as_default: false,
                })
                .expect("account metas")
                .account_metas;
            assert_eq!(metas.len(), want.len(), "{pool}");
            for (meta, (name, signer, writable)) in metas.iter().zip(&want) {
                assert_eq!(
                    (meta.is_signer, meta.is_writable),
                    (*signer, *writable),
                    "{pool}: {name}"
                );
            }
        }
    }
}
