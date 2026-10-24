//! The pool program's two accounts this crate reads, decoded from their bytes.
//!
//! Mirrors of `programs/cp-swap/src/states/pool.rs` (`PoolState`, zero-copy and
//! `#[repr(C, packed)]`) and `programs/cp-swap/src/states/config.rs` (`AmmConfig`, Borsh).
//! Neither layout has padding between fields, so each field sits at the sum of the sizes
//! before it. `tests/layout.rs` recomputes every offset below from the program's own source
//! and fails if one moves. The program crate itself is not a dependency: it builds on the
//! Solana 2 crates and this one on Jupiter's Solana 3/4 generation, and two `Pubkey` types
//! do not mix.

use solana_pubkey::Pubkey;

/// One field this crate reads: where it sits in the account and how many bytes it takes.
#[derive(Clone, Copy, Debug)]
pub struct Field {
    pub name: &'static str,
    pub offset: usize,
    pub size: usize,
}

const fn field(name: &'static str, offset: usize, size: usize) -> Field {
    Field { name, offset, size }
}

/// `PoolState::LEN`: the 8-byte Anchor discriminator plus the struct.
pub const POOL_STATE_LEN: usize = 637;
/// `AmmConfig::LEN`.
pub const AMM_CONFIG_LEN: usize = 236;

/// sha256("account:PoolState")[..8]
pub const POOL_STATE_DISCRIMINATOR: [u8; 8] = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];
/// sha256("account:AmmConfig")[..8]
pub const AMM_CONFIG_DISCRIMINATOR: [u8; 8] = [0xda, 0xf4, 0x21, 0x68, 0xcb, 0xcb, 0x2b, 0x6f];

pub mod pool_fields {
    use super::{Field, field};

    pub const AMM_CONFIG: Field = field("amm_config", 8, 32);
    pub const TOKEN_0_VAULT: Field = field("token_0_vault", 72, 32);
    pub const TOKEN_1_VAULT: Field = field("token_1_vault", 104, 32);
    pub const TOKEN_0_MINT: Field = field("token_0_mint", 168, 32);
    pub const TOKEN_1_MINT: Field = field("token_1_mint", 200, 32);
    pub const TOKEN_0_PROGRAM: Field = field("token_0_program", 232, 32);
    pub const TOKEN_1_PROGRAM: Field = field("token_1_program", 264, 32);
    pub const OBSERVATION_KEY: Field = field("observation_key", 296, 32);
    pub const STATUS: Field = field("status", 329, 1);
    pub const PROTOCOL_FEES_TOKEN_0: Field = field("protocol_fees_token_0", 341, 8);
    pub const PROTOCOL_FEES_TOKEN_1: Field = field("protocol_fees_token_1", 349, 8);
    pub const FUND_FEES_TOKEN_0: Field = field("fund_fees_token_0", 357, 8);
    pub const FUND_FEES_TOKEN_1: Field = field("fund_fees_token_1", 365, 8);
    pub const OPEN_TIME: Field = field("open_time", 373, 8);
    pub const CREATOR_FEE_ON: Field = field("creator_fee_on", 389, 1);
    pub const ENABLE_CREATOR_FEE: Field = field("enable_creator_fee", 390, 1);
    pub const CREATOR_FEES_TOKEN_0: Field = field("creator_fees_token_0", 397, 8);
    pub const CREATOR_FEES_TOKEN_1: Field = field("creator_fees_token_1", 405, 8);

    /// Every `PoolState` field this crate reads.
    pub const ALL: &[Field] = &[
        AMM_CONFIG,
        TOKEN_0_VAULT,
        TOKEN_1_VAULT,
        TOKEN_0_MINT,
        TOKEN_1_MINT,
        TOKEN_0_PROGRAM,
        TOKEN_1_PROGRAM,
        OBSERVATION_KEY,
        STATUS,
        PROTOCOL_FEES_TOKEN_0,
        PROTOCOL_FEES_TOKEN_1,
        FUND_FEES_TOKEN_0,
        FUND_FEES_TOKEN_1,
        OPEN_TIME,
        CREATOR_FEE_ON,
        ENABLE_CREATOR_FEE,
        CREATOR_FEES_TOKEN_0,
        CREATOR_FEES_TOKEN_1,
    ];
}

pub mod config_fields {
    use super::{Field, field};

    pub const TRADE_FEE_RATE: Field = field("trade_fee_rate", 12, 8);
    pub const PROTOCOL_FEE_RATE: Field = field("protocol_fee_rate", 20, 8);
    pub const FUND_FEE_RATE: Field = field("fund_fee_rate", 28, 8);
    pub const PROTOCOL_OWNER: Field = field("protocol_owner", 44, 32);
    pub const FUND_OWNER: Field = field("fund_owner", 76, 32);
    pub const CREATOR_FEE_RATE: Field = field("creator_fee_rate", 108, 8);

    /// Every `AmmConfig` field this crate reads.
    pub const ALL: &[Field] = &[
        TRADE_FEE_RATE,
        PROTOCOL_FEE_RATE,
        FUND_FEE_RATE,
        PROTOCOL_OWNER,
        FUND_OWNER,
        CREATOR_FEE_RATE,
    ];
}

/// The `PoolState` fields a quote and a swap need.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PoolState {
    pub amm_config: Pubkey,
    pub token_0_vault: Pubkey,
    pub token_1_vault: Pubkey,
    pub token_0_mint: Pubkey,
    pub token_1_mint: Pubkey,
    pub token_0_program: Pubkey,
    pub token_1_program: Pubkey,
    pub observation_key: Pubkey,
    pub status: u8,
    pub protocol_fees_token_0: u64,
    pub protocol_fees_token_1: u64,
    pub fund_fees_token_0: u64,
    pub fund_fees_token_1: u64,
    pub open_time: u64,
    pub creator_fee_on: u8,
    pub enable_creator_fee: bool,
    pub creator_fees_token_0: u64,
    pub creator_fees_token_1: u64,
}

/// The `AmmConfig` fields a quote needs, and the two fee collectors it names.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AmmConfig {
    pub trade_fee_rate: u64,
    pub protocol_fee_rate: u64,
    pub fund_fee_rate: u64,
    pub protocol_owner: Pubkey,
    pub fund_owner: Pubkey,
    pub creator_fee_rate: u64,
}

/// pool.rs `PoolStatusBitIndex::Swap`: a SET bit disables swaps.
const STATUS_SWAP_BIT: u8 = 1 << 2;

impl PoolState {
    /// Decode a pool account's data. `None` unless it is the full account with the
    /// `PoolState` discriminator.
    pub fn decode(data: &[u8]) -> Option<Self> {
        use pool_fields::*;
        if data.len() < POOL_STATE_LEN || data[..8] != POOL_STATE_DISCRIMINATOR {
            return None;
        }
        Some(Self {
            amm_config: pubkey_at(data, AMM_CONFIG)?,
            token_0_vault: pubkey_at(data, TOKEN_0_VAULT)?,
            token_1_vault: pubkey_at(data, TOKEN_1_VAULT)?,
            token_0_mint: pubkey_at(data, TOKEN_0_MINT)?,
            token_1_mint: pubkey_at(data, TOKEN_1_MINT)?,
            token_0_program: pubkey_at(data, TOKEN_0_PROGRAM)?,
            token_1_program: pubkey_at(data, TOKEN_1_PROGRAM)?,
            observation_key: pubkey_at(data, OBSERVATION_KEY)?,
            status: data[STATUS.offset],
            protocol_fees_token_0: u64_at(data, PROTOCOL_FEES_TOKEN_0)?,
            protocol_fees_token_1: u64_at(data, PROTOCOL_FEES_TOKEN_1)?,
            fund_fees_token_0: u64_at(data, FUND_FEES_TOKEN_0)?,
            fund_fees_token_1: u64_at(data, FUND_FEES_TOKEN_1)?,
            open_time: u64_at(data, OPEN_TIME)?,
            creator_fee_on: data[CREATOR_FEE_ON.offset],
            enable_creator_fee: data[ENABLE_CREATOR_FEE.offset] != 0,
            creator_fees_token_0: u64_at(data, CREATOR_FEES_TOKEN_0)?,
            creator_fees_token_1: u64_at(data, CREATOR_FEES_TOKEN_1)?,
        })
    }

    /// pool.rs `get_status_by_bit(PoolStatusBitIndex::Swap)`.
    pub fn swap_enabled(&self) -> bool {
        self.status & STATUS_SWAP_BIT == 0
    }
}

impl AmmConfig {
    /// Decode a fee tier's data. `None` unless it is the full account with the
    /// `AmmConfig` discriminator.
    pub fn decode(data: &[u8]) -> Option<Self> {
        use config_fields::*;
        if data.len() < AMM_CONFIG_LEN || data[..8] != AMM_CONFIG_DISCRIMINATOR {
            return None;
        }
        Some(Self {
            trade_fee_rate: u64_at(data, TRADE_FEE_RATE)?,
            protocol_fee_rate: u64_at(data, PROTOCOL_FEE_RATE)?,
            fund_fee_rate: u64_at(data, FUND_FEE_RATE)?,
            protocol_owner: pubkey_at(data, PROTOCOL_OWNER)?,
            fund_owner: pubkey_at(data, FUND_OWNER)?,
            creator_fee_rate: u64_at(data, CREATOR_FEE_RATE)?,
        })
    }
}

fn pubkey_at(data: &[u8], f: Field) -> Option<Pubkey> {
    Pubkey::try_from(data.get(f.offset..f.offset + f.size)?).ok()
}

fn u64_at(data: &[u8], f: Field) -> Option<u64> {
    Some(u64::from_le_bytes(
        data.get(f.offset..f.offset + f.size)?.try_into().ok()?,
    ))
}

/// spl-token (and Token-2022) account: mint(32) owner(32) amount(u64 LE @64).
pub fn token_account_amount(data: &[u8]) -> Option<u64> {
    Some(u64::from_le_bytes(data.get(64..72)?.try_into().ok()?))
}

/// spl-token (and Token-2022) account: the mint it holds, at its first 32 bytes.
pub fn token_account_mint(data: &[u8]) -> Option<Pubkey> {
    Pubkey::try_from(data.get(..32)?).ok()
}

/// spl-token `Mint::LEN`: a mint with no extensions.
const MINT_LEN: usize = 82;
/// Token-2022 `ExtensionType::TransferFeeConfig`.
const EXTENSION_TRANSFER_FEE_CONFIG: u16 = 1;
/// Token-2022: a mint's extensions start after the 165-byte account-sized base and one
/// account-type byte, as (type u16, length u16, value) records.
const EXTENSIONS_START: usize = 166;

/// Does this Token-2022 mint carry a transfer fee? `None` when the bytes do not read as a
/// mint. The program takes a transfer fee out of both legs of a swap (utils/token.rs
/// `get_transfer_fee`); this crate quotes no such pool.
pub fn has_transfer_fee(mint_data: &[u8]) -> Option<bool> {
    if mint_data.len() == MINT_LEN {
        return Some(false);
    }
    // AccountType::Mint, after the padded base.
    if mint_data.len() < EXTENSIONS_START || mint_data[EXTENSIONS_START - 1] != 1 {
        return None;
    }
    let mut at = EXTENSIONS_START;
    while at + 4 <= mint_data.len() {
        let kind = u16::from_le_bytes([mint_data[at], mint_data[at + 1]]);
        let len = u16::from_le_bytes([mint_data[at + 2], mint_data[at + 3]]) as usize;
        if kind == 0 {
            break; // Uninitialized: the rest is unused space
        }
        if kind == EXTENSION_TRANSFER_FEE_CONFIG {
            return Some(true);
        }
        at = at.checked_add(4 + len)?;
    }
    if at > mint_data.len() {
        return None;
    }
    Some(false)
}
