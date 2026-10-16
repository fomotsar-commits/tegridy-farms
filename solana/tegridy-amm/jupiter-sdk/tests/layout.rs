//! The byte layout this crate reads is the program's own: every offset in `src/state.rs` is
//! recomputed here from the program's source (`../programs/cp-swap`), and the discriminators
//! and the signer's seed from their definitions. This test runs inside the repository, where
//! that source is; outside it, it fails rather than pass without reading it.

use memetics_jupiter_sdk::SWAP_BASE_INPUT_DISCRIMINATOR;
use memetics_jupiter_sdk::state::{
    AMM_CONFIG_DISCRIMINATOR, AMM_CONFIG_LEN, Field, POOL_STATE_DISCRIMINATOR, POOL_STATE_LEN,
    config_fields, pool_fields,
};
use sha2::{Digest, Sha256};

const PROGRAM_SRC: &str = "../programs/cp-swap/src";

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
