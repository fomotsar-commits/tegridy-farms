//! The snapshotted pools, loaded the way Jupiter loads a pool: `from_keyed_account`, then
//! `update` from the accounts the AMM asks for.

#![allow(dead_code)]

use std::collections::HashMap;

use jupiter_amm_interface::{Amm, AmmContext, ClockRef, KeyedAccount};
use jupiter_amm_test_kit::PoolSnapshot;
use memetics_jupiter_sdk::MemeticsAmm;
use solana_account::Account;
use solana_pubkey::{Pubkey, pubkey};

pub const BAYLA_SOL_POOL: Pubkey = pubkey!("ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4");
pub const BAYLA_USDC_POOL: Pubkey = pubkey!("J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm");
pub const POOLS: [Pubkey; 2] = [BAYLA_SOL_POOL, BAYLA_USDC_POOL];

pub fn snapshot(pool: &Pubkey) -> PoolSnapshot {
    let dir = format!("tests/fixtures/accounts/{pool}");
    PoolSnapshot::load_dir(&dir).unwrap_or_else(|e| panic!("load {dir}: {e}"))
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
