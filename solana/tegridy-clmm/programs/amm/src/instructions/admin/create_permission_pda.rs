use anchor_lang::prelude::*;

// Changed by memetics.finance (tegridy-clmm): the venue's keys replace upstream's here. The
// instruction is deleted with create_permissioned_pool, the one instruction that read a permission
// (the owner's ruling, 2026-11-03). Only this key stays, read by nothing, so a mainnet build still
// holds the eight vault keys solana/clmm-deploy/stage.mjs counts.
pub mod permission_pda_admin {
    use super::{pubkey, Pubkey};
    #[cfg(feature = "devnet")]
    pub const ID: Pubkey = pubkey!("GgE6AfEH2AVSrKGckyKMzC6mhtXWiAn39EzAikAsWq5a");
    #[cfg(not(feature = "devnet"))]
    pub const ID: Pubkey = pubkey!("GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd");
}
