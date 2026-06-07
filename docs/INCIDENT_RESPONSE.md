# Incident Response Runbook

What to do when something goes wrong on a live Tegridy Farms contract.

This is the operational counterpart to [SECURITY.md](../SECURITY.md) (which covers *disclosure*) and [GOVERNANCE.md](./GOVERNANCE.md) (which covers *normal* admin actions). Both of those assume time to think. This document assumes a clock is running.

> **If this is a live exploit and you are reading this for the first time:** jump to [§5 First 15 minutes](#5-first-15-minutes). Read the rest after.

---

## 0. Principles

1. **Pause first, diagnose second.** The fastest hands beat the smartest hands when funds are moving. A wrongful pause is a recoverable mistake; a wrongful 5-minute delay is not. PauseGuardian exists precisely so the multisig timelock isn't on the critical path.
2. **Be honest in comms.** Every DeFi incident becomes public within hours. The team that drafts the post-mortem on its own terms shapes the narrative; the team that gets caught silent gets the worst version of it written for them. Acknowledge facts as they're known; refuse to speculate.
3. **One Incident Commander.** During an active incident, *one* person makes operational decisions and *one* channel carries authoritative comms. Everyone else feeds intel; nobody else broadcasts.
4. **Assume the indexer is wrong.** During an incident, on-chain state is ground truth — every off-chain dashboard (Ponder, Dune, GeckoTerminal, frontend stats) is potentially stale or actively misleading. Read directly via `cast` / Etherscan.

---

## 1. Severity tiers

| Tier | Definition | Response time | Default action |
|---|---|---|---|
| **SEV-0** | Active drain of user funds; on-chain exploit in progress | < 5 min to pause | Pause-all, then investigate |
| **SEV-1** | Confirmed vulnerability that can be exploited but hasn't been; loss of admin control imminent; oracle compromise; sequencer failure (L2) | < 30 min to pause | Pause affected contracts; war-room comms |
| **SEV-2** | Indexer / RPC outage, frontend bug exposing wrong balances, expired Chainlink feed, stuck transaction with no funds at risk | < 4 hours | No pause; fix forward; post-mortem |
| **SEV-3** | Single-user UX bug, slow page, cosmetic issue | Best effort | Normal triage |

**When unsure, treat as one tier higher.** A pause that turns out unwarranted costs hours of inconvenience; an under-pause costs the protocol's reputation permanently.

### Examples (non-exhaustive)

- *Drainer transaction observed against `TegridyLending`* → SEV-0 → pause `TegridyLending` immediately.
- *Sequencer-down on Arbitrum, oracle stale beyond `SEQUENCER_GRACE_PERIOD`* → SEV-1 → pause swap & lending; user funds at risk if pricing wrong.
- *Compromised owner EOA detected (transferOwnership pending to attacker address)* → SEV-1 → pause-all + multisig cancels via `acceptOwnership` flush pattern (see [SwapFeeRouter.sol:2284-2303](../contracts/src/SwapFeeRouter.sol#L2284-L2303)).
- *POLAccumulator drift > 5%* → SEV-2 → investigate before pause; could be benign donation skew or front-running of `distributeFeesToStakers`.
- *Indexer 2 hours behind* → SEV-2 → frontend stats stale, no fund risk; restart Ponder, post status update.

---

## 2. Roles

These are roles, not necessarily people. One person may wear multiple hats; SEV-0/1 should aim for distinct holders.

| Role | Responsibility | Default holder |
|---|---|---|
| **Incident Commander (IC)** | Sole decision-maker on pause / unpause / multisig actions. Drives the incident to resolution. | On-call signer |
| **Comms Lead** | Drafts and posts every public message. No tweets outside this channel during incident. | Founder / community lead |
| **Scribe** | Captures timestamped events in a private channel (Discord war-room or shared doc). Source of truth for post-mortem. | Anyone not IC or Comms |
| **Researcher** | Reads on-chain state, reproduces the exploit in a fork, drafts the patch. | Whoever knows the affected contract best |
| **Multisig signers** | On notice from minute 0. Must be reachable within 30 minutes for SEV-0/1. | Safe signer set |

---

## 3. Pause toolkit

Every user-fund-holding contract inherits two pause surfaces:

- **`pause()`** — only `owner` (multisig). Subject to no timelock, but requires multisig coordination (slow).
- **`pause()` via PauseGuardian** — only `pauseGuardian` address. No timelock, no multisig coordination. **This is the fast path.**

### Pauseable contracts

| Contract | Function | Caller |
|---|---|---|
| `TegridyStaking` | `pause()` / `unpause()` | owner OR `pauseGuardian` |
| `TegridyRestaking` | `pause()` / `unpause()` | owner OR `pauseGuardian` |
| `SwapFeeRouter` | `pause()` / `unpause()` | owner OR `pauseGuardian` |
| `RevenueDistributor` | `pause()` / `unpause()` | owner OR `pauseGuardian` |
| `POLAccumulator` | `pause()` / `unpause()` | owner OR `pauseGuardian` |
| `TegridyLPFarming` | `pause()` / `unpause()` | owner only |
| `TegridyLending` | `pause()` / `unpause()` | owner only |
| `TegridyNFTLending` | `pause()` / `unpause()` | owner only |
| `GaugeController` | `pause()` / `unpause()` | owner only |
| `TegridyLaunchpadV2` | `pause()` / `unpause()` | owner only |

**Implication:** in a SEV-0 against a non-PauseGuardian-equipped contract, you must convene the multisig. Plan accordingly — see [§7 Drill schedule](#7-drill-schedule).

### Pause-all (cast)

```bash
# Set up once (export shell vars for the incident).
export RPC=$ETH_RPC_URL                  # mainnet RPC
export PG=$PAUSE_GUARDIAN_PRIVATE_KEY    # hot key for the pauseGuardian role

# PauseGuardian-equipped contracts (no multisig needed):
for addr in \
  $TEGRIDY_STAKING_ADDRESS \
  $TEGRIDY_RESTAKING_ADDRESS \
  $SWAP_FEE_ROUTER_ADDRESS \
  $REVENUE_DISTRIBUTOR_ADDRESS \
  $POL_ACCUMULATOR_ADDRESS; do
  cast send $addr "pause()" --rpc-url $RPC --private-key $PG
done
```

Multisig-only contracts go via Safe Transaction Builder — see [`scripts/safe-pause-all.json`](../scripts/safe-pause-all.json) (generate this from the multisig migration, not yet committed at time of writing).

### What pause does NOT block

- **`emergencyWithdraw()`** on TegridyStaking — by design. Users can always rescue principal even when staking is paused. This is non-negotiable.
- **View calls** — Etherscan reads keep working. Frontend "your position" still loads.
- **Pending timelock executions** — already-queued timelocked proposals can still be executed by the multisig. If a proposal is part of the attack surface, the multisig must `cancel*` it explicitly.

### Unpause discipline

Do **not** unpause until:

1. The root cause is identified (not just symptoms).
2. The patch is deployed + tested on a fork.
3. The patched contracts are wired in (timelock proposals queued + multisig accepts).
4. A public post-mortem draft is reviewed by the IC.

Unpausing too early to "look responsive" is the #1 cause of two-stage exploits.

---

## 4. Detection sources

The order roughly mirrors latency, fastest first.

1. **Tenderly Alerts** (to be configured) — function-level threshold alerts on treasury moves > 5 ETH, ownership transfers, large `withdraw*` flows. Routes to Telegram + email.
2. **OpenZeppelin Defender Sentinel** (to be configured) — pause-state changes, `acceptOwnership` events, oracle staleness.
3. **Dune Dashboard** (to be configured) — TVL anomaly cards, hourly resync.
4. **Indexer health endpoint** — `/health` on the Ponder instance; if response > 5s or block lag > 10, page on-call.
5. **Direct user reports** — Twitter mentions, Discord #report-bug, the team via our community channels. Treat *every* report as potentially valid until proven otherwise.
6. **External monitors** — DeFiLlama TVL drop, Etherscan label changes, Chainalysis tags. Slower but high-signal when they fire.

Until Tenderly / Defender / Dune are live, the team is operating with detection sources 4–6 only. **This is itself a SEV-2-class operational gap** — see the open work in [NEXT_SESSION.md](../NEXT_SESSION.md) § Observability.

---

## 5. First 15 minutes

When a SEV-0/1 fires, do these in order. Do not skip.

### T+0:00 — Confirm

- **Verify on-chain.** Open Etherscan on the suspected contract. Look at the last 20 txs. Is the exploit real, or is it a frontend / indexer artifact?
- **Identify the affected contract(s).** Single contract or systemic?

### T+0:02 — Pause

- If PauseGuardian-equipped: run the pause-all cast block from [§3](#3-pause-toolkit). One-shot.
- If multisig-only: post in #signers-emergency with the Safe tx URL; phone-call the on-duty signer.
- Confirm pause via `cast call <contract> "paused()(bool)"` — DO NOT trust the Etherscan UI cache.

### T+0:05 — Declare

- Drop a single sentence in #war-room: *"SEV-0 declared on TegridyLending. IC: @alice. Comms: @bob. Scribe: @carol. Stand by."*
- Comms posts a one-line public acknowledgement on Twitter/X. **No speculation about cause, no ETA, no numbers.** Template:

  > We're investigating a possible incident affecting [contract name]. The contract has been paused as a precaution. We'll share concrete details within the hour. User funds [are / are not] at risk — we'll confirm shortly.

### T+0:10 — Scope

- Researcher pulls the suspicious txs into a `forge test` fork harness. Reproduces or rules out.
- Scribe starts the timestamped event log.
- IC decides if scope expands (other contracts that share the pattern).

### T+0:15 — Check-in

- IC posts a war-room update with: what's confirmed, what's still unknown, next 15-min plan.
- Comms holds — don't post again until there's new factual content.

---

## 6. Communication templates

All public comms go through Comms Lead. Drafts are reviewed by IC before sending. Never copy-paste from Discord into Twitter — re-read every line as if a regulator is reading it.

### 6a. Initial acknowledgement (within 15 min of pause)

> We're investigating a possible incident on the [Contract Name] contract at [0x…]. As a precaution, the contract is paused; deposits and withdrawals via this contract are temporarily unavailable. We will share a substantive update within 60 minutes. If you've been affected, please contact the team via our community channels.

### 6b. 60-minute update

> Update on [contract]: we've confirmed [factual one-line description, no jargon]. Affected users: [number or "we are still confirming the scope"]. Estimated impact: [ETH amount or "TBD"]. Next steps: [pause stays / patch in development / multisig is acting]. Next update: [time].

**Never include in this template:**
- "We're 99% sure it's…" — only confirmed facts
- "It's not as bad as people are saying" — defensive framing reads as dishonest
- "Funds are safe" unless you have just verified on-chain that they are

### 6c. Resolution

> The [contract] incident is resolved. Root cause: [one paragraph, technically accurate]. Funds affected: [exact number]. Remediation: [patched + redeployed at 0x… / users refunded via 0x… / no funds lost]. A full post-mortem will be published within 5 business days at [link].

### 6d. Post-mortem (within 5 business days)

Use the template at [§8](#8-post-mortem-template) below.

---

## 7. Drill schedule

A runbook that's never been exercised will fail when it's needed.

- **Quarterly tabletop** — 1-hour, no on-chain action. IC walks the team through a scenario; Scribe times each step against the SLA. Failures get assigned an owner + fix.
- **Bi-annual live drill** — testnet pause / unpause / multisig sign + execute, end-to-end. Validates that signers' keys still work, Telegram channels reach humans, Tenderly alerts route correctly.
- **Post-deploy smoke** — within 24h of every mainnet deploy, run a SEV-1 tabletop scoped to the new contract.

Track drill results in `docs/drills/YYYY-MM-DD.md`. Anything that took >2× the SLA is an action item.

---

## 8. Post-mortem template

```markdown
# Post-mortem: [incident title]

**Date:** YYYY-MM-DD
**Severity:** SEV-X
**Duration:** [pause time → resolution time]
**Funds affected:** [exact wei + USD at time of incident]
**Author:** [IC]

## Summary
One paragraph, plain English. What happened, what we did, what the user impact was.

## Timeline (UTC)
- HH:MM — [event]
- HH:MM — [event]
- …

## Root cause
Technical analysis. Reference the exact contract line numbers + tx hashes.

## Detection
How did we find out? How long after the first malicious tx? What detection source caught it?

## Response
What we did, in chronological order. Where we delayed and why.

## What went well
Honest. Not flattery.

## What went poorly
Honest. Specific. Avoid "we should have been more careful" — name the failure mode.

## Action items
| # | Item | Owner | Due |
|---|------|-------|-----|

## Appendix
- Affected tx hashes
- Patched contracts (old → new addresses)
- Refund tx (if any)
```

---

## 9. Contact tree

Update this file each time signer composition or contact details change.

| Role | Primary | Backup | Channel |
|---|---|---|---|
| Incident Commander | TBD | TBD | Signal: TBD |
| Comms Lead | TBD | TBD | Signal: TBD |
| PauseGuardian (hot key) | TBD address | n/a | On-chain only |
| Multisig signers | See [GOVERNANCE.md](./GOVERNANCE.md) § Multisig | — | Telegram: #signers-emergency |
| Tenderly account owner | TBD | — | dashboard.tenderly.co |
| Cloudflare / hosting | TBD | — | — |

---

## 10. Known sharp edges

These are inherent to the protocol's current design. Memorize them — operating under stress without knowing them invites mistakes.

- **`distributeFeesToStakers` is permissionless** by design. During an incident, an attacker can call it to grief the post-mortem accounting. The values are still correct on-chain; the indexer attribution may look strange.
- **WETH-input swap fees are unwrappable only via `convertTokenFeesToETH(WETH)`** — calling `withdrawTokenFees(WETH)` works but sends 100% to treasury, bypassing the staker/POL/treasury split. During an incident this can look like fee misappropriation; it isn't.
- **TWAP snapshot reset is a 7-day timelock** — if the TWAP is poisoned during an incident, you cannot fast-forward the reset. Pause the consuming contracts instead and wait the timelock.
- **`emergencyWithdraw` forfeits accrued rewards.** Users who panic-withdraw lose unclaimed yield. The incident comms should explicitly note this so users don't blame the team for the lost yield.
- **Indexer event subscriptions are best-effort.** If Ponder crashed during the exploit, the war-room dashboard will under-count affected positions. Cross-reference with `cast logs` directly.

---

*This runbook is a living document. After every incident or drill, the IC owns updating it with what we learned. Stale runbooks kill more often than the incident itself.*
