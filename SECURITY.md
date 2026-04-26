# Security Policy

Tegridy Farms takes the security of its smart contracts, frontend, and user funds seriously. This document describes how to report vulnerabilities, what's in scope, and how we compensate responsible disclosure.

## Reporting a Vulnerability

**Preferred channel:** [security@tegridyfarms.xyz](mailto:security@tegridyfarms.xyz)

PGP key fingerprint available on request. Please encrypt critical findings.

**Bug bounty program status:** A formal bug bounty program is being set up. For now, please email security@tegridyfarms.xyz with disclosures. Researchers who report responsibly during this interim period will receive Hall-of-Fame acknowledgment and priority consideration for rewards once the program is live. There is no public Immunefi page yet — this section will be updated when the program goes live.

**Response SLA:**
- Initial acknowledgement: within 24 hours
- Triage and severity assessment: within 48 hours
- Status updates: at least every 5 business days until resolved
- Patch + payout timeline communicated after triage

Please do NOT open public GitHub issues for security vulnerabilities. Use email.

## Scope

**In scope** — the following deployed mainnet contracts as listed in [CONTRACTS.md](./CONTRACTS.md):

- TegridyToken (ERC-20)
- TegridyLPFarming
- TegridyNFTLending
- TegridyDropV2 (V2 template; V1 `TegridyDrop` source deleted 2026-04-19, live V1 clones remain in scope)
- GaugeController
- Governance / voting contracts
- Any contract address marked "mainnet" in CONTRACTS.md

Frontend code paths that directly handle user funds, signatures, or private keys are also in scope.

## Out of Scope

- **UI / UX bugs** — please open a regular [GitHub issue](https://github.com/tegridyfarms/tegriddy-farms/issues) instead
- **Known issues** — previously disclosed findings documented in [AUDIT_FINDINGS.md](./AUDIT_FINDINGS.md) are not eligible
- **Third-party dependencies** — vulnerabilities in Uniswap V3, Chainlink oracles, OpenZeppelin libraries, or other external protocols should be reported upstream to the respective maintainers
- **Test, mock, deprecated, or testnet contracts** — anything not explicitly listed as mainnet in CONTRACTS.md
- **Theoretical attacks** without a concrete proof-of-concept
- **Gas optimization issues** with no security impact
- **Attacks requiring compromised admin keys** or social engineering of team members
- **Frontend issues** resolved by clearing cache or requiring outdated browsers
- **Self-XSS** or issues requiring physical device access
- **DoS** via excessive gas consumption by the attacker themselves
- **Best-practice recommendations** without an exploitable path

## Bounty Tiers

A formal bug bounty program — including reward tiers, payout currency, and final-severity adjudication — is being prepared and will be published here when live. **Until then, no specific reward amounts are guaranteed.** Researchers who report responsibly during this interim period will be acknowledged in the [Hall of Fame](./HALL_OF_FAME.md) and given priority consideration for rewards once the program launches. Severity classification follows the [Immunefi vulnerability severity classification system](https://immunefi.com/severity-system/) for reference.

## Safe Harbor

Tegridy Farms offers safe harbor to security researchers who act in good faith and follow this policy. Activities conducted in accordance with this policy are considered authorized conduct, and we will not pursue civil or criminal action against researchers who:

1. Make a good-faith effort to avoid privacy violations, data destruction, and interruption or degradation of the service
2. Only test against contracts/systems listed as in-scope
3. Do not exploit vulnerabilities beyond what is necessary to demonstrate the issue
4. Do not exfiltrate user funds beyond a de-minimis proof-of-concept amount, and promptly return any funds moved
5. Report findings promptly and keep details confidential until a fix is deployed
6. Comply with applicable laws

This safe harbor is intended to be Immunefi-compatible once the program is live. Once Tegridy Farms publishes an Immunefi page, any conflict between this policy and Immunefi's standard terms while reporting via that platform will be resolved in favor of Immunefi's terms.

If legal action is initiated by a third party against a researcher following this policy, we will take reasonable steps to make it known the activity was authorized.

## Do's

- Do report vulnerabilities privately via the channels above
- Do include clear reproduction steps and, where possible, a Foundry or Hardhat PoC
- Do provide your wallet address for reward payment
- Do give us reasonable time (typically 30–90 days) to deploy fixes before public disclosure
- Do coordinate disclosure timing with the security team
- Do test against local forks of mainnet whenever possible

## Don'ts

- Don't exploit vulnerabilities beyond demonstration
- Don't access, modify, or destroy data belonging to other users
- Don't perform testing on mainnet in ways that put user funds at risk
- Don't disclose findings publicly (Twitter, Discord, blog) before a coordinated fix
- Don't attempt social engineering of team members, validators, or infrastructure providers
- Don't conduct phishing, DDoS, or physical attacks against Tegridy Farms or its users
- Don't demand payment or threaten public disclosure as leverage (this voids safe harbor)
- Don't submit duplicates of issues already reported or disclosed

## Acknowledgements

We maintain a [Hall of Fame](./HALL_OF_FAME.md) for researchers who have contributed to securing the protocol. With your permission, we'd be glad to add your handle.

## Operational runbooks

- [`docs/SECRET_ROTATION.md`](./docs/SECRET_ROTATION.md) — how to rotate any API key, JWT secret, or service credential; documents actual leak surface per key so you can triage urgency correctly.
- [`docs/WAVE_0_RUNBOOK.md`](./docs/WAVE_0_RUNBOOK.md) — contract redeploy + ownership transfer procedure.
- [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) — end-to-end deploy flow.

---

Last updated: 2026-04-25
