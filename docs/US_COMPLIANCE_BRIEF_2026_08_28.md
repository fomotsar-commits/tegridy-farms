# US compliance brief — Tegridy Farms curve launchpad

**Status: operator working document. NOT legal advice.** Prepared 2026-08-28 by review of the
live product against publicly-reported US regulatory developments. It exists to make a
conversation with a crypto-securities attorney short and cheap — it is not a substitute for one.
Every "risk" below is a flag for counsel, not a determination.

## The one-paragraph situation

You operate a bonding-curve memecoin launchpad — the same product category as pump.fun, which is
in active SDNY litigation on the theory that **every** memecoin it issues is an unregistered
security (Securities Act §5/§12(a)(1)), now with RICO and "illegal digital casino" claims and
~$5.5B in claimed treble damages. Your differentiators from pump.fun — a protocol "ecosystem
reserve," "graduate-to-us," and promoted creator earnings — are exactly the "efforts of others /
ecosystem growth" features that the SEC's own Feb-2025 memecoin guidance says can turn a
memecoin *into* a security. So your product is more exposed on the securities axis than a plain
clone, not less. Your saving grace today is scale: **zero launches**, so you are not a practical
enforcement or class-action target yet. The exposure grows with adoption, which means the
cheapest risk reduction happens *now*, before there is a user to be harmed or a plaintiff.

## Risk-ranked, with cost to mitigate (cheapest-high-impact first)

| # | Risk | Who decides | Cost | Status |
|---|---|---|---|---|
| 1 | **Product promotes an ecosystem/earnings the Terms disclaim** — "40% creator earnings," a protocol "reserve," "graduate to us" vs. Terms §7 "the Protocol is not the promoter, you are the issuer." The mismatch is the securities-and-consumer-protection exposure. | Operator + counsel | Free–low | Copy softened 2026-08-28 (reserve claim now says "discretionary, not enforced on-chain"; creator-issuer line added at the create point). **Still promotes 40% earnings — a deliberate product choice; flag for counsel whether to reframe as fee-share mechanics rather than an earnings pitch.** |
| 2 | **No geoblocking of US / sanctioned jurisdictions** — Terms §3 puts it on the user (representation only); there is no geofence in code. A US-accessible launchpad post-pump.fun-suit with zero geoblocking is a posture choice. | Operator | Free (IP geofence) to low | OPEN. The single highest impact-per-dollar move: geofencing US persons off the *launch* surface materially changes the securities-offering-into-the-US analysis. |
| 3 | **No legal entity** — Terms admit "no formal DAO entity today." Personal liability flows to the operator/maintainer as an unincorporated promoter. | Operator + counsel | ~$hundreds (LLC/foundation) | OPEN. Compounds #1: an individual promoting token earnings is the worst posture. |
| 4 | **Securities status of the launched curve tokens** — the core legal question. Depends on how each token is marketed and the ecosystem framing, not just the "memecoin" label. | Counsel | $$ (opinion) | OPEN — needs counsel. The copy fix reduces the *protocol's* marketing exposure; it does not answer this for the tokens. |
| 5 | **Money-transmission posture** — non-custodial software (user's own wallet signs) leans *outside* MSB status (FinCEN 2019 unhosted-wallet guidance), but fee-taking + a protocol treasury muddy the "pure tool" story. | Counsel | $ (memo) | Likely OK but unconfirmed. Keep the non-custodial framing airtight; never route user funds through a protocol-controlled account. |
| 6 | **AML/sanctions program + tax treatment of protocol fee revenue** — none today. | Operator + counsel/CPA | low–$$ | OPEN. Lower urgency at zero revenue; decide before the first dollar (it is cheaper to design in than retrofit). |

## What is already strong (do not let counsel bill you to re-discover it)

- **Terms of Service** are genuinely well-drafted for DeFi: §7 (you-are-the-issuer, you determine
  your own securities/AML/sanctions/tax obligations, non-custodial tool, not issuer/underwriter/
  promoter/fiduciary), §10 (Fact Sheet is a disclosure, "not a security audit"), §11 (prohibited
  uses cover unregistered securities + sanctions evasion), plus disclaimer and liability caps.
- **Risks page** covers regulatory risk (§7), centralization (§8), and "a launch cannot be undone —
  you are the issuer for every legal purpose in your own jurisdiction."
- **Fact Sheet disclosure system** is compliance-*forward*: it surfaces structural token facts
  (mint/pause/blacklist powers, LP lock, insider vesting, fee split) at launch.
- "LP burned to 0x…dEaD, nobody can pull it" is accurate and contract-verified — not an over-claim.

## The three questions to put to a crypto-securities attorney

1. Given the Feb-2025 SEC memecoin guidance's roadmap/ecosystem carve-out, does our protocol-level
   "ecosystem reserve," "graduate-to-us," and promoted 40% creator earnings create promoter/
   issuer exposure for **us** (distinct from the token creators)? What reframing or geofencing most
   reduces it?
2. Should we geoblock US persons from the launch surface, and does doing so meaningfully change the
   analysis for a non-custodial launchpad?
3. What entity + minimal AML/tax posture should exist before the first external fee dollar, given a
   deliberately small operation?

Bring them: this brief, the live Terms/Risks pages, and the pump.fun SDNY docket (it is the
roadmap for what they will ask). Sources reviewed are dated 2026-08-28 and should be re-checked —
US crypto regulation is moving fast (CLARITY Act status, SEC crypto-asset rulemaking).
