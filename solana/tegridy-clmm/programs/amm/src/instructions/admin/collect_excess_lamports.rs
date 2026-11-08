// memetics.finance: collect_excess_lamports is deleted (2026-11-03 audit, CD-2). It let the vault
// trim the refundable rent deposits on users' positions and orders. Nothing builds this file
// (instructions/admin/mod.rs no longer names it); the deleted text is in
// solana/guards/upstream/tegridy-clmm.diff.
