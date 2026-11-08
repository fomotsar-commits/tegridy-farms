// memetics.finance: close_permission_pda is deleted with create_permissioned_pool, the one
// instruction that read a permission (the owner's ruling, 2026-11-03). Nothing builds this file
// (instructions/admin/mod.rs no longer names it); the deleted text is in
// solana/guards/upstream/tegridy-clmm.diff.
