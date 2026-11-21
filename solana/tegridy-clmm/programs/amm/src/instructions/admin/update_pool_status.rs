use crate::states::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdatePoolStatus<'info> {
    #[account(
        address = crate::admin::ID
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,
}

pub fn update_pool_status(ctx: Context<UpdatePoolStatus>, status: u8) -> Result<()> {
    // memetics.finance: only the six bits PoolStatusBitIndex names, so 63 at most (2026-11-15
    // audit, RNG-07). The byte is still written whole.
    require_gte!(63, status);
    let mut pool_state = ctx.accounts.pool_state.load_mut()?;
    pool_state.set_status(status);
    Ok(())
}

#[cfg(test)]
mod pool_status_test {
    use super::*;
    use anchor_lang::{system_program, Discriminator};

    fn info(key: Pubkey, owner: Pubkey, data: Vec<u8>, signer: bool) -> &'static AccountInfo<'static> {
        Box::leak(Box::new(AccountInfo::new(
            Box::leak(Box::new(key)),
            signer,
            true,
            Box::leak(Box::new(1_000_000_000u64)),
            Box::leak(data.into_boxed_slice()),
            Box::leak(Box::new(owner)),
            false,
        )))
    }

    /// The vault writes `status` on a pool; returns the result and the byte the pool holds after.
    fn write(status: u8) -> (Result<()>, u8) {
        let mut data = PoolState::DISCRIMINATOR.to_vec();
        data.extend_from_slice(bytemuck::bytes_of(&PoolState::default()));
        let pool = AccountLoader::<PoolState>::try_from(info(Pubkey::new_unique(), crate::ID, data, false)).unwrap();
        let accounts = Box::leak(Box::new(UpdatePoolStatus {
            authority: Signer::try_from(info(crate::admin::ID, system_program::ID, vec![], true)).unwrap(),
            pool_state: pool.clone(),
        }));
        let result = update_pool_status(
            Context::new(&crate::ID, accounts, &[], UpdatePoolStatusBumps::default()),
            status,
        );
        let held = pool.load().unwrap().status;
        (result, held)
    }

    /// memetics.finance (2026-11-15 audit, RNG-07): bits 64 and 128 name nothing, so a status
    /// that sets either is refused and the pool keeps its byte; 32 and 48 are written whole.
    #[test]
    fn only_known_status_bits_are_written_test() {
        for unknown in [64, 96, 128, 255] {
            let (result, held) = write(unknown);
            assert_eq!(result.unwrap_err(), anchor_lang::error::ErrorCode::RequireGteViolated.into());
            assert_eq!(held, 0);
        }
        for known in [32, 48, 63] {
            let (result, held) = write(known);
            assert!(result.is_ok());
            assert_eq!(held, known);
        }
    }
}
