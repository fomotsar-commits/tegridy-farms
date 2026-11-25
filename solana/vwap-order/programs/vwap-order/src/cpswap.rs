//! What this program reads of the venue's swap program (our cp-swap copy): its id, the
//! one instruction a slice may be, and three of its account layouts, byte offsets taken
//! from `solana/tegridy-amm/programs/cp-swap/src/states/`. The tests run the real
//! cp-swap build, so an offset that drifts fails them.

use anchor_lang::prelude::*;

#[cfg(not(feature = "devnet"))]
pub const ID: Pubkey = pubkey!("EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT");
#[cfg(feature = "devnet")]
pub const ID: Pubkey = pubkey!("BvBkt84ZiKmiPSuWrdefxbxPTX5YiLnU6YEGtY6pDodL");

/// Anchor's 8-byte names: the first 8 bytes of sha256 of "global:swap_base_input",
/// "account:PoolState", "account:AmmConfig", "account:ObservationState" (pinned in the tests).
pub const SWAP_BASE_INPUT: [u8; 8] = [143, 190, 90, 218, 196, 30, 51, 222];
const POOL_STATE: [u8; 8] = [247, 237, 227, 245, 215, 195, 222, 70];
const AMM_CONFIG: [u8; 8] = [218, 244, 33, 104, 203, 203, 43, 111];
const OBSERVATION_STATE: [u8; 8] = [122, 174, 197, 53, 129, 9, 165, 132];

/// `swap_base_input(amount_in: u64, minimum_amount_out: u64)`: 8 + 8 + 8 bytes of data.
pub const SWAP_DATA_LEN: usize = 24;
/// Its accounts, in the order of cp-swap's `Swap` struct.
pub const SWAP_PAYER: usize = 0;
pub const SWAP_POOL: usize = 3;
pub const SWAP_INPUT_ACCOUNT: usize = 4;
pub const SWAP_OUTPUT_ACCOUNT: usize = 5;
pub const SWAP_ACCOUNTS: usize = 13;

/// `PoolState`, zero-copy and packed: 8 + 10 keys + 5 bytes + ... = 637 bytes.
pub const POOL_LEN: usize = 637;
const POOL_AMM_CONFIG: usize = 8;
const POOL_TOKEN_0_VAULT: usize = 72;
const POOL_TOKEN_1_VAULT: usize = 104;
const POOL_TOKEN_0_MINT: usize = 168;
const POOL_TOKEN_1_MINT: usize = 200;
const POOL_OBSERVATION: usize = 296;

/// `AmmConfig`, 236 bytes; our copy keeps the tier's keeper at 124 (`states/config.rs`).
pub const CONFIG_LEN: usize = 236;
const CONFIG_KEEPER: usize = 124;

/// `ObservationState`, zero-copy and packed: 100 observations of 40 bytes from byte 43.
pub const OBSERVATION_LEN: usize = 4_075;
const OBS_INITIALIZED: usize = 8;
const OBS_INDEX: usize = 9;
const OBS_POOL: usize = 11;
const OBS_FIRST: usize = 43;
const OBS_SIZE: usize = 40;
const OBS_COUNT: usize = 100;
const OBS_LAST_UPDATE: usize = OBS_FIRST + OBS_SIZE * OBS_COUNT;

fn key_at(d: &[u8], at: usize) -> Pubkey {
    Pubkey::try_from(&d[at..at + 32]).unwrap()
}
fn u64_at(d: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}
fn u128_at(d: &[u8], at: usize) -> u128 {
    u128::from_le_bytes(d[at..at + 16].try_into().unwrap())
}

/// `read` over the data of an account cp-swap owns, of the given size and name, or nothing.
fn owned<T>(info: &AccountInfo, len: usize, name: [u8; 8], read: impl FnOnce(&[u8]) -> Option<T>) -> Option<T> {
    if *info.owner != ID {
        return None;
    }
    let d = info.try_borrow_data().ok()?;
    if d.len() != len || d[..8] != name {
        return None;
    }
    read(&d)
}

pub struct Pool {
    pub amm_config: Pubkey,
    pub token_0_vault: Pubkey,
    pub token_1_vault: Pubkey,
    pub token_0_mint: Pubkey,
    pub token_1_mint: Pubkey,
    pub observation: Pubkey,
}

pub fn read_pool(info: &AccountInfo) -> Option<Pool> {
    owned(info, POOL_LEN, POOL_STATE, |d| {
        Some(Pool {
            amm_config: key_at(d, POOL_AMM_CONFIG),
            token_0_vault: key_at(d, POOL_TOKEN_0_VAULT),
            token_1_vault: key_at(d, POOL_TOKEN_1_VAULT),
            token_0_mint: key_at(d, POOL_TOKEN_0_MINT),
            token_1_mint: key_at(d, POOL_TOKEN_1_MINT),
            observation: key_at(d, POOL_OBSERVATION),
        })
    })
}

/// The tier's keeper, who swaps free of the trade fee (all-zero = nobody).
pub fn read_keeper(info: &AccountInfo) -> Option<Pubkey> {
    owned(info, CONFIG_LEN, AMM_CONFIG, |d| Some(key_at(d, CONFIG_KEEPER)))
}

/// The newest running total of the pool's price, for token 0 (`token_0` true) or token 1,
/// and the second it is good to. cp-swap adds `price before the swap x seconds` on each
/// swap, so the total moves only with time: a price pushed in this second is in no total yet.
pub fn read_cumulative(info: &AccountInfo, pool: &Pubkey, token_0: bool) -> Option<(u128, u64)> {
    owned(info, OBSERVATION_LEN, OBSERVATION_STATE, |d| {
        if d[OBS_INITIALIZED] == 0 || key_at(d, OBS_POOL) != *pool {
            return None;
        }
        let i = u16::from_le_bytes([d[OBS_INDEX], d[OBS_INDEX + 1]]) as usize;
        if i >= OBS_COUNT {
            return None;
        }
        let at = OBS_FIRST + OBS_SIZE * i + 8 + if token_0 { 0 } else { 16 };
        Some((u128_at(d, at), u64_at(d, OBS_LAST_UPDATE)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(preimage: &str) -> [u8; 8] {
        solana_sha256_hasher::hash(preimage.as_bytes()).to_bytes()[..8].try_into().unwrap()
    }

    #[test]
    fn the_names_are_anchors_for_these_preimages() {
        assert_eq!(SWAP_BASE_INPUT, name("global:swap_base_input"));
        assert_eq!(POOL_STATE, name("account:PoolState"));
        assert_eq!(AMM_CONFIG, name("account:AmmConfig"));
        assert_eq!(OBSERVATION_STATE, name("account:ObservationState"));
    }
}
