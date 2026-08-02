# Audit outreach — ready to send

Send one per firm. Fill the `[bracketed]` fields. Attach or link `AUDIT_RFQ.md`.

Recommended (Solana): **OtterSec · Neodyme · Sec3 · Zellic**.

---

**Subject:** Quote request — two Solana programs, priced separately (CPMM fork diff-review + ~1.2k nSLOC novel bonding curve)

Hi [Firm],

We're looking for a quote on two Solana programs. They're very different jobs and we'd
like them **priced separately** — quoting them as one number would almost certainly get
the split wrong.

**Scope A — `cp-swap`.** A fork of Raydium's `raydium-cp-swap` at pinned upstream commit
`78f254e`. The delta is 86 lines across three files: four identity constants (program ID,
admin, pool-creation-fee receiver, support-mint owner), the on-chain `security_txt` block,
and one `Cargo.toml` description line. All swap, curve, fee, deposit, withdraw and oracle
logic is byte-identical to upstream. We think this is a **diff-review**, not a from-scratch
AMM audit — tell us if you disagree.

**Scope B — `tegridy-launch`.** ~1,170 production nSLOC of novel Anchor code with no
upstream to diff against: a bonding curve over virtual reserves, and a `migrate_to_amm`
instruction that moves an entire launch's raised balance into a cp-swap pool in one
transaction across ~20 accounts, burning the LP. This is where the risk is and where we'd
want the hours.

To calibrate effort, these already exist and are described in the RFQ:

- a CI job that canonicalises the upstream delta and compares it against a pinned SHA-256,
  so the Scope A claim above is mechanically enforced rather than asserted;
- a runtime rehearsal on a local validator — create → buy → sell → migrate — run
  adversarially (it squats the canonical pool PDA and dust-donates to the migration ATA
  before migrating);
- a prior internal adversarial review. Its findings are already fixed and are **listed in
  the RFQ** so you don't spend time rediscovering them.

**Neither program is deployed to any cluster and neither holds any funds today.** A
mainnet deploy is gated on this audit, so your timeline is our timeline.

Happy to grant repo read access. What would you quote, and what's your earliest start?

Thanks,
[Name]
[Role], Tegridy Farms
[contact]
