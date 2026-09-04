**PREPARED FOR THE OPERATOR OF memetics.finance / memetic.fun — 2 September 2026**

---

> ## ⚠️ THIS IS NOT LEGAL ADVICE
>
> I am not a lawyer. Nothing in this document says that any product, design, or decision is *compliant*, *legal*, or *safe*. What follows is a description of what primary sources say, what the enforcement record shows, which facts regulators and courts have treated as decisive, and what is genuinely unresolved as of today.
>
> **A US securities lawyer with digital-asset experience must review this product before launch.** Section 6 is written to be sent to that lawyer verbatim. Several of the exposures below are criminal (18 U.S.C. § 1960), several are strict-liability (OFAC), and several attach to you personally rather than to any entity you form. None of them is addressed by anything in this document.
>
> Where I could not verify a source against the primary document, I say so explicitly. Do not let anyone — including me — represent an unverified claim as settled.

---

## 1. THE SHORT VERSION

### Materially risky

- **You set the reward rate and fund it from a treasury you control.** This is the single load-bearing fact. The SEC/CFTC joint interpretation of 23 March 2026 carves out reward-setting providers *four separate times* (Rel. 33-11412, nn. 123, 124, 125, 126), and adds that services it does not discuss are "outside the scope of this release" (n. 127). It never mentions liquidity pools, LP tokens, yield farming, lending, or emissions — I confirmed this by exhaustive term search of the full 91 Fed. Reg. 13714 text. Worse: in *SEC v. Coinbase*, No. 1:23-cv-04738-KPF (S.D.N.Y. 27 Mar. 2024), Judge Failla identified reward-rate discretion as the fact that defeated Coinbase's defence — and **Coinbase's rewards were protocol-generated. Yours are not.** On the precise fact the court found decisive, your position is weaker than Coinbase's was.

- **You advertise a forward-looking APR on your own website.** The March 2026 interpretation makes "the issuer's website or official social media accounts" a named channel through which profit expectations become reasonable (91 Fed. Reg. 13721-22), and defines "issuer" to include affiliates and agents (n. 83). Advertised yield figures were the quoted exhibits in *Kraken* (¶ 4) and *Coinbase* (¶ 323), and were pleaded as the deception in the FTC's Celsius case — which produced a **$16.5 million personal judgment against three founders on 20 July 2026, six weeks ago.** The FTC theory does not require a security, does not care how the SEC classifies BAYLA, and ends in personal liability and lifetime marketing bans.

- **Admin or upgrade keys over your own Ethereum/Base contracts holding user LP tokens.** This converts "non-custodial" into *control* under Cal. Fin. Code § 3102(c)(1), which is *storing* under § 3102(u), which requires a DFAL licence — a regime that went operative **1 July 2026** with its safe harbour already closed. It is "custody or control … on behalf of others" under 23 NYCRR 200.2(2). It is the *Ooki DAO* administrator-keys fact pattern. And it is why *Van Loon* does not help you: that case turned specifically on contracts that could not be "owned, controlled, or altered by anyone, including their creators."

### Routine

- **Non-custodial swap routing through Jupiter and EVM aggregators, where you are not the counterparty.** FinCEN's operative guidance (FIN-2019-G001 § 5.1) says a platform that "only provides a forum … with or without automatic matching" and where "the parties themselves settle … through individual wallets" is not a money transmitter. The IRS DeFi broker rule that would have swept in trading front-ends was repealed retroactively by Public Law 119-5 (10 April 2025) and removed from the CFR at 90 Fed. Reg. 30825 (11 July 2025).

- **Listing and trading BAYLA as a memecoin, standing alone.** The March 2026 taxonomy places meme coins in "digital collectibles," naming WIF as an example; DOGE and SHIB are named *digital commodities*. Token classification is the most favourable it has been since 2017. Note carefully: this answers a different question than whether the *farming programme* is an investment contract.

- **Using Streamflow's third-party audited program on Solana rather than your own contracts.** Being a *user* of someone else's immutable program is structurally the best position available anywhere in this product. It does not fix who sets the rate or funds the treasury — but it is materially better than the EVM side.

---

## 2. WHERE THE RISK ACTUALLY SITS

Four layers. **You control three of them.**

| Layer | What it is | Exposure | Case law posture |
|---|---|---|---|
| **Protocol** | Streamflow's program; the AMMs; your own EVM contracts | Low *if* third-party and immutable. High if you deployed it and hold keys. | *Risley v. Universal Navigation*, No. 23-1340-cv (2d Cir. 26 Feb. 2025) protects immutable published code from § 12(a)(1) statutory-seller liability — **but it issued as a non-precedential summary order** and concerned a DEX's liability for third parties' tokens, not a promoter's own funded programme. Do not over-read it. |
| **Frontend** | memetics.finance, the routing UI, the RPC, the support channel | High, and it is the proven hook. | *CFTC v. Uniswap Labs*, Rel. 8961-24 (4 Sept. 2024): $175,000 penalty. The violation was not writing the protocol — it was that Uniswap Labs "developed and maintained a web interface" through which users could reach leveraged tokens. Two Commissioners dissented; the order stands and was paid. |
| **Promotion** | The APR figure, the docs, X, Discord, affiliates, mods | **Highest ratio of exposure to cost-of-fix in the entire product.** | FTC v. Celsius (20 July 2026, $16.5M); FTC v. Ehrlich/Voyager (27 June 2025, $2.8M + lifetime ban, unanimous 3-0 under the current Commission). Neither required a security. Both ended personally. |
| **Treasury** | Funds emissions, receives fees, receives the early-exit penalty | High, and the fact that makes everything else worse. | Makes you the *obligor*. The interpretation's description of a **digital security** — instruments entitling holders "to receive economic distributions from a central party … promisor, or obligor" — is a description of your treasury. |

**Three consequences follow from this table.**

First, the one layer with meaningful caselaw protection is the layer you have the *least* control over — and only to the extent it is genuinely immutable and third-party. Every key you retain moves the protocol layer out of the protected column and into the frontend column.

Second, **the promotion layer is where nearly every recent penalty actually landed, and it is the cheapest thing in this document to change.** Rewriting an APR display and issuing a written communications policy costs a week of product work. It removes the single most quotable piece of evidence a plaintiff or regulator would use, and it is the only layer where FTC, state UDAP, and antifraud exposure all concentrate at once. If you do one thing from this briefing before launch, do this.

Third, and this is the uncomfortable one: **the four-way separation is real as a design principle, but it does not separate *you* from the liability.** Every entity structure surveyed — Wyoming DAO LLC, DUNA, Cayman foundation, BVI company — limits the liability of *passive participants*. None limits the liability of the person who wrote the code, holds the keys, runs the site, sets the rate, funds the treasury, and published the APR. That person is the primary actor by definition. In *bZeroX* the CFTC held the founders personally liable on two independent theories despite the LLC. Celsius and Voyager both ended in personal judgments. Roman Storm is a natural person.

---

## 3. THE CASE AGAINST

An adversarial pass was run against this product. Its conclusions are summarised honestly below, including where it overreaches.

### What would actually be charged

A regulator does not charge "is BAYLA a security." That is the fight you have prepared for, and it is not the fight you would get. The realistic charge sheet:

1. Securities Act §§ 5(a)/5(c) — unregistered investment contracts, **the farming programme** being the contract, not the token
2. Securities Act § 17(a) / Exchange Act § 10(b), Rule 10b-5 — the advertised APR, surviving every favourable classification outcome
3. Private § 12(a)(1) rescission, class-wide — no scienter, no reliance, three-year tail under § 13
4. FTC Act § 5 — deceptive yield advertising; does not touch Howey at all
5. 18 U.S.C. § 1960 — criminal; the count that **survived** in *Aguilar* when the securities counts did not
6. Cal. DFAL § 3201 / 23 NYCRR Part 200 — state licensing, where the test is *control*
7. 26 U.S.C. §§ 6041/3406/3403 — the 24% you cannot claw back

**The securities question is item one of seven, and it is the item on which you have the most favourable 2026 authority.** The adversarial strategy is not to win it. It is to let you defend it slowly and expensively while five other fronts run.

### The specific facts of *this* product a regulator would point at

- **Coinbase footnote 17.** "While it is true that staking rewards are determined by the protocols of the applicable blockchain network, Coinbase has acknowledged its ability to change the reward payout amount at its discretion." Coinbase's rewards *were* protocol-sourced and it still lost the motion. Yours are not protocol-sourced at all. That footnote is the first line of a brief against you. The opinion was **never vacated** — the case was dismissed with prejudice on 27 February 2025 on terms that state the decision rests "not on any assessment of the merits" and "does not reflect the Commission's position on any other case." The theory was deprioritised. It was never refuted.

- **The common-enterprise element you supply that *Aguilar* found missing.** In *Aguilar v. Baton Corp.*, No. 1:25-cv-00880-CM (S.D.N.Y. 31 Aug. 2026), Judge McMahon dismissed the pump.fun securities claims because "[t]he complaint does not allege that the SOL placed in the … bonding curves was put to use in, or otherwise tied to, some common undertaking whose success or failure would determine the fortunes of purchasers as a group." A bonding curve is a sequence of bilateral trades. **Your farm is one pool, one treasury, pro rata distribution, where each farmer's per-unit yield falls mechanically as others deposit** — the *Revak v. SEC Realty Corp.*, 18 F.3d 81, 87 (2d Cir. 1994) formulation recited from a product spec. Note the sting: the March 2026 interpretation *reversed* the Commission's own prior position and made common enterprise a **required** element (n. 7, reversing *In re Barkate*, citing *SEC v. Barry*, 146 F.4th 1242, 1251 (9th Cir. 2025)). That reads like a new defence. On these facts it is not one.

- **The early-exit penalty's destination.** *Aguilar* let Baton go on vertical commonality because its flat 1% was "earned regardless of whether the purchaser ultimately made money," putting it "on the stockbroker side of the *Jeanneret* distinction." If your penalty sweeps to your treasury, you have built a revenue line that pays you *when and because users lose*. That is the *In re J.P. Jeanneret Assocs.*, 769 F. Supp. 2d 340, 359-60 (S.D.N.Y. 2011) side of the line, and it is a design choice.

- **The passive-yield exclusion, three times.** Digital commodity (91 Fed. Reg. 13719), digital collectible (13719-20) and digital tool (13720) each carry the identical clause: the asset "does not have intrinsic economic properties or rights, such as generating a passive yield or conveying rights to future income, profits, or assets of a business enterprise or other entity, promisor, or obligor." Attaching an operator-funded advertised yield to your own memecoin builds the argument that it is not the yield-free collectible the guidance describes. The 27 February 2025 Meme Coin statement warns separately that it "does not extend to … products that are labeled 'meme coins' in an effort to evade the application of the federal securities laws."

- **What a complaint's opening paragraph looks like, using only facts you have published:**

> Defendants operate memetics.finance, a website through which they solicit the public to deposit liquidity provider tokens into smart contracts Defendants wrote, deployed, and control. In exchange, Defendants promise a return: a fixed quantity of tokens per day, paid from a treasury Defendants own and fund, at a rate Defendants set and may change. Defendants advertise this return on their own website as an annual percentage rate. Investors cannot withdraw for a period Defendants specify, and forfeit a portion of their deposit to Defendants if they try. The returns are not generated by any blockchain protocol. They are generated by Defendants' ongoing decisions about how much to emit, to which pools, for how long, and whether to continue at all.

There is nothing there you would dispute, and it recites all four Howey elements.

### Where the adversarial pass is right that it hurts most

**Discovery produces the evidence, not your contracts.** *Aguilar*'s surviving wire-fraud predicate rests substantially on a single CEO post on X calling the platform "an unruggable fair launch platform." OFAC multiplied Exodus Movement's penalty roughly twentyfold — from a $242,000 base to $4,774,400 — over **twelve customer-support messages** suggesting VPNs, and called it egregious. DOJ's framing in *Storm* was that developers "explicitly discussed — but forwent — feasible measures to curb criminality."

The pattern is consistent: **a written internal discussion about whether to add a control, followed by a decision not to, is worse than never having had the conversation.** Your moderators are unpaid, untrained and inclined to be helpful. Your team channel contains the treasury runway model. If you are going to deliberate about screening or geoblocking, deliberate with counsel present.

### Where the adversarial pass overreaches

Three corrections, in fairness to you:

- **Everything above is a pleading-stage argument.** *Aguilar*, *Sarcuni* and *Samuels* are Rule 12 rulings. No appellate court has ever ruled on DAO partnership liability, on whether promoter-funded farming is a security, or on whether § 1960 requires control of funds.
- **No court has ever held that a staking or yield programme *is* a security on the merits.** *Coinbase* survived a motion to dismiss; it was never tried.
- **There has never been an OFAC enforcement action against a DeFi frontend operator for failure to screen**, and I found no state MTL enforcement action against a purely non-custodial venue. Those are meaningful absences — they are not safe harbours, and both trend lines are moving toward you, but they are absences.

---

## 4. DESIGN DECISIONS THAT REDUCE RISK

Ranked by risk reduced ÷ effort. **None of these makes anything lawful.** Each changes a fact that the cited authorities treat as decisive.

### Tier 1 — do these before launch (days of work, largest effect)

**1.1 — Rebuild the APR display.**
This is the highest-value change in the document. Concretely:

- Kill the bare imperative. "Earn 400% APY" is a promise. "Current rate at today's emissions and TVL: 400%" is a computed observation.
- **Show the inputs beside the output, not behind a link**: daily emission rate, current staked TVL, reward-token price used, calculation timestamp. Publish the formula. A reader who can reproduce your number is a reader who was not deceived — and this doubles as your substantiation file.
- **Separate emission rewards from organic yield in the UI.** Kamino ships a live, user-facing toggle labelled *"Include KMNO Rewards in APY"* — the user opts in to seeing emissions blended into the headline. That is a shipped competitor answer to your exact question, built by a venue that *also* excludes US users.
- Drop "APY" unless rewards actually auto-compound. If claiming is manual, APY asserts a mechanic you do not have.
- Add realised historical distributions per unit staked (trailing 7/30 days) once you have history. Historical realised numbers are substantiable; forward projections are not.
- Model the honest problem out loud internally: **your APR is derived from the spot price of a token your own emissions dilute.** If the number is unachievable by construction, that is a fraud exposure regardless of how classification resolves — and it is what Grewal was pointing at in *Kraken* ("whether it even had the means of paying the marketed returns in the first place").

**1.2 — Give lock duration and the early-exit penalty equal visual weight to the yield.**
Same font size, same card, above the fold, not in a tooltip. 16 CFR § 465.1(c)(4) states a disclosure is *not* clear and conspicuous "if a consumer must take any action, such as clicking on a hyperlink or hovering over an icon, to see it," and § 465.1(c)(7) says it "must not be contradicted or mitigated by" the surrounding creative.

**1.3 — Change where the early-exit penalty goes.**
Burn it, or redistribute it to remaining stakers. Do not sweep it to the treasury. This is a one-line change that removes you as the beneficiary of user losses — the *Jeanneret* vertical-commonality fact, the state UDAP fact, and the "operator profits when users lose" narrative, all at once.

**1.4 — Written communications policy binding founders, mods, and every paid promoter.**
Blocklist enforced in review of marketing copy: *guaranteed, safe, no risk, insured, backstopped, risk-free, unruggable, up to X%*. Never advise a user how to reach the product from a restricted location; never suggest a VPN; route anyone self-identifying as being in a restricted jurisdiction to a fixed, logged response. Ban sentiment-conditioned compensation outright — 16 CFR § 465.4 reaches incentives conditioned "expressly **or by implication**" on favourable posts, which captures allocations, whitelist spots, fee rebates and airdrop eligibility. Require § 465.5 affiliation disclosure from team and mods on every promotional post. Never buy engagement (§ 465.8). **Note: 16 CFR Part 465 is a trade regulation rule, so knowing violations carry civil penalties — $53,088 per violation as adjusted 17 January 2025 (90 Fed. Reg. 5580), higher today.**

**1.5 — Describe audits precisely.** Who audited, which contract at which commit, what scope, what was *not* covered, and that an audit is not a guarantee. Bare "Audited" is an unqualified safety claim.

**1.6 — Update the geo-block list and turn on SDN screening.**
Current comprehensive set: Cuba, Iran, North Korea, Crimea, DNR, LNR. **Syria is out** — E.O. 14312 (30 June 2025, effective 1 July 2025), Syrian Sanctions Regulations removed from the CFR 26 August 2025. Any block copied from a 2023 template is over-blocking. Implement at the CDN/WAF so it covers app, RPC proxy, API and docs. For EVM, **screen the raw address chain-agnostically** — the SDN list itself carries the same DPRK address under both ARB and BSC tags, so a screen keyed to the ETH tag alone will miss listings. Rescreen daily against a freshly pulled list, and rescreen at reward claim and unstake, not only at wallet connect.

> **Do not switch screening on before 4.6 below is built.** A rejected transaction is reportable within 10 business days under 31 CFR 501.604. Screening, logging hits, and filing nothing creates a durable, timestamped record of unreported rejections that did not exist before you started screening — retained for 10 years under the March 2025 recordkeeping amendment (90 Fed. Reg. 13286).

**1.7 — Start the nightly substantiation cron now.** Archive daily: emission rate, TVL, reward-token price, computed APR, and a versioned snapshot of the yield page. FTC prior-substantiation doctrine requires support to exist *when the claim runs*. This is a cron job, not a legal project, and it is unbuildable retroactively.

**1.8 — Build the per-wallet claim ledger with USD FMV at claim.** You need it to hand users for self-reporting, to answer a John Doe summons, to file retroactively if a § 6041 obligation is asserted, and to compute your own treasury gain on tokens paid out.

### Tier 2 — do these before launch (weeks of work, large effect)

**2.1 — Give up unilateral upgrade authority over the farming contracts.** Either immutable, or upgrade behind a timelock long enough for users to exit, with a multisig on which you are not a majority, scoped so it provably cannot reach user principal. This is verifiable on-chain by a regulator, a plaintiff, or a user — which is exactly why it counts. If you keep a pause, draft and *implement* it to match the SB 97 proviso: terminate/suspend/interrupt **solely in response to unauthorised or fraudulent activity**, written into the contract, with automatic expiry. A general business-purpose kill switch is outside that proviso.

**2.2 — Separate the reward treasury from user principal.** Two contracts, two authorities, no shared privileged role. The treasury *pushes* into a distributor; it never has a pull path out of the principal vault. If one operator-controlled contract holds both, the distinction collapses entirely.

**2.3 — Keep the frontend out of the value path.** Frontend builds an unsigned transaction; the user's wallet signs and broadcasts. No operator relayer, no paymaster that takes receipt, no intermediate account, no co-signing, no inventory, no internalising order flow. Take protocol fees on-chain in the contract, withdrawable later — not as an off-chain cut of a flow an operator wallet handled. This is the line on which § 1960 and state money-transmitter licensing turn, and it is the personal criminal exposure no entity form reaches.

**2.4 — Form a plain LLC and actually respect it.** Separate operating bank account. Separate on-chain wallets for treasury, fees and personal holdings, never mixed. Written operating agreement. Real capitalisation. Salary or documented distributions, never ad hoc withdrawals. **Do not elect Wyoming DAO LLC status** — the shield is the identical W.S. 17-29-304 LLC shield, but you inherit the public smart-contract identifier (W.S. 17-31-106(b)), amendment on every upgrade (17-31-107(a)(iii)), and 30-day auto-dissolution for non-filing (17-31-105(e)). **A DUNA is structurally unavailable to you** — W.S. 17-32-104(b) forbids distributing income or profits to members or administrators, and 17-32-102(a)(iii)(A) requires 100 members with a common *nonprofit* purpose. Consider segmenting: frontend entity, token/treasury vehicle, contract deployer. That bounds blast radius, which is the main thing entity structure can genuinely deliver.

**2.5 — Write the control memo, dated, at deployment.** Every contract address, every privileged role, who holds each key, what each privileged function can and cannot reach, deployed bytecode hash. This is the entire ballgame in a "total independent control" analysis under FIN-2019-G001 § 4.2, and it is vastly more credible written at deployment than reconstructed under subpoena.

**2.6 — Stand up the 31 CFR 501.604 rejected-transaction reporting path and register for the OFAC Reporting System *before* screening goes live.**

**2.7 — Build a W-9/TIN collection path you can switch on.** If § 6041 applies and payees have no TIN, § 3406 requires 24% backup withholding and § 3403 makes you liable for tax you failed to withhold. **You cannot withhold 24% from an on-chain distribution you already made.** Notice 2025-33's relief is scoped by its own title to § 6045 sales and does not touch this. Having the switch is the difference between a forward-looking fix and a retrospective liability.

### Tier 3 — structural, high cost, largest effect on the core question

**3.1 — Make the emission schedule immutable and pre-funded.** Fixed in deployed code, unchangeable by any key you hold, with the reward tokens irrevocably escrowed up front — no clawback. This removes the fact from *Coinbase* fn. 17. Understand its limit honestly: you still chose the schedule, you still funded it, you still advertise it. It moves one fact, not all of them.

**3.2 — Consider fee-share instead of treasury emissions.** A pro rata share of fees the pool actually earned is a different economic object from yield paid by an obligor. It is the gap between the passive-yield exclusion applying and not applying. It is also a large product change with real economics attached — this is a business decision counsel should price, not a free move.

**3.3 — Reconsider locks and penalties entirely.** Withdrawal at will, or a purely mechanical unbonding delay with no forfeiture, removes the operator-authored risk of loss that satisfied Howey prong one in *Coinbase*.

**3.4 — Decide the geo-block question deliberately.** Note the datapoint honestly: **every Solana venue closest to your model — Jupiter (Panama), Kamino (Panama/BVI), Raydium, Meteora (BVI) — names the United States as a prohibited jurisdiction, and Kamino's terms were last updated 7 August 2026, deep into the friendly federal posture, and kept the exclusion.** Meanwhile Uniswap, Aave and Curve all serve US users with sanctions-only lists and thick disclosure. Those are two coherent postures. **What is not coherent is copying a Camp B US-exclusion clause into a US-serving venue** — that produces a written admission you believed US access was a problem, paired with evidence you served US users anyway. If you serve the US, say so and build the Camp A disclosure surface. If you block, block for real and log it.

### Things NOT to do

- **Do not offshore while you live and work in the US.** *Ooki DAO* held CEA § 13a-1(e) confers nationwide service — the test is contacts with the United States as a whole. OFAC treated ShapeShift as a US person despite Swiss incorporation because it was headquartered in Denver and "ShapeShift's U.S.-based engineers created and regularly maintained the software code." **Meteora is a BVI company whose terms exclude US users and specify arbitration in Tortola, and it is a defendant in the Southern District of New York right now** (*Hurlock v. Kelsier Labs*, No. 1:25-cv-03891-JLR). And you would acquire Forms 5471/5472/8858/3520/926, FBAR and 8938 obligations with per-form penalties, plus Subpart F/GILTI, plus a "he set up a shell to hide" narrative.
- **Do not run a standing BAYLA buyback or redemption programme.** 31 CFR § 1.6045-1(a)(1) is *live text* the CRA repeal did not touch: a broker includes "a person that regularly offers to redeem digital assets that were created or issued by that person." This is the most under-appreciated exposure on the list.
- **Do not launch token governance voting before a wrapper exists.** Under *Sarcuni* and *Samuels* this is the affirmative act that manufactures a general partnership out of your users. Under W.S. 17-31-113(d)(i) it auto-enrols them as statutory members. It is liability-*creating*.
- **Do not register as an MSB "just in case."** Registration under 31 CFR § 1022.380 creates affirmative, criminally enforceable BSA obligations whose breach is itself the offence, and is a strong admission for 50-state licensing purposes. Counsel decides this after the control analysis, not before.
- **Do not rely on Terms of Use as a control.** OFAC rejected exactly this in Exodus: a ToS prohibition plus user self-certification was insufficient because it was not "accompanied by any other practical mechanism." *SEC v. Telegram*, 448 F. Supp. 3d 352, 365: disclaimers "contrary to the apparent economic reality of a transaction … are not dispositive."
- **Do not build a voluntary KYC flow without counsel.** A half-built identity collection creates privacy and data-security obligations and can be characterised as evidence you understood yourself to be a financial institution.

---

## 5. WHAT IS GENUINELY UNSETTLED

Reasonable lawyers disagree on all of these in 2026. "Unsettled" is the honest answer and is more useful than false confidence.

1. **Whether promoter-funded LP farming is a security.** No SEC guidance says yes; none says no. The March 2026 interpretation is *silent* — I verified by term search that "liquidity pool," "yield farming," "lending," "LP token" and "emission" appear zero times. Silence is not permission. It is an open question the Commission conspicuously did not answer.

2. **Whether the 2023 theories were wrong or merely deprioritised.** The *Coinbase* dismissal says on its face it rests "not on any assessment of the merits." The Failla opinion was never vacated. The *Nexo* order (Rel. 33-11149, 19 Jan. 2023) was never vacated. **No court has ever ruled that a promoter-funded yield programme is not a security.**

3. **Durability of the March 2026 interpretation.** It is an interpretive rule, exempt from notice and comment under 5 U.S.C. 808(2), adopted by a three-member all-Republican Commission after the only dissenting voice departed on 2 January 2026, and designated a CRA "major rule." A future Commission can withdraw it the same way. Post-*Loper Bright* it draws at most persuasive weight from a court, and it binds no private plaintiff and no state regulator.

4. **Whether § 1960 requires control or custody of funds.** *The* question, and it is undecided. Judge Failla reportedly held at the motion-to-dismiss stage that control is not an element. The Rule 29 motion in *US v. Storm* was argued 9 April 2026 and **the court expressly deferred ruling**; retrial was adjourned on 25 August 2026 to **26 April 2027** precisely because that motion is pending. Appellate resolution is realistically 2028-29. You would be building into a legal vacuum on the question with the most personal downside.

5. **Whether atomic, non-discretionary receipt by a smart contract is "acceptance" under 31 CFR 1010.100(ff)(5)(i)(A).** FinCEN's framework predates AMMs and assumes a human intermediary. No guidance, no ruling, no case.

6. **Whether an operator-held pause or upgrade key is "control" under DFAL.** Textually it looks like "power to … prevent indefinitely," and the SB 97 fraud-only proviso implies the legislature thought a broader kill switch *would* be control. DFPI has not applied it and it is unlitigated.

7. **Whether an LP token is a "digital financial asset."** Real textual argument both ways — it may be excluded by Cal. Fin. Code § 3102(g)(2)(D) as a record of ownership of intangible goods. This decides whether the farm is inside or outside DFAL.

8. **Whether reward tokens vesting subject to a lock and forfeiture fall under § 83.** Rev. Rul. 2023-14 fn. 3 *expressly declines to address § 83*. No authority on point for farm rewards.

9. **Whether farm rewards are US-source FDAP** triggering § 1441 30% gross withholding and Form 1042-S for non-US payees. **There is no guidance at all.** If the answer were yes, withholding-agent liability would dwarf everything else here.

10. **Whether geo-blocking defeats jurisdiction or merely mitigates.** No authority treats IP-based geo-blocking as a jurisdictional bar. It is universal practice; its legal effect is untested.

11. **Whether the CLARITY Act passes.** H.R. 3633 passed the House 294-134 on 17 July 2025 and cleared Senate Banking 15-9 on 14 May 2026; cloture was filed 8 August 2026 with a procedural vote reported for around 15 September 2026. **Not law.** Its non-custodial developer provisions would most alter this analysis, and they do not exist. Do not plan around passage.

12. **Regulation Crypto Assets is proposed only** — 91 Fed. Reg. 54510 (21 Aug. 2026), comments due 20 October 2026. Its Rule 400 safe harbour requires that the issuer "has completed or otherwise permanently ceased all essential managerial efforts," which an operator running a live emissions programme cannot represent. And I confirmed by term search that "APR" and "APY" appear **zero times** in the proposal — it is an offering regime, not a DeFi activity regime. The gap you sit in is not filled by it.

### Verification caveats — read these

A verification pass was run against the primary documents. Most citations held up verbatim. Three things you should treat as *unverified* until counsel checks them:

- **Commissioner Peirce, "Headstands and Summervaults" (22 July 2026)** — the statement's *existence and date are confirmed* (archived at the SEC URL, HTTP 200). Its **content is not verified**: the "headstands, backflips" quotation, the Investment Company Act / *Reves* / Advisers Act analysis, and the closing invitation on vaults are all repeated from a single research pass. This is the most on-point 2026 source for a yield product and several recommendations lean on it. **Pull it before relying on it.**
- **SEC Division of Trading and Markets staff statement on user interfaces (13 April 2026, File No. 4-894)** — existence and date confirmed; the twelve conditions and nine disqualifying activities are unverified in detail.
- **The status of the February 2023 *Kraken* permanent injunction** in 3:23-cv-00588 is unresolved. It was reported as unverifiable because CourtListener "required credentials" — **that is wrong; CourtListener is accessible with an ordinary browser.** Have counsel simply check the docket before drawing any comfort from Kraken's January 2025 US staking relaunch.

Additionally: one research pass listed **ALGO and LBC** among the Commission's named digital commodities. **They are not there.** The release names exactly sixteen: APT, AVAX, BTC, BCH, ADA, LINK, DOGE, ETH, HBAR, LTC, DOT, SHIB, SOL, XLM, XTZ, XRP. LBC is the LBRY Credits token the SEC successfully *sued* over. Disregard any version of this analysis containing that list.

---

## 6. QUESTIONS FOR COUNSEL

> **Send this section verbatim.** Bring to the first meeting: contract addresses on all chains, the key-holder list, deployed bytecode hashes, a screenshot of every screen displaying a yield figure, your current Terms of Use, the treasury runway model, and your marketing/affiliate agreements. The analysis turns on facts an engineer has and a lawyer does not.
>
> Questions 1-6 are gating: their answers determine whether the product launches in its current shape. Do not skip to the rest.

### A. Gating — answer before we write more code

1. Given the SEC/CFTC joint interpretation (Rel. 33-11412, 91 Fed. Reg. 13714) defines Protocol Staking as staking **digital commodities on PoS networks for protocol-issued rewards**, do our BAYLA single-sided programme and our LP farming programme fall outside all four covered types? If so, what is the affirmative Howey analysis on the merits, not merely the absence of a prohibition?

2. Do footnotes 123-127 and 131 take us outside the release **on their face**, given that we set a fixed daily emission schedule from a treasury we control and provide the means by which an LP receipt token generates returns? Is there any reading under which we are inside any safe harbour in that release?

3. Please compare our product feature-by-feature against *SEC v. Payward* Compl. ¶¶ 1-8 and *SEC v. Coinbase* Compl. ¶¶ 7, 316-324, and against Judge Failla's 27 March 2024 opinion. **Which alleged facts do we replicate? Which do we avoid? What would a complaint against us look like using only our own frontend copy as exhibits?**

4. Rank these five changes by how much each reduces securities exposure, so we can price the product trade-offs: (a) removing the forward-looking APR entirely; (b) making the emission schedule immutable and pre-funded with no operator key; (c) replacing treasury emissions with a pass-through of actually-collected pool fees; (d) removing locks and the early-exit penalty; (e) renouncing all admin control over the farming contracts.

5. Does our operator-held upgrade or pause authority over the Ethereum/Base contracts constitute "control" under Cal. Fin. Code § 3102(c)(1) and therefore "store" under § 3102(u)? **Please answer specifically for the LP farming contract, which is not yet deployed and can still be architected around your answer.** If we narrow the pause on-chain to fraud/unauthorised activity only, does the SB 97 proviso reach us given that we take fees?

6. We did not submit a completed DFAL application by 1 July 2026. What is our exposure for California residents from that date forward on each surface — swap routing, Streamflow staking, own-contract farming, NFT marketplace — and does anything short of geo-blocking California address it?

### B. The farm specifically

7. Does our single pro rata reward pool supply the common-enterprise element that *Aguilar v. Baton Corp.* (S.D.N.Y. 31 Aug. 2026) found missing in a bonding curve, applying *Revak*'s horizontal-commonality formulation? Does the Commission's *Barkate* reversal at n. 7 help or hurt us here?

8. Where should the early-exit penalty go? Does routing it to our treasury versus recycling it to remaining stakers versus burning it change the securities, vertical-commonality, state UDAP, or fiduciary analysis? We will implement whichever you specify.

9. Do our lock durations and forfeiture put reward tokens under § 83, given that Rev. Rul. 2023-14 fn. 3 expressly reserves the question? If § 83 applies, what happens to user income timing, our deduction, and § 83(b) mechanics — and can a pseudonymous holder even make an election?

10. Is the distribution of the reward token to depositors a **separate** offer and sale requiring its own analysis, given that n. 141 takes it outside the airdrop interpretation because users provide consideration?

11. Does routing execution through Streamflow's third-party audited program change who is deemed to perform the efforts, or does it leave the reward-setting and treasury-funding facts untouched?

### C. Promotion — the layer we can change fastest

12. How much of the third-prong risk is carried by the frontend APR figure specifically, given that the release names "the issuer's website or official social media accounts"? If we replace a projected APR with realised historical distribution data plus disclosed inputs and formula, does that change your assessment materially? **What exact display and disclosure language do you want?**

13. Our APR is computed from the spot price of a reward token our own emissions dilute. Is that figure substantiable under FTC prior-substantiation doctrine? What substantiation file do you need to exist before any rate is published, and for how long must it be retained?

14. What is our exposure under FTC Act § 5, given *FTC v. Celsius* (20 July 2026, $16.5M) pleaded "as high as 18% annual percentage yield" as a deception and *FTC v. Ehrlich* (27 June 2025) produced a lifetime marketing ban? **What is the personal exposure of our principals, and does any entity structure or insurance meaningfully address it?**

15. Please review our influencer and affiliate agreements against Securities Act § 17(b) (which requires disclosure of the **amount**, not just the fact, of compensation), the Endorsement Guides (16 CFR Part 255), and 16 CFR §§ 465.1(c), 465.4, 465.5 and 465.8. Do any of our token allocations, whitelist grants, fee rebates or airdrop-eligibility rules constitute sentiment-conditioned compensation under § 465.4?

16. Please draft the written communications policy for founders, moderators and paid promoters, keyed to the § 465.1(c)(4) "unavoidable disclosure" standard, to the OFAC Exodus VPN findings, and to *Aguilar*'s treatment of a single CEO post as a wire-fraud predicate. **What must a moderator say to a user who states they are in Iran, and what must never be said?** We want this in writing before it is needed.

17. What archiving and version-control obligations follow from the fact that the interpretation makes the **timing** of each representation relative to each purchase decisive, and that post-sale representations do not convert a prior sale?

### D. Custody, control and state licensing

18. Under 23 NYCRR 200.2, does operating a fee-taking interface that curates a token list and funds rewards fall outside "the development and dissemination of software **in and of itself**"? Is "performing Exchange Services as a customer business" a plausible NYDFS theory against a router that never holds assets?

19. **Should we geo-block New York now?** What is our position if S.8901 is enacted with criminal tiers and no non-custodial carve-out, and would it reach conduct before enactment? Separately, how should we read the NYDFS memecoin industry letter of 16 January 2025 and the NY OAG's 27 July 2026 PSI statement that DeFi platforms "operate front-end solutions but choose to do nothing"?

20. Which states beyond NY and CA actually reach crypto-only, non-custodial, fee-taking activity — please confirm Minnesota, North Dakota, Louisiana, and any other Article XIII or virtual-currency-inclusive state, and give us a **block-or-licence call per state**, not a survey. Given 18 U.S.C. § 1960(b)(1)(A), which of those treat unlicensed operation as a misdemeanour or felony?

21. Does our US nexus — US-resident principals, US-based engineering, US-facing site — survive geo-blocking for either state civil enforcement or the NY criminal theory?

### E. BSA and § 1960 — please treat as a separate engagement

22. Surface by surface — Jupiter-routed Solana swaps, EVM aggregator swaps, Streamflow staking, our own Ethereum/Base contracts, the NFT marketplace — which flows involve us accepting one form of value and transmitting another for a fee, and which fall within the 31 CFR § 1010.100(ff)(5)(ii)(A) network-access exclusion and FIN-2019-G001 § 5.1?

23. Given our exact deployed contracts and key-holder set, do we hold "total independent control" over user value within FIN-2019-G001 § 4.2? Does our combination of deploying + hosting the UI + funding emissions + marketing an APR take us out of § 5.2.2 ("mere act of creating") and into § 5.2.3 ("uses or deploys … to engage in money transmission")?

24. What is our § 1960 exposure, stated **separately** for (b)(1)(A), (B) and (C), after *US v. Goklu* (2d Cir. 2026) and *Aguilar*? How much weight should we place on the Blanche memo given that it excludes (b)(1)(C) by its own footnote 2 and creates no enforceable rights?

25. **What is the status of *US v. Storm* today?** Our understanding is that the Rule 29 motion argued 9 April 2026 remains undecided and retrial was adjourned to 26 April 2027 (Dkt. #300, 25 Aug. 2026). Does the outcome change any advice you give us, and should we revisit after it resolves?

26. Should we implement OFAC SDN screening and blocked-address rejection at the frontend? Does implementing it help our OFAC position while hurting our § 1960 position by evidencing control — and how do you weigh that trade-off? If we screen, does turning a user away trigger a 31 CFR 501.604 rejected-transaction report within 10 business days, and does the answer differ between refusing to render the UI, refusing to build the transaction, and a contract-level revert?

27. Do our BAYLA Token-2022 authorities — freeze, transfer hook, fee config — create control facts we should renounce? Does retaining an unused blocking capability create an expectation that we use it on designation?

### F. Tax

28. Are we a "payor" under Treas. Reg. § 1.6041-1(e) for LP farm rewards funded by our treasury, distributed by (a) our own EVM contracts and (b) Streamflow's Solana program? Does "management or oversight" or "significant economic interest" carry the weight, and does the answer differ between the two?

29. If yes — which form (1099-MISC box 3, 1099-INT under § 6049, or 1099-NEC), and does our APR/APY and "earn" vocabulary move that answer?

30. **Please quantify our § 3403 exposure** for having paid rewards to wallets with no W-9, given § 3406(b)(3)(A), the 24% rate, and that Notice 2025-33 relief is scoped to § 6045 sales only. Can it be capped, cured, or voluntarily disclosed? What are the § 6721, § 6722 and § 6656 add-ons?

31. Does a fixed daily emission schedule make rewards "fixed or determinable" under Treas. Reg. § 1.6041-1(c) in a way a variable fee-funded rate would not? How much would moving to a variable rate actually buy us?

32. For non-US wallets: is any part of a farm reward US-source FDAP requiring § 1441 30% withholding and Form 1042-S, and what is our withholding-agent exposure? We understand there is no guidance — please tell us how you would posture.

33. Does any BAYLA treasury buyback or redemption programme make us a broker under the **live** text of 31 CFR § 1.6045-1(a)(1) — "a person that regularly offers to redeem digital assets that were created or issued by that person" — which the CRA repeal did not touch? What distinguishes "regularly offers to redeem" from discrete treasury market operations?

### G. Entity and personal exposure

34. Given that I personally operate the frontend, hold the fee wallet, hold upgrade authority, fund emissions, and publish the APR figures — **is there any entity structure that changes MY personal exposure to an SEC, CFTC, FTC or state action, as opposed to changing who else is named alongside me?** Please answer that directly before recommending any structure.

35. What is my exposure for the period already elapsed? Does forming an entity now do anything about historical conduct, and is voluntary disclosure or remediation worth considering?

36. How many entities, and where do the boundaries go — frontend/fee-taker, token and treasury, contract deployer? What does that buy against (a) a private class action, (b) a federal regulator, (c) a state AG?

37. What separateness discipline do you need to see for the LLC shield to survive a veil-piercing challenge **where the entity's treasury is self-custodied crypto and I hold the keys**? There is little case law here and it is the question most likely to decide whether my personal assets are reachable.

38. What is our private § 12(a)(1) rescission exposure? Who are the statutory sellers, does *Risley* (a non-precedential summary order) help our contracts, does the *Underwood* centralised/decentralised line put our frontend entity on the wrong side, and what is the § 13 limitations tail on a programme launched now?

39. Is tech E&O and D&O available for this business, will it respond to a **regulatory investigation** as opposed to a lawsuit, and what are the crypto exclusions?

### H. Posture and process

40. Should we seek a CorpFin no-action letter, following the DoubleZero (29 Sept. 2025), Fuse Crypto (29 Nov. 2025) and MegPrime (15 Jan. 2026) path? What facts would we need to represent, and **what would we have to give up in product design to represent them truthfully?**

41. Should we file a comment on Regulation Crypto Assets (File No. S7-2026-27) before the 20 October 2026 deadline, describing this product shape and asking the Commission to address promoter-funded, non-custodial reward programmes — a gap the proposal does not reach?

42. How much of your advice depends on the March 2026 interpretation (an interpretive rule adopted without notice and comment, withdrawable the same way, binding no court) and on the Blanche memo (revocable charging policy)? **What would you change if either were withdrawn, and what could we rely on if the posture reverses?**

43. Please pull and read Commissioner Peirce's "Headstands and Summervaults" (22 July 2026) and apply it to us directly: are we a "vault"? Do we implicate the Investment Company Act? *Reves* note analysis? The Advisers Act, given we select pools and set rates? **We have confirmed the statement exists but have not verified its contents.**

44. Please confirm the status of the February 2023 *Kraken* permanent injunction in *SEC v. Payward*, No. 3:23-cv-00588 (N.D. Cal.). If it stands, what did Kraken rely on to relaunch US staking in January 2025, and does any of that reasoning transfer to a promoter-funded, non-protocol reward programme?

45. **What must change before launch, versus what can be remediated after — and what is the trigger that should make us stop?**

---

## 7. SOURCES

Every claim above traces to one of these. Verification status noted where relevant. All URLs as of 2 September 2026.

### Federal securities — controlling

| Source | Date | Notes |
|---|---|---|
| SEC & CFTC, *Application of the Federal Securities Laws to Certain Types of Crypto Assets…*, Rel. Nos. 33-11412; 34-105020; File No. S7-2026-09, **91 Fed. Reg. 13714** — [federalregister.gov](https://www.federalregister.gov/documents/2026/03/23/2026-05635/application-of-the-federal-securities-laws-to-certain-types-of-crypto-assets-and-certain) | Issued 17 Mar. 2026; published & effective **23 Mar. 2026** | ✅ Full text verified. nn. 7, 83, 88, 89, 107, 123-127, 131, 141, 149 confirmed verbatim. Sixteen named digital commodities confirmed. Zero occurrences of "liquidity pool," "yield farming," "lending," "LP token," "emission." |
| SEC, *Regulation Crypto Assets* (proposed), Rel. Nos. 33-11434; 34-106150; File No. S7-2026-27, **91 Fed. Reg. 54510** — [federalregister.gov](https://www.federalregister.gov/documents/2026/08/21/2026-17183/regulation-crypto-assets) | Published 21 Aug. 2026; **comments due 20 Oct. 2026** | ✅ Verified. "APR" and "APY" appear zero times. Rule 400 requires "permanently ceased all essential managerial efforts." **Proposed only.** |
| SEC CorpFin, *Staff Statement on Meme Coins* — [sec.gov](https://www.sec.gov/newsroom/speeches-statements/staff-statement-meme-coins) | 27 Feb. 2025 | Superseded in part by Rel. 33-11412. Staff statements "have no legal force or effect." |
| SEC CorpFin, *Statement on Certain Protocol Staking Activities* | 29 May 2025 | Superseded by Rel. 33-11412 |
| SEC CorpFin, *Statement on Certain Liquid Staking Activities* | 5 Aug. 2025 | Superseded by Rel. 33-11412 |
| Commissioner Peirce, *Headstands and Summervaults: A Statement on Crypto Vaults and Lending Strategies* — [sec.gov](https://www.sec.gov/newsroom/speeches-statements/peirce-statement-crypto-vaults-lending-strategies-072226) | 22 July 2026 | ⚠️ **Existence and date confirmed (archived, HTTP 200). Content NOT verified.** Most on-point 2026 source for a yield product. Counsel must pull it. |
| SEC Div. of Trading & Markets, *Staff Statement Regarding Broker-Dealer Registration of Certain User Interfaces…*, File No. 4-894 | 13 Apr. 2026 | ⚠️ Existence/date confirmed. Twelve conditions and nine exclusions **not verified**. Self-withdraws 13 Apr. 2031. |
| SEC Press Rel. 2025-47, *Dismissal of Civil Enforcement Action Against Coinbase* | 27 Feb. 2025 | "Not on any assessment of the merits" |

### Enforcement record

- **Complaint, *SEC v. Payward Ventures, Inc.***, No. 3:23-cv-00588 (N.D. Cal. filed 9 Feb. 2023); Press Rel. 2023-25; Lit. Rel. 25637 (13 Feb. 2023). $30M. ⚠️ **Injunction status unresolved — verify on CourtListener/PACER.**
- **Complaint, *SEC v. Coinbase, Inc.***, No. 1:23-cv-04738 (S.D.N.Y. filed 6 June 2023), ¶¶ 7, 316-324.
- ***SEC v. Coinbase*, Opinion & Order, Dkt. 105** (S.D.N.Y. 27 Mar. 2024) (Failla, J.) — **fn. 17 on reward-payout discretion.** Not vacated. Text at [business.cch.com](https://business.cch.com/srd/SECvCoinbase.pdf).
- ***In re Nexo Capital Inc.***, Securities Act Rel. No. 11149 (19 Jan. 2023). Never vacated.
- ***CFTC v. Uniswap Labs***, Rel. 8961-24 (4 Sept. 2024). $175,000 — **frontend as the hook.**
- ***CFTC v. Ooki DAO***, No. 3:22-cv-05416-WHO, Dkt. 76 (N.D. Cal. 8 June 2023); *In re bZeroX, LLC*, CFTC Rel. 8590-22 (22 Sept. 2022).

### Courts

- ***Aguilar v. Baton Corp. Ltd. d/b/a Pump.Fun***, No. 1:25-cv-00880-CM, **Dkt. 184 (S.D.N.Y. 31 Aug. 2026)** (McMahon, J.). ✅ Verified: securities dismissed on common enterprise; **RICO survives against Baton and founders Cohen, Kerler, Tweedale**; KOL Does dismissed under Rule 4(m); Solana entities cleared.
- ***United States v. Storm***, No. 1:23-cr-00430 (S.D.N.Y.). Convicted 6 Aug. 2025 on § 1960 conspiracy; hung on ML and IEEPA. Rule 29 argued 9 Apr. 2026, **ruling deferred**. **Dkt. #300 (25 Aug. 2026): retrial adjourned to 26 April 2027.** ✅ Verified.
- ***United States v. Goklu***, 2d Cir. No. 24-767 (filed 7 Apr. 2026). ✅ Case verified real and published. ⚠️ Reporter cite (173 F.4th 16) and holding unverified.
- ***Risley v. Universal Navigation Inc.***, No. 23-1340-cv (2d Cir. 26 Feb. 2025) — **non-precedential summary order.**
- ***Intuit, Inc. v. FTC***, No. 24-60040 (5th Cir. **20 Mar. 2026**) — ✅ Verified: FTC in-house adjudication of deceptive advertising unconstitutional under *Jarkesy*; order **VACATED**. Narrows the ALJ forum, not district-court suits.
- ***Paschall v. Commissioner***, T.C. Memo. **2026-46**, Dkt. No. 7382-24 (4 June 2026) (Pugh, J.) — ✅ Verified. $33,354 staking rewards, eToro, pro se. Rests on § 61 and *Glenshaw Glass*, expressly **not** on Rev. Rul. 2023-14.
- *Sarcuni v. bZx DAO*, 664 F. Supp. 3d 1100 (S.D. Cal. 27 Mar. 2023); *Samuels v. Lido DAO*, No. 3:23-cv-06492-VC (N.D. Cal. 18 Nov. 2024).
- *Revak v. SEC Realty Corp.*, 18 F.3d 81, 87 (2d Cir. 1994); *In re J.P. Jeanneret Assocs.*, 769 F. Supp. 2d 340, 359-60 (S.D.N.Y. 2011); *SEC v. Telegram*, 448 F. Supp. 3d 352, 365 (S.D.N.Y. 2020); *SEC v. Barry*, 146 F.4th 1242 (9th Cir. 2025); *Donovan v. GMO-Z.com Tr. Co.*, 779 F. Supp. 3d 372, 388 (S.D.N.Y. 2025).
- *Hurlock v. Kelsier Labs LLC*, No. 1:25-cv-03891-JLR (S.D.N.Y. filed 19 Apr. 2025, am. 29 July 2025) — BVI-domiciled Meteora in SDNY.

### FTC

- **FTC v. Celsius / Mashinsky, Leon, Goldstein** — complaint 13 July 2023; **founders ordered to pay $16.5M, 20 July 2026.** ✅ Verified: "as high as 18% annual percentage yield" pleaded as deception.
- **FTC v. Voyager / Ehrlich** — settled **27 June 2025**, $2.8M + lifetime crypto-marketing ban, 3-0 vote.
- **16 CFR Part 465**, Trade Regulation Rule on Consumer Reviews and Testimonials, 89 Fed. Reg. 68034 (22 Aug. 2024), **effective 21 Oct. 2024**. §§ 465.1(c)(4), 465.1(c)(7), 465.2, 465.4, 465.5, 465.8.
- **16 CFR Part 255**, Endorsement Guides, effective 26 July 2023.
- Civil penalty adjustment: **$53,088**, 90 Fed. Reg. 5580 (17 Jan. 2025); indexed annually.
- ⚠️ FTC Earnings Claim Rule (proposed 13 Jan. 2025) — **status unconfirmed**; no final rule located, no withdrawal notice located.

### BSA / money transmission

- **FIN-2019-G001**, *Application of FinCEN's Regulations to Certain Business Models Involving CVCs* (9 May 2019) — §§ 4.2, 4.2.2, 4.4, 4.5.1(b), 5.1, 5.2.2, 5.2.3. Still operative.
- 31 CFR § 1010.100(ff); 18 U.S.C. § 1960; 31 U.S.C. § 5330; 31 CFR § 1022.380.
- **DOJ, DAG Blanche, *Ending Regulation By Prosecution*** (7 Apr. 2025) — fn. 1 (no enforceable rights); **fn. 2 (excludes § 1960(b)(1)(C))**.
- Treasury, *Illicit Finance Risk Assessment of DeFi* (Apr. 2023) — never withdrawn.
- President's Working Group, *Strengthening American Leadership in Digital Financial Technology* (30 July 2025), pp. 105-08.

### OFAC

- **OFAC Enforcement Release, Exodus Movement, Inc.** (16 Dec. 2025) — ✅ Verified: **$3,103,360**; 254 apparent violations of 31 CFR 560.204; base $242,000 → $4,774,400; 12 egregious VPN support messages; ToS + self-certification held insufficient.
- **OFAC Enforcement Release, ShapeShift AG** (22 Sept. 2025) — $750,000; US person via Denver HQ and US engineers; IP as "only available indicator."
- OFAC, *Sanctions Compliance Guidance for the Virtual Currency Industry* (15 Oct. 2021).
- *Van Loon v. Dep't of the Treasury*, No. 23-50669 (5th Cir. 26 Nov. 2024); delisting 21 Mar. 2025; Amended Final Judgment, No. 1:23-cv-312-RP, Dkt. 111 (W.D. Tex. 28 Apr. 2025).
- Syria: **E.O. 14312 (30 June 2025, eff. 1 July 2025)**; SSR removed from CFR 26 Aug. 2025.
- 31 CFR §§ 501.603, 501.604; recordkeeping 5→10 years, 90 Fed. Reg. 13286 (21 Mar. 2025).

### State

- **Cal. Fin. Code Div. 1.25 (DFAL)**, §§ 3102, 3103, 3201 — operative **1 July 2026**. **SB 97, Ch. 52 (signed 30 June 2026, urgency)** — ✅ Verified: § 3102(c)(1) control definition with fraud-only proviso; § 3103(b)(13) uncompensated-person exemption. DFPI regulations effective **29 June 2026** (10 CCR Subch. 5 §§ 1200-1250).
- **23 NYCRR Part 200**, §§ 200.2, 200.3(c). NYDFS Industry Letter, *Rapidly Proliferating, Sentiment-Based Virtual Currencies* (16 Jan. 2025). NY S.8901, introduced 14 Jan. 2026 (in committee).
- NY OAG, Statement for the Record to Senate PSI (**27 July 2026**).
- CSBS Model MTMA and April 2026 legislative update; Wyoming W.S. 17-31-101 *et seq.* (DAO LLC) and W.S. 17-32-101 *et seq.* (DUNA, eff. 1 July 2024).

### Tax

- **Public Law 119-5**, 139 Stat. 48 (10 Apr. 2025) — CRA disapproval of the DeFi broker rule (TD 10021, 89 Fed. Reg. 106928); CFR removal at **90 Fed. Reg. 30825 (11 July 2025)**.
- **TD 10000**, 89 Fed. Reg. 56480 (9 July 2024) — custodial broker rule; **§ 1.6045-1(a)(1) redemption trigger survives.**
- **Notice 2024-57**, IRB 2024-29 (15 July 2024) — §§ 3.03(2), 3.04(2) reservation. ⚠️ Exact reservation language not independently verified.
- **Notice 2025-33** (11 June 2025) — backup withholding waiver, **scoped to § 6045 by its own title.**
- Rev. Rul. 2023-14 (fn. 3 reserves § 83); CCM 202444009 (10 Oct. 2024).
- OBBBA, Pub. L. 119-21 § 70433 (4 July 2025) — § 6041 threshold **$600 → $2,000** for payments after 31 Dec. 2025.
- Treas. Reg. §§ 1.6041-1(c), 1.6041-1(e), 1.451-2(a); 26 U.S.C. §§ 3403, 3406, 6041, 6050N, 6656, 6721, 6722.

### Legislation (not law as of 2 September 2026)

- **H.R. 3633, Digital Asset Market Clarity Act** — House passed 294-134 (17 July 2025); Senate Banking reported 15-9 (14 May 2026); cloture filed 8 Aug. 2026; procedural vote reported for ~15 Sept. 2026. **NOT ENACTED.**
- GENIUS Act, Pub. L. 119-27, 139 Stat. 419 (July 2025) — payment stablecoins only.
- S. 3611, Blockchain Regulatory Certainty Act of 2026 (12 Jan. 2026) — in Senate Banking.

### Comparable venue practice (⚠️ read from live pages; not independently re-verified)

Uniswap Labs ToS (28 July 2026), § 1.7 Earn APY clause and Unsupported Token Policy; interface fee **0% as of 27 Dec. 2025**. Aave ToS (6 Jan. / 14 Aug. 2026). Curve / Swiss Stake AG legal + risk pages (16 June 2026). Jupiter ToS (Block Raccoon S.A., Panama — **excludes US wallets**). Kamino ToS (StroudGlobal S.A., 7 Aug. 2026 — excludes US, UK, Panama persons) and the live **"Include KMNO Rewards in APY"** toggle. Meteora ToS (Meteora Nova Ltd., BVI — excludes US and BVI). Raydium disclaimer (click-through gate, excludes USA).

---

*Prepared 2 September 2026. Every posture described here can change without notice — the March 2026 interpretation is an interpretive rule withdrawable without notice and comment, the Blanche memo is revocable charging policy, and the § 1960 question is undecided with a retrial set for April 2027. Re-verify before launch, and do not launch without counsel.*"
  },
  "workflowProgress": [
    {
      "type": "workflow_phase",
      "index": 1,
      "title": "Research"
    },
    {
      "type": "workflow_phase",
      "index": 2,
      "title": "Challenge"
    },
    {
      "type": "workflow_phase",
      "index": 3,
      "title": "Synthesize"
    },
    {
      "type": "workflow_agent",
      "index": 1,
      "label": "res:sec-staking",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "a2b329421292679cc",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788337285676,
      "queuedAt": 1788337284081,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "sec-staking — SEC / federal securities law as applied to st…",
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788338094054,
      "tokens": 173080,
      "toolCalls": 73,
      "durationMs": 808377,
      "resultPreview": "{"area":"sec-staking — SEC / federal securities law as applied to staking and yield programs (custodial staking-as-a-service, protocol staking, and promoter-funded DeFi yield). Research current as of 2 September 2026. NOT LEGAL ADVICE — I am not a lawyer. Everything below is a description of what primary documents say, what the enforcement record shows, and what remains contested. Nothing here say…"
    },
    {
      "type": "workflow_agent",
      "index": 2,
      "label": "res:howey-efforts",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "a0b568f4e5a611987",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788337285839,
      "queuedAt": 1788337284081,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "howey-efforts — The Howey "efforts of others" (third) prong…",
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788338122666,
      "tokens": 154309,
      "toolCalls": 68,
      "durationMs": 835901,
      "resultPreview": "{"area":"howey-efforts — The Howey \"efforts of others\" (third) prong applied to a non-custodial LP farm where the operator funds the reward treasury, sets a fixed daily emission rate, runs a keeper, and advertises APR on its own frontend.","currentPosture":"NOT LEGAL ADVICE. I am not a lawyer. What follows is what the primary documents say, what the enforcement and litigation record shows, and w…"
    },
    {
      "type": "workflow_agent",
      "index": 3,
      "label": "res:memecoin-status",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "ae23ac5b8eb2f28cd",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788337285734,
      "queuedAt": 1788337284081,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "memecoin-status — the regulatory status of memecoins under …",
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788338154759,
      "tokens": 166592,
      "toolCalls": 64,
      "durationMs": 867995,
      "resultPreview": "{"area":"memecoin-status — the regulatory status of memecoins under US federal securities law, and whether that status changes when a memecoin is (a) staked for yield funded by a promoter treasury or (b) paired in an LP whose fees accrue to a creator; plus the pump.fun launch model and litigation.","currentPosture":"NOT LEGAL ADVICE. I am not a lawyer. Below is what the primary documents say, what…"
    },
    {
      "type": "workflow_agent",
      "index": 4,
      "label": "res:fincen-mt",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "adaab4435f7dfa523",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788337285873,
      "queuedAt": 1788337284082,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "FinCEN / Bank Secrecy Act / money transmission (18 U.S.C. §…",
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788338472897,
      "tokens": 172839,
      "toolCalls": 79,
      "durationMs": 1186132,
      "resultPreview": "{"area":"FinCEN / Bank Secrecy Act / money transmission (18 U.S.C. § 1960, 31 U.S.C. § 5330, 31 C.F.R. ch. X) as applied to a non-custodial swap + staking + LP-farming venue with a US nexus","currentPosture":"NOT LEGAL ADVICE. I am not a lawyer. What follows is what the primary sources say, what the enforcement record shows, and what is contested.\
\
**The operative federal rule has not changed si…"
    },
    {
      "type": "workflow_agent",
      "index": 5,
      "label": "res:state-mtl",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "ab09aa97e99e1fbee",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788337285689,
      "queuedAt": 1788337284082,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "state-mtl — State money transmitter licensing, the NYDFS Bi…",
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788338185607,
      "tokens": 147102,
      "toolCalls": 82,
      "durationMs": 898845,
      "resultPreview": "{"area":"state-mtl — State money transmitter licensing, the NYDFS BitLicense (23 NYCRR Part 200), California's Digital Financial Assets Law (DFAL, operative 1 July 2026), and state-level DeFi-specific rules, as applied to a US-connected non-custodial swap / staking / LP-farm / NFT venue. Verified against primary sources as of 2 September 2026. NOT LEGAL ADVICE — I am not a lawyer. Nothing below sa…"
    },
    {
      "type": "workflow_agent",
      "index": 6,
      "label": "res:tax-broker",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "a30c1fdfff670db0f",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788337285732,
      "queuedAt": 1788337284082,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "tax-broker — IRS information reporting (§§6045, 6041, 6049,…",
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788338247588,
      "tokens": 161076,
      "toolCalls": 82,
      "durationMs": 960825,
      "resultPreview": "{"area":"tax-broker — IRS information reporting (§§6045, 6041, 6049, 6050N, 3406), Form 1099-DA, the TD 10000 / TD 10021 split, the 2025 Congressional Review Act repeal of the DeFi front-end rule, and the income character and timing of staking / farming rewards. Verified against primary sources as of 2 September 2026. NOT LEGAL ADVICE — I am not a lawyer. What follows is what the documents say, wh…"
    },
    {
      "type": "workflow_agent",
      "index": 7,
      "label": "res:ofac-sanctions",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "a295d7a6e32444755",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788337285699,
      "queuedAt": 1788337284082,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "OFAC sanctions compliance for a US-connected, self-custodia…",
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788338443139,
      "tokens": 170927,
      "toolCalls": 82,
      "durationMs": 1156376,
      "resultPreview": "{"area":"OFAC sanctions compliance for a US-connected, self-custodial DeFi frontend — wallet/address screening, IP and jurisdiction blocking, and what the Tornado Cash litigation actually settled (and did not settle). Scoped to memetics.finance / memetic.fun: swap routing (Jupiter on Solana, EVM aggregators), single-sided staking (Streamflow on Solana; operator's own contracts on Ethereum/Base), t…"
    },
    {
      "type": "workflow_agent",
      "index": 8,
      "label": "res:promotion-ads",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "a24a4a789f8125bcb",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788337285841,
      "queuedAt": 1788337284082,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "promotion-ads — APR/APY display, yield projections, "guaran…",
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788338145000,
      "tokens": 151337,
      "toolCalls": 67,
      "durationMs": 858235,
      "resultPreview": "{"area":"promotion-ads — APR/APY display, yield projections, \"guaranteed\"-return language, influencer/affiliate touting (Securities Act §17(b)), and FTC deceptive-advertising exposure","currentPosture":"NOT LEGAL ADVICE. I am not a lawyer. Below is what the rules say, what enforcement shows, and what is contested, as of 2026-09-02.\
\
THE HEADLINE: securities-registration risk for crypto fell sh…"
    },
    {
      "type": "workflow_agent",
      "index": 9,
      "label": "res:entity-structure",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "a71cd9003dcedf92f",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788337285793,
      "queuedAt": 1788337284082,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Entity structure and personal-liability exposure for a solo…",
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788338241906,
      "tokens": 155486,
      "toolCalls": 75,
      "durationMs": 955142,
      "resultPreview": "{"area":"Entity structure and personal-liability exposure for a solo, US-based DeFi venue operator (memetics.finance / memetic.fun) — DAO liability doctrine (CFTC v. Ooki DAO and the general-partnership line of cases), the Wyoming DAO LLC and DUNA statutes and their 2026 copycats, offshore foundation structures, and what each actually does and does not do against US regulators and private plaintif…"
    },
    {
      "type": "workflow_agent",
      "index": 10,
      "label": "res:comparables",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "ae523c77a38459059",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788337285773,
      "queuedAt": 1788337284082,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Comparables — the live compliance surface of established De…",
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788338221447,
      "tokens": 180104,
      "toolCalls": 76,
      "durationMs": 934683,
      "resultPreview": "{"area":"Comparables — the live compliance surface of established DeFi frontends serving or excluding US users, observed September 2026. Covers Uniswap, Aave, Curve, Jupiter, Kamino, Raydium, Orca, Meteora across seven dimensions: terms of service, entity domicile, geo-blocking, wallet/token screening, APR/APY display and caveats, disclaimers, and regulatory/litigation record.\
\
METHOD AND ITS LI…"
    },
    {
      "type": "workflow_agent",
      "index": 11,
      "label": "challenge:facts",
      "phaseIndex": 2,
      "phaseTitle": "Challenge",
      "agentId": "a56b36dfc2c441f13",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788338478843,
      "queuedAt": 1788338474706,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "D="/c/Users/jimbo/AppData/Local/Temp/claude/C--Users-jimbo-…",
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788339770737,
      "tokens": 357794,
      "toolCalls": 55,
      "durationMs": 1291893,
      "resultPreview": "Verification complete. Findings below.

---

# FACT-CHECK REPORT — 10 crypto-regulatory research reports
**Method:** Primary sources retrieved and grepped locally (not via summarization). Full text of Rel. 33-11412 (170KB, 149 footnotes) and Reg CA (795KB) downloaded from federalregister.gov; dockets from CourtListener; opinions from ca5.uscourts.gov and irs.gov; OFAC/FTC releases direct; existenc…"
    },
    {
      "type": "workflow_agent",
      "index": 12,
      "label": "challenge:prosecution",
      "phaseIndex": 2,
      "phaseTitle": "Challenge",
      "agentId": "a4e43de9f8093c416",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788338481228,
      "queuedAt": 1788338474708,
      "attempt": 1,
      "lastToolName": "mcp__ccd_session__mark_chapter",
      "lastToolSummary": "Adversarial regulator case",
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788338674200,
      "tokens": 242774,
      "toolCalls": 1,
      "durationMs": 192162,
      "resultPreview": "## THE PROSECUTION CASE

*Not legal advice. I am not a lawyer. This is an adversarial exercise: I am arguing one side deliberately, and arguing it as hard as the record supports. Nothing here is a prediction that you will be charged, and nothing here says the government would win. It is the brief that would be written against you, so you can see what it looks like before someone else writes it.*

…"
    },
    {
      "type": "workflow_agent",
      "index": 13,
      "label": "synthesize:briefing",
      "phaseIndex": 3,
      "phaseTitle": "Synthesize",
      "agentId": "a87f2397b24866015",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788339779806,
      "queuedAt": 1788339776106,
      "attempt": 1,
      "promptPreview": "WHO IS ASKING. The operator runs memetics.finance / memetic.fun — a
self-custodial DeFi venue. Users connect their own wallet; the venue never
takes custody. Surfaces: token swaps (routed through Jupiter on Solana and
aggregators on EVM), single-sided token staking, LP farming, and an NFT
marketplace. Tokens are community memecoins (the flagship, BAYLA, is a
pump.fun-graduated Token-2022 memecoin)…",
      "lastProgressAt": 1788340119335,
      "tokens": 254620,
      "toolCalls": 0,
      "durationMs": 339526,
      "resultPreview": "**PREPARED FOR THE OPERATOR OF memetics.finance / memetic.fun — 2 September 2026**

---

> ## ⚠️ THIS IS NOT LEGAL ADVICE
>
> I am not a lawyer. Nothing in this document says that any product, design, or decision is *compliant*, *legal*, or *safe*. What follows is a description of what primary sources say, what the enforcement record shows, which facts regulators and courts have treated as decisiv…"
    }
  ],
  "totalTokens": 2488040,
  "totalToolCalls