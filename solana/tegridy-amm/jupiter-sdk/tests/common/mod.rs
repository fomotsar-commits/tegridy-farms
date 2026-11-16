//! The snapshotted pools, loaded the way Jupiter loads a pool: `from_keyed_account`, then
//! `update` from the accounts the AMM asks for. `snapshot` is the guard-off view below.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;

use jupiter_amm_interface::{Amm, AmmContext, ClockRef, KeyedAccount};
use jupiter_amm_test_kit::PoolSnapshot;
use memetics_jupiter_sdk::MemeticsAmm;
use memetics_jupiter_sdk::state::{PoolState, config_fields};
use solana_account::Account;
use solana_pubkey::{Pubkey, pubkey};

pub const BAYLA_SOL_POOL: Pubkey = pubkey!("ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4");
pub const BAYLA_USDC_POOL: Pubkey = pubkey!("J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm");
pub const POOLS: [Pubkey; 2] = [BAYLA_SOL_POOL, BAYLA_USDC_POOL];

/// The pool's accounts as mainnet held them (`tests/fixtures/accounts/<pool>/`).
pub fn mainnet_snapshot(pool: &Pubkey) -> PoolSnapshot {
    let dir = format!("tests/fixtures/accounts/{pool}");
    PoolSnapshot::load_dir(&dir).unwrap_or_else(|e| panic!("load {dir}: {e}"))
}

/// The mainnet snapshot with one change: the fee tier's swap guard cleared. Every live tier is
/// guarded and the SDK quotes no guarded tier, so quotes are checked on a tier as it would be
/// listed. The guard moves no amount: it only refuses a swap another program calls.
pub fn snapshot(pool: &Pubkey) -> PoolSnapshot {
    let mainnet = mainnet_snapshot(pool);
    let mut accounts: HashMap<Pubkey, Account> =
        std::fs::read_dir(format!("tests/fixtures/accounts/{pool}"))
            .expect("read the snapshot")
            .map(|e| {
                let path = e.unwrap().path();
                let key: Pubkey = path.file_stem().unwrap().to_str().unwrap().parse().unwrap();
                (key, account(&mainnet, &key))
            })
            .collect();
    let tier = PoolState::decode(&accounts[pool].data).expect("pool decodes").amm_config;
    let f = config_fields::SWAP_GUARD;
    accounts.get_mut(&tier).unwrap().data[f.offset..f.offset + f.size].fill(0);
    PoolSnapshot::from_accounts(accounts)
}

/// `snapshot(pool)` written under cargo's `CARGO_TARGET_TMPDIR`, for the kit's `PoolTest`.
pub fn snapshot_dir(pool: &Pubkey) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("guard-off/{pool}"));
    snapshot(pool).save_dir(&dir).expect("write the guard-off copy");
    dir
}

pub fn account(snapshot: &PoolSnapshot, key: &Pubkey) -> Account {
    snapshot
        .get(key)
        .unwrap_or_else(|| panic!("{key} not in the snapshot"))
        .clone()
}

/// The AMM built and updated from `accounts`, at the snapshot's clock.
pub fn amm_from(
    snapshot: &PoolSnapshot,
    pool: &Pubkey,
    accounts: &HashMap<Pubkey, Account>,
) -> Result<MemeticsAmm, jupiter_amm_interface::AmmError> {
    let context = AmmContext {
        clock_ref: ClockRef::from(snapshot.clock().expect("clock in snapshot")),
    };
    let keyed = KeyedAccount {
        key: *pool,
        account: account(snapshot, pool),
        params: None,
    };
    let mut amm = MemeticsAmm::from_keyed_account(&keyed, &context)?;
    let provider: HashMap<Pubkey, &Account> = accounts.iter().map(|(k, a)| (*k, a)).collect();
    amm.update(provider)?;
    Ok(amm)
}

/// Exactly the accounts the AMM asks to be updated with, from the snapshot.
pub fn accounts_to_update(snapshot: &PoolSnapshot, pool: &Pubkey) -> HashMap<Pubkey, Account> {
    let context = AmmContext {
        clock_ref: ClockRef::from(snapshot.clock().expect("clock in snapshot")),
    };
    let keyed = KeyedAccount {
        key: *pool,
        account: account(snapshot, pool),
        params: None,
    };
    let amm = MemeticsAmm::from_keyed_account(&keyed, &context).expect("from_keyed_account");
    amm.get_accounts_to_update()
        .iter()
        .map(|k| (*k, account(snapshot, k)))
        .collect()
}

pub fn amm(pool: &Pubkey) -> MemeticsAmm {
    let snapshot = snapshot(pool);
    let accounts = accounts_to_update(&snapshot, pool);
    amm_from(&snapshot, pool, &accounts).expect("update from the snapshot")
}
