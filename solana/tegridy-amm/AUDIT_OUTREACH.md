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
`78f254e`. The delta is about 260 lines across three files: four identity constants (program ID,
admin, pool-creation-fee receiver, support-mint owner), the on-chain `security_txt` block,
one `Cargo.toml` description line, and one added instruction, `create_lp_metadata` (about
150 lines with its comments). That instruction gives a pool's lp token a Metaplex name
record so wallets can show it; it takes no arguments and moves no pool funds (its caller
pays the record's rent and Metaplex's fee, about 0.014 SOL), but it signs a
Metaplex call with the address that also owns the pool vaults, so it wants a careful read.
All swap, curve, fee, deposit, withdraw and oracle logic is byte-identical to upstream. We
think this is a **diff-review**, not a from-scratch AMM audit. Tell us if you disagree.

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

**Both programs have been live on mainnet since 2026-09-29**, at
`EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT` (cp-swap) and
`64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2` (tegridy-launch), and cp-swap holds funded
pools. Neither has been audited. So the audit target is a live program as well as its
source. For cp-swap the two differ by one instruction and by the on-chain security text:
the binary on mainnet was built before `create_lp_metadata` was added. Both reach mainnet
only through one upgrade that the Squads vault signs.

Happy to grant repo read access. What would you quote, and what's your earliest start?

Thanks,
[Name]
[Role], Tegridy Farms
[contact]
