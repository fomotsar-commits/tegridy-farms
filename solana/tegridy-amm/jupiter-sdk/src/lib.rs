//! Jupiter `Amm` for the Memetics pools: the constant-product program at
//! `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`, a fork of raydium-cp-swap (Apache-2.0)
//! whose swap, curve and fee code is byte-identical to upstream's.
//!
//! All it does, per Jupiter's DEX integration rules: decode the pool, its fee tier, its two
//! vaults and its two mints in `update`; quote ExactIn swaps in `quote`, with no network call;
//! and list the accounts of the program's own `swap_base_input`.
//!
//! HOW MONEY MOVES on a swap: the trader pays the fee tier's trade fee out of the input. The
//! venue's cut of that fee (protocol_fee_rate and fund_fee_rate, taken OUT of the trade fee)
//! stays in the pool's token account, booked to the venue, until the venue's vault collects
//! it; the rest of the fee stays in the pool for the people who supplied it. A swap pays
//! nobody outside the pool. `update` refuses a fee tier whose collectors are not the
//! venue's vault, so no quote is ever given for a pool whose cut would go anywhere else.

pub mod math;
pub mod state;

use jupiter_amm_interface::{
    AccountProvider, Amm, AmmContext, AmmError, AmmLabel, ClockRef, KeyedAccount, Quote,
    QuoteParams, SingleProgramAmm, Swap, SwapAndAccountMetas, SwapMode, SwapParams,
    single_program_amm,
};
use rust_decimal::Decimal;
use solana_account::ReadableAccount;
use solana_instruction::AccountMeta;
use solana_pubkey::{Pubkey, pubkey};
use std::sync::atomic::Ordering;

use crate::math::{FEE_RATE_DENOMINATOR_VALUE, Refusal, swap_exact_in};
use crate::state::{
    AmmConfig, PoolState, has_transfer_fee, token_account_amount, token_account_mint,
};

/// The pool program, on mainnet since 2026-09-29.
pub const PROGRAM_ID: Pubkey = pubkey!("EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT");
/// The program's own signer over every pool's token accounts: the address of
/// `[b"vault_and_lp_mint_auth_seed"]` under `PROGRAM_ID` (lib.rs `AUTH_SEED`).
pub const AUTHORITY: Pubkey = pubkey!("Bkr8XPZySJmcUAxKSDNCcH5KE2WDs2Y3GeZLRbeATSfB");
/// The venue's Squads vault: the only fee collector a fee tier may name.
pub const VENUE_VAULT: Pubkey = pubkey!("GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd");
pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// sha256("global:swap_base_input")[..8]
pub const SWAP_BASE_INPUT_DISCRIMINATOR: [u8; 8] = [143, 190, 90, 218, 196, 30, 51, 222];

/// The program's `swap_base_input(amount_in, minimum_amount_out)` instruction data.
pub fn swap_base_input_data(amount_in: u64, minimum_amount_out: u64) -> Vec<u8> {
    let mut data = Vec::with_capacity(8 + 8 + 8);
    data.extend_from_slice(&SWAP_BASE_INPUT_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&minimum_amount_out.to_le_bytes());
    data
}

/// Everything `update` reads besides the pool.
#[derive(Clone, Debug)]
struct Market {
    config: AmmConfig,
    vault_0: u64,
    vault_1: u64,
    /// A Token-2022 transfer fee on either mint: the program charges it on both legs, and
    /// this crate gives no quote rather than a quote that is wrong by that fee.
    transfer_fee: bool,
}

#[derive(Clone)]
pub struct MemeticsAmm {
    key: Pubkey,
    pool: PoolState,
    /// `None` until the first `update`; a quote before it is refused.
    market: Option<Market>,
    clock: ClockRef,
}

single_program_amm!(MemeticsAmm, PROGRAM_ID, "Memetics");

impl MemeticsAmm {
    fn decode_pool(account: &impl ReadableAccount) -> Result<PoolState, AmmError> {
        if account.owner() != &PROGRAM_ID {
            return Err("pool is not owned by the Memetics pool program".into());
        }
        PoolState::decode(account.data()).ok_or_else(|| "account is not a Memetics pool".into())
    }

    /// One of the pool's token accounts: owned by the token program the pool names, holding
    /// the mint the pool names. Returns its balance.
    fn vault_amount(
        provider: &impl AccountProvider,
        vault: &Pubkey,
        token_program: &Pubkey,
        mint: &Pubkey,
    ) -> Result<u64, AmmError> {
        let account = provider.try_get(vault)?;
        if account.owner() != token_program || token_account_mint(account.data()) != Some(*mint) {
            return Err(format!("pool token account {vault} is not the pool's").into());
        }
        token_account_amount(account.data())
            .ok_or_else(|| format!("pool token account {vault} did not decode").into())
    }

    /// Does this mint, owned by the token program the pool names, carry a transfer fee?
    fn mint_transfer_fee(
        provider: &impl AccountProvider,
        mint: &Pubkey,
        token_program: &Pubkey,
    ) -> Result<bool, AmmError> {
        let account = provider.try_get(mint)?;
        if account.owner() != token_program {
            return Err(
                format!("mint {mint} is not owned by the token program the pool names").into(),
            );
        }
        if *token_program == TOKEN_PROGRAM {
            return Ok(false);
        }
        if *token_program != TOKEN_2022_PROGRAM {
            return Err(format!("mint {mint} is owned by an unknown token program").into());
        }
        has_transfer_fee(account.data()).ok_or_else(|| format!("mint {mint} did not decode").into())
    }
}

impl Amm for MemeticsAmm {
    fn from_keyed_account(
        keyed_account: &KeyedAccount,
        amm_context: &AmmContext,
    ) -> Result<Self, AmmError> {
        Ok(Self {
            key: keyed_account.key,
            pool: Self::decode_pool(&keyed_account.account)?,
            market: None,
            clock: amm_context.clock_ref.clone(),
        })
    }

    fn label(&self) -> AmmLabel {
        Self::LABEL
    }

    fn program_id(&self) -> Pubkey {
        Self::PROGRAM_ID
    }

    fn key(&self) -> Pubkey {
        self.key
    }

    fn get_reserve_mints(&self) -> Vec<Pubkey> {
        vec![self.pool.token_0_mint, self.pool.token_1_mint]
    }

    fn get_accounts_to_update(&self) -> Vec<Pubkey> {
        vec![
            self.key,
            self.pool.amm_config,
            self.pool.token_0_vault,
            self.pool.token_1_vault,
            self.pool.token_0_mint,
            self.pool.token_1_mint,
        ]
    }

    fn update(&mut self, account_provider: impl AccountProvider) -> Result<(), AmmError> {
        let pool = Self::decode_pool(&account_provider.try_get(&self.key)?)?;

        let config = {
            let account = account_provider.try_get(&pool.amm_config)?;
            if account.owner() != &PROGRAM_ID {
                return Err("fee tier is not owned by the Memetics pool program".into());
            }
            AmmConfig::decode(account.data())
                .ok_or_else(|| AmmError::from("account is not a Memetics fee tier"))?
        };
        if config.protocol_owner != VENUE_VAULT || config.fund_owner != VENUE_VAULT {
            return Err("fee tier names a fee collector that is not the venue's vault".into());
        }

        let vault_0 = Self::vault_amount(
            &account_provider,
            &pool.token_0_vault,
            &pool.token_0_program,
            &pool.token_0_mint,
        )?;
        let vault_1 = Self::vault_amount(
            &account_provider,
            &pool.token_1_vault,
            &pool.token_1_program,
            &pool.token_1_mint,
        )?;
        let fee_0 =
            Self::mint_transfer_fee(&account_provider, &pool.token_0_mint, &pool.token_0_program)?;
        let fee_1 =
            Self::mint_transfer_fee(&account_provider, &pool.token_1_mint, &pool.token_1_program)?;

        self.pool = pool;
        self.market = Some(Market {
            config,
            vault_0,
            vault_1,
            transfer_fee: fee_0 || fee_1,
        });
        Ok(())
    }

    fn quote(&self, quote_params: &QuoteParams) -> Result<Quote, AmmError> {
        if quote_params.swap_mode != SwapMode::ExactIn {
            return Err("only ExactIn swaps are quoted".into());
        }
        let market = self
            .market
            .as_ref()
            .ok_or_else(|| AmmError::from("pool not updated yet"))?;
        if market.transfer_fee {
            return Err("a mint in this pool charges a transfer fee; no quote is given".into());
        }
        let input_is_token_0 = match (quote_params.input_mint, quote_params.output_mint) {
            (i, o) if i == self.pool.token_0_mint && o == self.pool.token_1_mint => true,
            (i, o) if i == self.pool.token_1_mint && o == self.pool.token_0_mint => false,
            _ => return Err("mints are not this pool's pair".into()),
        };

        let result = swap_exact_in(
            &self.pool,
            &market.config,
            market.vault_0,
            market.vault_1,
            input_is_token_0,
            quote_params.amount,
            self.clock.unix_timestamp.load(Ordering::Relaxed),
        )
        .map_err(|r: Refusal| AmmError::from(format!("the program refuses this swap: {r:?}")))?;

        // `fee_amount` is what the trader pays in the input token: the trade fee, and the
        // creator's cut when it is charged on the input. `fee_pct` is every rate the trader
        // pays (pool.rs `adjust_creator_fee_rate` zeroes the creator's when it is off).
        let creator_fee_rate = if self.pool.enable_creator_fee {
            market.config.creator_fee_rate
        } else {
            0
        };
        let fee_amount = if result.creator_fee_on_input {
            result.trade_fee.saturating_add(result.creator_fee)
        } else {
            result.trade_fee
        };
        Ok(Quote {
            in_amount: quote_params.amount,
            out_amount: result.output_amount,
            fee_amount,
            fee_mint: quote_params.input_mint,
            fee_pct: Decimal::from(
                market
                    .config
                    .trade_fee_rate
                    .saturating_add(creator_fee_rate),
            ) / Decimal::from(FEE_RATE_DENOMINATOR_VALUE),
        })
    }

    fn get_swap_and_account_metas(
        &self,
        swap_params: &SwapParams,
    ) -> Result<SwapAndAccountMetas, AmmError> {
        let pool = &self.pool;
        let (input_vault, output_vault, input_program, output_program) = if swap_params.source_mint
            == pool.token_0_mint
            && swap_params.destination_mint == pool.token_1_mint
        {
            (
                pool.token_0_vault,
                pool.token_1_vault,
                pool.token_0_program,
                pool.token_1_program,
            )
        } else if swap_params.source_mint == pool.token_1_mint
            && swap_params.destination_mint == pool.token_0_mint
        {
            (
                pool.token_1_vault,
                pool.token_0_vault,
                pool.token_1_program,
                pool.token_0_program,
            )
        } else {
            return Err("mints are not this pool's pair".into());
        };

        // swap_base_input.rs `Swap` accounts, in the program's order.
        let account_metas = vec![
            AccountMeta::new_readonly(swap_params.token_transfer_authority, true), // payer
            AccountMeta::new_readonly(AUTHORITY, false),
            AccountMeta::new_readonly(pool.amm_config, false),
            AccountMeta::new(self.key, false),
            AccountMeta::new(swap_params.source_token_account, false),
            AccountMeta::new(swap_params.destination_token_account, false),
            AccountMeta::new(input_vault, false),
            AccountMeta::new(output_vault, false),
            AccountMeta::new_readonly(input_program, false),
            AccountMeta::new_readonly(output_program, false),
            AccountMeta::new_readonly(swap_params.source_mint, false),
            AccountMeta::new_readonly(swap_params.destination_mint, false),
            AccountMeta::new(pool.observation_key, false),
        ];
        Ok(SwapAndAccountMetas {
            // No direction flag: the program reads the direction from the two vaults.
            swap: Swap::Placeholder { data: None },
            account_metas,
        })
    }

    fn get_accounts_len(&self) -> usize {
        13
    }

    fn is_active(&self) -> bool {
        self.pool.swap_enabled()
    }
}
