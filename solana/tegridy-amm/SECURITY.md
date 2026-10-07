# Security policy — Tegridy CP-AMM & tegridy-launch

## There is no bug bounty for this repository

We do not currently run one, and **no third party's bounty covers this code.**

A previous revision of this file was Raydium's `SECURITY.md`, inherited verbatim when
`programs/cp-swap/` was forked. It advertised rewards of up to USD 505,000 and routed
disclosure to Raydium's security address. **None of that applied to this repository.** GitHub
surfaces this file as the repo's security policy, so a researcher who found a real bug in our
code would have reported it to a company with no ability to fix it, expecting a payout nobody
had offered. That was our error, and it is corrected here.

## Reporting a vulnerability

Email the `Contact:` address in <https://memetics.finance/.well-known/security.txt>
(today: fomotsar@gmail.com; if the two ever differ, the file wins). That address stays put when
the code moves between git hosts. Report privately, before any public disclosure or on-chain
exploitation.

If email fails, open an issue through <https://memetics.finance/source-issues> that says only
that you have a security report and asks for a contact. That link goes to GitHub today, where
every issue is public, so never put details in it. If it goes to GitLab, you can mark the
issue confidential when you create it.

For an exploit in progress, contact SEAL 911 in parallel:
<https://securityalliance.org/our-work/seal-911>.

We will acknowledge receipt. We cannot promise a payout, and we would rather say so than imply
one.

## Scope, and what is actually audited

| Component | Provenance | Audited? |
|---|---|---|
| `programs/cp-swap/` | Fork of [raydium-cp-swap](https://github.com/raydium-io/raydium-cp-swap) @ `78f254e` (Apache-2.0); delta = four authority constants plus one added instruction, `create_lp_metadata` (it names a pool's lp token; in source since 2026-10-06, not in the mainnet binary until the program is upgraded), CI-enforced | **Upstream was audited by MadShield. This fork was not.** The audit is evidence about the code we did not change. It says nothing about the added instruction. |
| `programs/tegridy-launch/` | Novel — written for this repo | **No.** No upstream to compare against. `migrate_to_amm` moves an entire raised balance in one instruction; treat it as the highest-risk surface here. |

Both programs have been on Solana mainnet since 2026-09-29: `cp-swap` at
`EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT` and `tegridy-launch` at
`64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2`.

## If you are an auditor

`AUDIT_RFQ.md` describes both scopes. The short version: `cp-swap` is a cheap diff against
audited upstream (four constants and one small added instruction, `create_lp_metadata`);
`tegridy-launch` is the real review.
