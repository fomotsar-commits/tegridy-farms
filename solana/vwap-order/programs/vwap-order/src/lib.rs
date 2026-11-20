//! vwap-order: a big trade in timed slices, from a per-order escrow, through the venue's pools.
//! NOT AUDITED, NOT DEPLOYED (docs/VWAP_ORDER_PROGRAM.md has the design and the threat list).
//! A slice is one transaction: `begin_slice` lends the runner exactly the slice, the venue's own
//! `swap_base_input` (signed by the runner, so the pool's guard and fee apply as for anyone),
//! then `end_slice` checks the order got its worst price and the pool's average less the band.
//! No admin, no fee, no pause; the owner may always close and take back everything.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_lang::{system_program, Discriminator};
use anchor_spl::token_2022::{approve_checked, close_account, ApproveChecked, CloseAccount};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

pub mod cpswap;
pub mod math;
pub mod token;

// A placeholder, not a key: nobody holds it, so nothing can be deployed at it. The owner makes
// the real id when, and if, this program is to go on chain.
declare_id!("VwapPLACEHo1DERnotDep1oyed11111111111111111");

pub const MAX_SLICES: usize = 96;
/// The shortest window. With MIN_AVERAGE_SECONDS, slices are spread over the day.
pub const MIN_INTERVAL: i64 = 600;
/// The shortest stretch the pool's average is taken over, since the previous slice.
pub const MIN_AVERAGE_SECONDS: u64 = 300;
pub const MAX_BAND_BPS: u16 = 3_000;
pub const MAX_TIP_LAMPORTS: u64 = 1_000_000;

/// Where `end_slice` names the runner and the order (its accounts struct below).
const END_CRANKER: usize = 0;
const END_ORDER: usize = 1;

#[program]
pub mod vwap_order {
    use super::*;

    pub fn open_order(ctx: Context<OpenOrder>, args: OpenArgs) -> Result<()> {
        let n = args.slices as usize;
        require!((1..=MAX_SLICES).contains(&n), OrderError::BadSlices);
        require!(args.interval >= MIN_INTERVAL, OrderError::IntervalTooShort);
        args.interval
            .checked_mul(args.slices as i64)
            .and_then(|span| args.start_at.checked_add(span))
            .ok_or(OrderError::BadTimes)?;
        require!(args.total_in > 0 && args.min_out_total > 0, OrderError::ZeroAmount);
        require!(args.band_bps <= MAX_BAND_BPS, OrderError::BandTooWide);
        require!(args.tip_lamports <= MAX_TIP_LAMPORTS, OrderError::TipTooHigh);
        let mut weights = [0u16; MAX_SLICES];
        if args.weights.is_empty() {
            weights[..n].fill(1);
        } else {
            require!(args.weights.len() == n, OrderError::BadWeights);
            weights[..n].copy_from_slice(&args.weights);
        }
        require!(weights.iter().any(|w| *w > 0), OrderError::BadWeights);

        let a = &ctx.accounts;
        token::assert_mint_admissible(&a.input_mint)?;
        token::assert_mint_admissible(&a.output_mint)?;
        let (input, output) = (a.input_mint.key(), a.output_mint.key());
        require_keys_neq!(input, output, OrderError::SameMint);
        let pool = cpswap::read_pool(&a.pool).ok_or(OrderError::NotOurPool)?;
        let input_is_token_0 = if (pool.token_0_mint, pool.token_1_mint) == (input, output) {
            true
        } else if (pool.token_1_mint, pool.token_0_mint) == (input, output) {
            false
        } else {
            return err!(OrderError::PoolMintsDiffer);
        };
        require_keys_eq!(a.observation.key(), pool.observation, OrderError::NotOurPool);
        let (average_cumulative, average_at) =
            cpswap::read_cumulative(&a.observation, &a.pool.key(), input_is_token_0)
                .filter(|(_, t)| *t > 0)
                .ok_or(OrderError::NoPoolAverage)?;

        let order_key = a.order.key();
        let o = &mut ctx.accounts.order;
        o.set_inner(Order {
            owner: ctx.accounts.owner.key(),
            id: args.id,
            pool: ctx.accounts.pool.key(),
            amm_config: pool.amm_config,
            observation: pool.observation,
            input_mint: input,
            output_mint: output,
            input_is_token_0,
            total_in: args.total_in,
            min_out_total: args.min_out_total,
            start_at: args.start_at,
            interval: args.interval,
            slices: args.slices,
            next_slice: 0,
            slices_filled: 0,
            band_bps: args.band_bps,
            tip_lamports: args.tip_lamports,
            spent_in: 0,
            received_out: 0,
            average_cumulative,
            average_at,
            pending_in: 0,
            pending_slice: 0,
            in_before: 0,
            out_before: 0,
            bump: ctx.bumps.order,
            in_bump: ctx.bumps.in_vault,
            out_bump: ctx.bumps.out_vault,
            weights,
        });

        let a = &ctx.accounts;
        token::transfer(
            a.owner.to_account_info(),
            a.owner_input.to_account_info(),
            a.in_vault.to_account_info(),
            a.input_mint.to_account_info(),
            a.input_token_program.to_account_info(),
            args.total_in,
            a.input_mint.decimals,
            &[],
        )?;
        let tips = args.tip_lamports * args.slices as u64;
        if tips > 0 {
            system_program::transfer(
                CpiContext::new(
                    a.system_program.to_account_info(),
                    system_program::Transfer {
                        from: a.owner.to_account_info(),
                        to: a.order.to_account_info(),
                    },
                ),
                tips,
            )?;
        }
        emit!(OrderOpened {
            order: order_key,
            owner: a.owner.key(),
            pool: a.pool.key(),
            input_mint: input,
            output_mint: output,
            total_in: args.total_in,
            min_out_total: args.min_out_total,
            start_at: args.start_at,
            interval: args.interval,
            slices: args.slices,
            band_bps: args.band_bps,
            tip_lamports: args.tip_lamports,
        });
        Ok(())
    }

    pub fn begin_slice(ctx: Context<BeginSlice>) -> Result<()> {
        require_eq!(get_stack_height(), TRANSACTION_LEVEL_STACK_HEIGHT, OrderError::NotDirect);
        let a = &ctx.accounts;
        let o = &a.order;
        require!(o.pending_in == 0, OrderError::SliceOpen);
        let now = Clock::get()?.unix_timestamp;
        let k = math::window_at(now, o.start_at, o.interval, o.slices).ok_or(OrderError::NoWindow)?;
        require!(k >= o.next_slice, OrderError::SliceDone);
        let amount = math::slice_amount(o.total_in, &o.weights[..o.slices as usize], k as usize);
        require!(amount > 0, OrderError::EmptySlice);
        // The tier's keeper swaps free of the trade fee; a slice always pays it.
        let keeper = cpswap::read_keeper(&a.amm_config).ok_or(OrderError::NotOurPool)?;
        require_keys_neq!(keeper, a.cranker.key(), OrderError::KeeperPaysNoFee);

        let here = load_current_index_checked(&a.instructions)? as usize;
        let swap = load_instruction_at_checked(here + 1, &a.instructions)
            .map_err(|_| error!(OrderError::SwapMissing))?;
        require!(
            swap.program_id == cpswap::ID
                && swap.data.len() == cpswap::SWAP_DATA_LEN
                && swap.data[..8] == cpswap::SWAP_BASE_INPUT,
            OrderError::SwapMissing
        );
        require!(
            swap.data[8..16] == amount.to_le_bytes(),
            OrderError::SwapWrongAmount
        );
        let named = |i: usize| swap.accounts.get(i).map(|m| m.pubkey);
        require!(
            swap.accounts.len() >= cpswap::SWAP_ACCOUNTS
                && named(cpswap::SWAP_PAYER) == Some(a.cranker.key())
                && named(cpswap::SWAP_POOL) == Some(o.pool)
                && named(cpswap::SWAP_INPUT_ACCOUNT) == Some(a.in_vault.key())
                && named(cpswap::SWAP_OUTPUT_ACCOUNT) == Some(a.out_vault.key()),
            OrderError::SwapWrongAccounts
        );
        let end = load_instruction_at_checked(here + 2, &a.instructions)
            .map_err(|_| error!(OrderError::EndMissing))?;
        require!(
            end.program_id == crate::ID
                && end.data.starts_with(instruction::EndSlice::DISCRIMINATOR)
                && end.accounts.get(END_CRANKER).map(|m| m.pubkey) == Some(a.cranker.key())
                && end.accounts.get(END_ORDER).map(|m| m.pubkey) == Some(o.key()),
            OrderError::EndMissing
        );

        let (in_before, out_before) = (a.in_vault.amount, a.out_vault.amount);
        let seeds: &[&[u8]] = &[b"order", o.owner.as_ref(), &o.id.to_le_bytes(), &[o.bump]];
        approve_checked(
            CpiContext::new_with_signer(
                a.input_token_program.to_account_info(),
                ApproveChecked {
                    to: a.in_vault.to_account_info(),
                    mint: a.input_mint.to_account_info(),
                    delegate: a.cranker.to_account_info(),
                    authority: o.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            a.input_mint.decimals,
        )?;
        let o = &mut ctx.accounts.order;
        o.pending_in = amount;
        o.pending_slice = k;
        o.in_before = in_before;
        o.out_before = out_before;
        Ok(())
    }

    pub fn end_slice(ctx: Context<EndSlice>) -> Result<()> {
        require_eq!(get_stack_height(), TRANSACTION_LEVEL_STACK_HEIGHT, OrderError::NotDirect);
        let a = &ctx.accounts;
        let o = &a.order;
        let amount = o.pending_in;
        require!(amount > 0, OrderError::NoSliceOpen);
        require!(
            o.in_before.checked_sub(a.in_vault.amount) == Some(amount)
                && a.in_vault.delegate.is_none(),
            OrderError::SwapWrongAmount
        );
        let got = a
            .out_vault
            .amount
            .checked_sub(o.out_before)
            .ok_or(OrderError::BelowLimit)?;
        let limit = math::limit_floor(o.min_out_total, amount, o.total_in)
            .ok_or(OrderError::MathOverflow)?;
        require_gte!(got, limit, OrderError::BelowLimit);
        let (cumulative, at) = cpswap::read_cumulative(&a.observation, &o.pool, o.input_is_token_0)
            .ok_or(OrderError::NoPoolAverage)?;
        let seconds = at.saturating_sub(o.average_at);
        require_gte!(seconds, MIN_AVERAGE_SECONDS, OrderError::AverageTooShort);
        let average = math::twap_floor(
            amount,
            cumulative.wrapping_sub(o.average_cumulative),
            seconds,
            o.band_bps,
        )
        .ok_or(OrderError::MathOverflow)?;
        require_gte!(got, average, OrderError::BelowAverage);

        let tip = o.tip_lamports;
        let slice = o.pending_slice;
        let o = &mut ctx.accounts.order;
        o.spent_in += amount;
        o.received_out += got;
        o.next_slice = slice + 1;
        o.slices_filled += 1;
        o.average_cumulative = cumulative;
        o.average_at = at;
        o.pending_in = 0;
        o.pending_slice = 0;
        o.in_before = 0;
        o.out_before = 0;

        let order_info = o.to_account_info();
        let cranker_info = ctx.accounts.cranker.to_account_info();
        if tip > 0 {
            **order_info.try_borrow_mut_lamports()? -= tip;
            **cranker_info.try_borrow_mut_lamports()? += tip;
        }
        require_gte!(
            order_info.lamports(),
            Rent::get()?.minimum_balance(order_info.data_len()),
            OrderError::MathOverflow
        );
        emit!(SliceFilled {
            order: order_info.key(),
            slice,
            amount_in: amount,
            amount_out: got,
            cranker: cranker_info.key(),
        });
        Ok(())
    }

    /// Never refused for the order's state: the owner can always take everything back.
    pub fn close_order(ctx: Context<CloseOrder>) -> Result<()> {
        let a = &ctx.accounts;
        let o = &a.order;
        let seeds: &[&[u8]] = &[b"order", o.owner.as_ref(), &o.id.to_le_bytes(), &[o.bump]];
        let returned_in = a.in_vault.amount;
        token::transfer(
            o.to_account_info(),
            a.in_vault.to_account_info(),
            a.owner_input.to_account_info(),
            a.input_mint.to_account_info(),
            a.input_token_program.to_account_info(),
            returned_in,
            a.input_mint.decimals,
            &[seeds],
        )?;
        token::transfer(
            o.to_account_info(),
            a.out_vault.to_account_info(),
            a.owner_output.to_account_info(),
            a.output_mint.to_account_info(),
            a.output_token_program.to_account_info(),
            a.out_vault.amount,
            a.output_mint.decimals,
            &[seeds],
        )?;
        for (vault, program) in [
            (&a.in_vault, &a.input_token_program),
            (&a.out_vault, &a.output_token_program),
        ] {
            close_account(CpiContext::new_with_signer(
                program.to_account_info(),
                CloseAccount {
                    account: vault.to_account_info(),
                    destination: a.owner.to_account_info(),
                    authority: o.to_account_info(),
                },
                &[seeds],
            ))?;
        }
        emit!(OrderClosed {
            order: o.key(),
            spent_in: o.spent_in,
            received_out: o.received_out,
            returned_in,
            slices_filled: o.slices_filled,
        });
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenArgs {
    pub id: u64,
    pub total_in: u64,
    /// The person's worst price: at least this much output for the whole `total_in`.
    pub min_out_total: u64,
    pub start_at: i64,
    pub interval: i64,
    pub slices: u8,
    /// How far below the pool's average price a slice may land, in hundredths of a percent.
    /// It must leave room for the pool's fee and the slice's own price move.
    pub band_bps: u16,
    pub tip_lamports: u64,
    /// One per slice, or none for equal slices. The person's own choice (the site suggests
    /// them from the pair's volume by hour); nobody else can change them.
    pub weights: Vec<u16>,
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub owner: Pubkey,
    pub id: u64,
    pub pool: Pubkey,
    pub amm_config: Pubkey,
    pub observation: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub input_is_token_0: bool,
    pub total_in: u64,
    pub min_out_total: u64,
    pub start_at: i64,
    pub interval: i64,
    pub slices: u8,
    /// Windows before this one are done or passed; a passed window's coins stay in the escrow.
    pub next_slice: u8,
    pub slices_filled: u8,
    pub band_bps: u16,
    pub tip_lamports: u64,
    pub spent_in: u64,
    pub received_out: u64,
    /// The pool's running price total and its second, at the previous slice (or the opening).
    pub average_cumulative: u128,
    pub average_at: u64,
    /// Non-zero only between `begin_slice` and `end_slice`, inside one transaction.
    pub pending_in: u64,
    pub pending_slice: u8,
    pub in_before: u64,
    pub out_before: u64,
    pub bump: u8,
    pub in_bump: u8,
    pub out_bump: u8,
    pub weights: [u16; MAX_SLICES],
}

#[derive(Accounts)]
#[instruction(args: OpenArgs)]
pub struct OpenOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Order::INIT_SPACE,
        seeds = [b"order", owner.key().as_ref(), &args.id.to_le_bytes()],
        bump,
    )]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: cpswap::read_pool checks its owner, size and name.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the pool's own, checked against it in the handler.
    pub observation: UncheckedAccount<'info>,
    #[account(mint::token_program = input_token_program)]
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = output_token_program)]
    pub output_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = input_mint,
        token::authority = owner,
        token::token_program = input_token_program,
    )]
    pub owner_input: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = owner,
        seeds = [b"in", order.key().as_ref()],
        bump,
        token::mint = input_mint,
        token::authority = order,
        token::token_program = input_token_program,
    )]
    pub in_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = owner,
        seeds = [b"out", order.key().as_ref()],
        bump,
        token::mint = output_mint,
        token::authority = order,
        token::token_program = output_token_program,
    )]
    pub out_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub input_token_program: Interface<'info, TokenInterface>,
    pub output_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BeginSlice<'info> {
    pub cranker: Signer<'info>,
    #[account(mut)]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the pool's own tier, by address; cpswap::read_keeper checks its owner and name.
    #[account(address = order.amm_config)]
    pub amm_config: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"in", order.key().as_ref()],
        bump = order.in_bump,
        token::token_program = input_token_program,
    )]
    pub in_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(seeds = [b"out", order.key().as_ref()], bump = order.out_bump)]
    pub out_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = order.input_mint)]
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    pub input_token_program: Interface<'info, TokenInterface>,
    /// CHECK: the instructions sysvar, by address.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct EndSlice<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut)]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the pool's own, by address; cpswap::read_cumulative checks its owner and name.
    #[account(address = order.observation)]
    pub observation: UncheckedAccount<'info>,
    #[account(seeds = [b"in", order.key().as_ref()], bump = order.in_bump)]
    pub in_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(seeds = [b"out", order.key().as_ref()], bump = order.out_bump)]
    pub out_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct CloseOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner, close = owner)]
    pub order: Box<Account<'info, Order>>,
    #[account(
        mut,
        seeds = [b"in", order.key().as_ref()],
        bump = order.in_bump,
        token::token_program = input_token_program,
    )]
    pub in_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"out", order.key().as_ref()],
        bump = order.out_bump,
        token::token_program = output_token_program,
    )]
    pub out_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = order.input_mint)]
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = order.output_mint)]
    pub output_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = input_mint,
        token::authority = owner,
        token::token_program = input_token_program,
    )]
    pub owner_input: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = output_mint,
        token::authority = owner,
        token::token_program = output_token_program,
    )]
    pub owner_output: Box<InterfaceAccount<'info, TokenAccount>>,
    pub input_token_program: Interface<'info, TokenInterface>,
    pub output_token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct OrderOpened {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub total_in: u64,
    pub min_out_total: u64,
    pub start_at: i64,
    pub interval: i64,
    pub slices: u8,
    pub band_bps: u16,
    pub tip_lamports: u64,
}

#[event]
pub struct SliceFilled {
    pub order: Pubkey,
    pub slice: u8,
    pub amount_in: u64,
    pub amount_out: u64,
    pub cranker: Pubkey,
}

#[event]
pub struct OrderClosed {
    pub order: Pubkey,
    pub spent_in: u64,
    pub received_out: u64,
    pub returned_in: u64,
    pub slices_filled: u8,
}

#[error_code]
pub enum OrderError {
    #[msg("between 1 and 96 slices")]
    BadSlices,
    #[msg("a window is at least 10 minutes")]
    IntervalTooShort,
    #[msg("the schedule runs past the end of time")]
    BadTimes,
    #[msg("the amount and the worst price must both be above zero")]
    ZeroAmount,
    #[msg("the band is at most 30%")]
    BandTooWide,
    #[msg("the tip is at most 0.001 SOL a slice")]
    TipTooHigh,
    #[msg("one weight per slice, not all zero")]
    BadWeights,
    #[msg("this coin has a Token-2022 extension the escrow refuses")]
    UnsupportedMint,
    #[msg("the two coins are the same")]
    SameMint,
    #[msg("not a pool of the venue's swap program")]
    NotOurPool,
    #[msg("the pool trades other coins")]
    PoolMintsDiffer,
    #[msg("the pool has no average price yet")]
    NoPoolAverage,
    #[msg("a slice runs only as an instruction of the transaction itself")]
    NotDirect,
    #[msg("a slice is already open")]
    SliceOpen,
    #[msg("no slice's window is open now")]
    NoWindow,
    #[msg("this window's slice has run")]
    SliceDone,
    #[msg("this window's slice is empty")]
    EmptySlice,
    #[msg("the pool's keeper pays no trade fee, so it may not run a slice")]
    KeeperPaysNoFee,
    #[msg("the next instruction must be the venue's swap_base_input")]
    SwapMissing,
    #[msg("the swap must spend exactly this slice")]
    SwapWrongAmount,
    #[msg("the swap must run from this escrow into this order, signed by the runner")]
    SwapWrongAccounts,
    #[msg("the instruction after the swap must be end_slice for this order")]
    EndMissing,
    #[msg("no slice is open")]
    NoSliceOpen,
    #[msg("the pool's average needs 5 minutes since the previous slice")]
    AverageTooShort,
    #[msg("the slice got less than the order's worst price")]
    BelowLimit,
    #[msg("the slice got less than the pool's average price, less the band")]
    BelowAverage,
    #[msg("a number ran out of room")]
    MathOverflow,
}
