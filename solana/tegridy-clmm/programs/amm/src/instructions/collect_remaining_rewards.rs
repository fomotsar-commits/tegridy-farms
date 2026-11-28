use crate::error::ErrorCode;
use crate::states::*;
use crate::util::transfer_from_pool_vault_to_user;
use anchor_lang::prelude::*;
use anchor_spl::{
    memo::Memo,
    token::{self, Token},
    token_interface::{Mint, Token2022, TokenAccount},
};

/// Memo msg for collect remaining
// Changed by memetics.finance (tegridy-clmm): the venue's name in the memo.
pub const COLLECT_REMAINING_MEMO_MSG: &'static [u8] = b"memetics_collect_remaining";

#[derive(Accounts)]
pub struct CollectRemainingRewards<'info> {
    /// The founder who init reward info previously
    pub reward_funder: Signer<'info>,
    /// The funder's reward token account
    // memetics.finance: never one of the pool's own vaults, where the rest would become the LPs'
    // (2026-11-15 audit, RNG-09).
    #[account(
        mut,
        constraint = funder_token_account.key() != pool_state.load()?.token_vault_0
            && funder_token_account.key() != pool_state.load()?.token_vault_1 @ ErrorCode::NotApproved
    )]
    pub funder_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Set reward for this pool
    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,
    /// Reward vault transfer remaining token to founder token account
    #[account(mut)]
    pub reward_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The mint of reward token vault
    #[account(
        address = reward_token_vault.mint
    )]
    pub reward_vault_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = token::ID)]
    pub token_program: Program<'info, Token>,
    /// Token program 2022
    pub token_program_2022: Program<'info, Token2022>,

    /// memo program
    pub memo_program: Program<'info, Memo>,
}

pub fn collect_remaining_rewards(
    ctx: Context<CollectRemainingRewards>,
    reward_index: u8,
) -> Result<()> {
    // invoke_memo_instruction(
    //     COLLECT_REMAINING_MEMO_MSG,
    //     ctx.accounts.memo_program.to_account_info(),
    // )?;
    let amount_remaining = get_remaining_reward_amount(
        &ctx.accounts.pool_state,
        &ctx.accounts.reward_token_vault,
        &ctx.accounts.reward_funder.key(),
        reward_index,
    )?;

    transfer_from_pool_vault_to_user(
        &ctx.accounts.pool_state,
        &ctx.accounts.reward_token_vault.to_account_info(),
        &ctx.accounts.funder_token_account.to_account_info(),
        Some(ctx.accounts.reward_vault_mint.clone()),
        &ctx.accounts.token_program,
        Some(ctx.accounts.token_program_2022.to_account_info()),
        amount_remaining,
    )?;

    Ok(())
}

fn get_remaining_reward_amount(
    pool_state_loader: &AccountLoader<PoolState>,
    reward_token_vault: &InterfaceAccount<TokenAccount>,
    reward_funder: &Pubkey,
    reward_index: u8,
) -> Result<u64> {
    let current_timestamp =
        u64::try_from(Clock::get()?.unix_timestamp).map_err(|_| ErrorCode::CalculateOverflow)?;
    let mut pool_state = pool_state_loader.load_mut()?;
    pool_state.update_reward_infos(current_timestamp)?;

    let reward_info = pool_state.reward_infos[reward_index as usize];
    if !reward_info.initialized() {
        return err!(ErrorCode::UnInitializedRewardInfo);
    }
    require_eq!(
        reward_info.last_update_time,
        reward_info.end_time,
        ErrorCode::NotApproved
    );
    require_keys_eq!(reward_funder.key(), reward_info.authority);
    require_keys_eq!(reward_token_vault.key(), reward_info.token_vault);

    let unclaimed_reward = reward_info
        .reward_total_emitted
        .checked_sub(reward_info.reward_claimed)
        .ok_or(ErrorCode::CalculateOverflow)?;
    let amount_remaining = reward_token_vault
        .amount
        .checked_sub(unclaimed_reward)
        .ok_or(ErrorCode::CalculateOverflow)?;

    Ok(amount_remaining)
}

/// memetics.finance (2026-11-15 audit, RNG-09): nothing the vault or the island collects is
/// paid into the pool's own vaults, where it would become the LPs'. The fee collections list
/// both vaults as mutable token accounts, so Anchor refuses either as a receiver too.
#[cfg(test)]
mod no_payout_into_the_pools_vaults_test {
    use super::*;
    use crate::instructions::admin::{
        CollectFundFee, CollectFundFeeBumps, CollectProtocolFee, CollectProtocolFeeBumps,
    };
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_lang::{system_program, Discriminator};
    use anchor_spl::token_2022::spl_token_2022::state::{
        Account as SplAccount, AccountState, Mint as SplMint,
    };
    use std::collections::BTreeSet;

    fn info(key: Pubkey, owner: Pubkey, data: Vec<u8>, signer: bool, exec: bool) -> AccountInfo<'static> {
        AccountInfo::new(
            Box::leak(Box::new(key)),
            signer,
            true,
            Box::leak(Box::new(1_000_000_000u64)),
            Box::leak(data.into_boxed_slice()),
            Box::leak(Box::new(owner)),
            exec,
        )
    }

    fn mint(key: Pubkey) -> AccountInfo<'static> {
        let mut data = vec![0u8; SplMint::LEN];
        SplMint { decimals: 6, is_initialized: true, ..Default::default() }.pack_into_slice(&mut data);
        info(key, Token::id(), data, false, false)
    }

    fn token_account(key: Pubkey, mint: Pubkey) -> AccountInfo<'static> {
        let mut data = vec![0u8; SplAccount::LEN];
        SplAccount { mint, owner: Pubkey::new_unique(), state: AccountState::Initialized, ..Default::default() }
            .pack_into_slice(&mut data);
        info(key, Token::id(), data, false, false)
    }

    fn program(key: Pubkey) -> AccountInfo<'static> {
        info(key, Pubkey::default(), vec![], false, true)
    }

    struct Pool {
        key: Pubkey,
        config: Pubkey,
        mints: [Pubkey; 2],
        vaults: [Pubkey; 2],
        fund_owner: Pubkey,
    }

    impl Pool {
        fn new() -> Self {
            let k = Pubkey::new_unique;
            Pool { key: k(), config: k(), mints: [k(), k()], vaults: [k(), k()], fund_owner: k() }
        }

        fn state(&self) -> AccountInfo<'static> {
            let mut pool = PoolState::default();
            pool.amm_config = self.config;
            pool.token_mint_0 = self.mints[0];
            pool.token_mint_1 = self.mints[1];
            pool.token_vault_0 = self.vaults[0];
            pool.token_vault_1 = self.vaults[1];
            let mut data = PoolState::DISCRIMINATOR.to_vec();
            data.extend_from_slice(bytemuck::bytes_of(&pool));
            info(self.key, crate::ID, data, false, false)
        }

        /// The eleven accounts of either fee collection, in order, paying to `to`.
        fn fee_collection(&self, signer: Pubkey, to: [Pubkey; 2]) -> &'static [AccountInfo<'static>] {
            let mut config = AmmConfig::DISCRIMINATOR.to_vec();
            AmmConfig { owner: crate::admin::ID, fund_owner: self.fund_owner, ..Default::default() }
                .serialize(&mut config)
                .unwrap();
            Box::leak(
                vec![
                    info(signer, system_program::ID, vec![], true, false),
                    self.state(),
                    info(self.config, crate::ID, config, false, false),
                    token_account(self.vaults[0], self.mints[0]),
                    token_account(self.vaults[1], self.mints[1]),
                    mint(self.mints[0]),
                    mint(self.mints[1]),
                    token_account(to[0], self.mints[0]),
                    token_account(to[1], self.mints[1]),
                    program(Token::id()),
                    program(Token2022::id()),
                ]
                .into_boxed_slice(),
            )
        }

        /// The vault takes back the unpaid rest of a reward paid in the pool's coin 0, to `to`.
        fn remaining_rewards(&self, to: Pubkey) -> &'static [AccountInfo<'static>] {
            Box::leak(
                vec![
                    info(crate::admin::ID, system_program::ID, vec![], true, false),
                    token_account(to, self.mints[0]),
                    self.state(),
                    token_account(Pubkey::new_unique(), self.mints[0]),
                    mint(self.mints[0]),
                    program(Token::id()),
                    program(Token2022::id()),
                    program(Memo::id()),
                ]
                .into_boxed_slice(),
            )
        }
    }

    fn protocol(mut a: &'static [AccountInfo<'static>]) -> Result<()> {
        CollectProtocolFee::try_accounts(&crate::ID, &mut a, &[], &mut CollectProtocolFeeBumps::default(), &mut BTreeSet::new()).map(|_| ())
    }

    fn fund(mut a: &'static [AccountInfo<'static>]) -> Result<()> {
        CollectFundFee::try_accounts(&crate::ID, &mut a, &[], &mut CollectFundFeeBumps::default(), &mut BTreeSet::new()).map(|_| ())
    }

    fn rest(mut a: &'static [AccountInfo<'static>]) -> Result<()> {
        CollectRemainingRewards::try_accounts(&crate::ID, &mut a, &[], &mut CollectRemainingRewardsBumps::default(), &mut BTreeSet::new()).map(|_| ())
    }

    #[test]
    fn a_reward_rest_is_not_paid_into_the_pools_vaults_test() {
        let p = Pool::new();
        assert!(rest(p.remaining_rewards(Pubkey::new_unique())).is_ok());
        for vault in p.vaults {
            assert_eq!(rest(p.remaining_rewards(vault)).unwrap_err(), ErrorCode::NotApproved.into());
        }
    }

    #[test]
    fn a_fee_collection_is_not_paid_into_the_pools_vaults_test() {
        let p = Pool::new();
        let elsewhere = [Pubkey::new_unique(), Pubkey::new_unique()];
        assert!(protocol(p.fee_collection(crate::admin::ID, elsewhere)).is_ok());
        assert!(fund(p.fee_collection(p.fund_owner, elsewhere)).is_ok());
        let [v0, v1] = p.vaults;
        for to in [[v0, elsewhere[1]], [v1, elsewhere[1]], [elsewhere[0], v0], [elsewhere[0], v1]] {
            let refused = anchor_lang::error::ErrorCode::ConstraintDuplicateMutableAccount.into();
            assert_eq!(protocol(p.fee_collection(crate::admin::ID, to)).unwrap_err(), refused);
            assert_eq!(fund(p.fee_collection(p.fund_owner, to)).unwrap_err(), refused);
        }
    }
}
