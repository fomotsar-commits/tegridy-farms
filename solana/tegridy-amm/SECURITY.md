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

Open a **private security advisory** on this repository
(Security → Advisories → Report a vulnerability). If you cannot, open a normal issue saying
only that you have a security report and asking for a contact — do not put details in a public
issue.

We will acknowledge receipt. We cannot promise a payout, and we would rather say so than imply
one.

## Scope, and what is actually audited

| Component | Provenance | Audited? |
|---|---|---|
| `programs/cp-swap/` | Verbatim fork of [raydium-cp-swap](https://github.com/raydium-io/raydium-cp-swap) @ `78f254e` (Apache-2.0); delta = four authority constants, CI-enforced | **Upstream was audited by MadShield. This fork was not.** The audit is evidence about the code we did not change. |
| `programs/tegridy-launch/` | Novel — written for this repo | **No.** No upstream to compare against. `migrate_to_amm` moves an entire raised balance in one instruction; treat it as the highest-risk surface here. |

Neither program is deployed to Solana mainnet. Neither holds user funds today.

## If you are an auditor

`AUDIT_RFQ.md` describes both scopes. The short version: `cp-swap` is a cheap four-constant
diff against audited upstream; `tegridy-launch` is the real review.
