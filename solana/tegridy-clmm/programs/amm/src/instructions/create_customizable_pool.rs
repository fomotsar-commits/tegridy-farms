use crate::states::*;
use anchor_lang::prelude::*;

// memetics.finance: the create_customizable_pool instruction is deleted (2026-11-03 audit,
// CL-03/DG-02): whoever opened a pair first fixed that pool's fee coin and dynamic fee for good.
// Only its parameters stay, for create_permissioned_pool, which needs the vault's permission.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateCustomizableParams {
    pub sqrt_price_x64: u128,
    pub collect_fee_on: CollectFeeOn,
    pub enable_dynamic_fee: bool,
}
