//! TEST ONLY: a program that calls another program, the way an arbitrage bot's own program
//! calls a pool's swap from inside it (a cross-program invocation). The first account is the
//! program to call; every account after it is handed on as it came (signer and writable flags
//! kept), and so is the instruction data. tests/cp-swap-swap-guard.test.ts uses it to reach
//! cp-swap's swap at stack height 2, which the swap guard refuses (states/config.rs).
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process);

fn process(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (target, rest) = accounts.split_first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    let instruction = Instruction {
        program_id: *target.key,
        accounts: rest
            .iter()
            .map(|a| AccountMeta { pubkey: *a.key, is_signer: a.is_signer, is_writable: a.is_writable })
            .collect(),
        data: data.to_vec(),
    };
    invoke(&instruction, accounts)
}
