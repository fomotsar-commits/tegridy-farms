# Community Launch Playbook

How to stand up the four public-facing channels Tegridy Farms will operate from — Discord, Twitter/X, Telegram, and GitHub Discussions — in the right order, with channel structures + first-message templates so nothing goes live half-finished.

**Philosophy:** every public surface the protocol opens is a commitment to respond to DMs, moderate content, and sustain output. Open channels only when you can staff them. This doc scaffolds all four, but you can ship them in waves.

---

## Recommended launch order

1. **GitHub Discussions** — free, low-moderation, already the canonical channel per README. Enable it first, takes 30 seconds.
2. **Twitter / X** — broadcast voice. One-way-ish, minimal moderation cost.
3. **Discord** — community ops + governance. Highest ongoing effort; stand up only when the above are pulling signal.
4. **Telegram** — real-time chat. Last because it fragments community with Discord if both are active.

Each section below has a go/no-go checklist + copy-paste scaffolding.

---

## 1. GitHub Discussions (ship today, 5 min)

### Enable

1. Go to https://github.com/fomotsar-commits/tegridy-farms/settings
2. Scroll to **Features** section
3. Tick **Discussions**
4. Click **Set up discussions**

### Categories (recommended)

Create four:
- **🟣 Announcements** (announcement format, admin-only to start threads)
- **🗣️ General** (open discussion)
- **💡 Ideas & feedback** (bug reports that aren't security-critical; feature requests)
- **🙋 Q&A** (question / answer format, community self-answers)

### Welcome post template

Paste this as the first pinned thread under Announcements:

> **Welcome to the Tegridy Farms GitHub Discussions**
>
> This is the canonical channel for the protocol until we stand up Discord / Twitter / Telegram. Good-faith questions, feature ideas, and feedback are welcome here.
>
> **Before posting:**
> - Security vulnerability? **Do not post here.** Email `security@tegridyfarms.xyz` — see [SECURITY.md](../SECURITY.md) for the disclosure process and bounty tiers.
> - Read the [README](../README.md) and [FAQ](../FAQ.md) first.
>
> **What the team will answer:**
> - Protocol mechanics, contract behaviour, deploy status
> - Roadmap + timelines
> - Anything under [AUDITS.md](../AUDITS.md)
>
> **What the team won't answer:**
> - Price predictions, "wen moon," financial advice
> - Personal wallet / tx support — use Etherscan and your wallet provider
>
> **Response SLA:** 48h on weekdays. Weekends are best-effort.

### README update (after enabling)

The README already links `../../discussions` as the canonical channel. Once enabled, that link becomes live. No README edit needed.

### Moderation rules

Pinned in the Discussions sidebar or README:
- No financial advice
- No airdrop / airdrop-farming prompts
- No DM solicitation from "admins" — real team never DMs first
- Rule-breakers get one warning, then banned. No appeals unless via email.

---

## 2. Twitter / X (ship when handle secured, 30 min)

### Register the handle

Desired handles in priority order (grab the first one available):
- `@tegridyfarms`
- `@farmwithtegridy`
- `@tegridyxyz`
- `@toweli_farms`

### Bio draft (under 160 chars)

> DeFi yield protocol on Ethereum. Stake TOWELI, earn 100% of swap fees as real ETH. Fixed supply. Audited. tegridyfarms.xyz

Pinned bio fields:
- **Location:** `onchain`
- **Website:** `https://tegridyfarms.xyz`
- **Join date:** public
- **Header image:** use `frontend/public/og.png` (rendered from the SVG banner)
- **Avatar:** 400×400 crop of the shield glyph from `docs/banner.svg`

### First 5 tweets (schedule over 3 days)

**Tweet 1 — launch**
> We're live.
>
> Tegridy Farms: a DeFi yield protocol on Ethereum where every basis point of swap fees flows to stakers. Fixed-supply TOWELI. Real yield.
>
> No inflation. No emissions tricks.
>
> 🌾 tegridyfarms.xyz
> 📖 github.com/fomotsar-commits/tegridy-farms

**Tweet 2 — audit**
> Tegridy Farms has gone through 7 rounds of security review producing 14 audit artifacts — every single one is published on GitHub.
>
> 300-agent full-stack audit.
> External Spartan audit.
> Ingested into the canonical severity reference.
>
> github.com/fomotsar-commits/tegridy-farms/blob/main/AUDITS.md

**Tweet 3 — mechanic**
> Here's how the yield loop works:
>
> 1. User swaps TOWELI on the native DEX
> 2. SwapFeeRouter takes protocol fee
> 3. RevenueDistributor receives 100%
> 4. Stakers earn pro-rata ETH
>
> Fees never dilute. The 1B TOWELI supply is fixed. Staked TOWELI is an ERC-721 — collateralisable, portable.

**Tweet 4 — boost**
> Lock TOWELI longer → get boosted LP farming rewards.
>
> 7 days → 0.4× boost ("The Taste Test")
> 90 days → 1.5× ("The Harvest Season")
> 1 year → 2.5× ("The Long Haul")
> 4 years → 4.0× ("Till Death Do Us Farm")
>
> Hold JBAC? +0.5× on top. Ceiling 4.5×.

**Tweet 5 — honest**
> Pinned caveat: the protocol has live mainnet TVL, but some working-tree patches aren't redeployed yet. Before you deposit anything serious, read FIX_STATUS.md:
>
> github.com/fomotsar-commits/tegridy-farms/blob/main/FIX_STATUS.md
>
> We don't hide open items.

### Response protocol

- Reply to tech questions in-thread with links to [README](../README.md) / [FAQ](../FAQ.md) / [AUDITS.md](../AUDITS.md).
- Never DM first. If someone DMs claiming to be team — it's a scammer. Pin this warning.
- Don't engage with "wen airdrop" replies. Mute, move on.
- Re-tweet coverage only after verifying the source.

### Hashtags to use sparingly

`#DeFi` `#Ethereum` `#YieldFarming` — max one per tweet.
Don't use `#crypto` (noise) or shill tags.

---

## 3. Discord (ship when moderators secured, 2–3h setup)

### Prerequisites

Discord needs at least 2 moderators active in different timezones. Without that, don't open it — an unstaffed Discord becomes a scammer playground within 48 hours.

### Server name

`Tegridy Farms`

### Channel structure

```
📢 INFO
├─ #welcome            (read-only, bot-managed rules)
├─ #announcements      (admin-only posting, community-read)
├─ #roadmap            (pinned ROADMAP.md + CHANGELOG.md updates)
└─ #security           (pinned SECURITY.md, Immunefi link)

💬 COMMUNITY
├─ #general            (main chat)
├─ #farming            (staking / boost / rewards talk)
├─ #governance         (gauge voting + bribes / Cartman's Market)
├─ #launchpad          (Drops + NFT lending questions)
└─ #off-topic          (not-crypto conversation with low mod)

🛠️ SUPPORT
├─ #support            (slow-chat Q&A, staff-answered)
├─ #bug-reports        (non-security bugs; security goes to email)
└─ #feedback           (product feedback, feature requests)

🔧 DEVELOPERS
├─ #devs               (integrators, wagmi / foundry questions)
├─ #contracts          (Solidity-specific)
└─ #frontend           (React / UI)

🧻 MEMES
└─ #memes              (Randy/Towelie/tegridy voice; the point of the protocol)
```

### Roles

| Role | Colour | Permissions |
|---|---|---|
| 🟣 Team | purple | Manage channels, pin, ban |
| 🧻 Moderator | gold | Timeout, delete, kick (not ban) |
| 🌾 Farmer | green | Verified wallet (proves ≥ X TOWELI staked via bot) |
| 🐛 Contributor | blue | Merged PR into the repo |
| 👋 Visitor | grey (default) | Send messages in #general, #support, #memes |

### Verification bot

Use Collab.Land or Guild.xyz to token-gate `#farming` / `#governance` / `#launchpad` to wallets with ≥ 1 TOWELI staked in TegridyStaking. Keeps noise + scammers out of the substantive channels.

### Welcome bot message

Triggered on new-member join:

> Welcome to Tegridy Farms, @user.
>
> **Before posting, please:**
> - Read the pinned rules in #welcome
> - Never respond to DMs from "admins" — we never DM first
> - Security bugs → email `security@tegridyfarms.xyz`, not Discord
>
> **If you're here to learn:** #roadmap and pinned links in #general.
> **If you're here to contribute:** react with 👋 in #welcome to unlock the full channel list.

### Scam / spam policy

- Auto-ban any member whose first message contains `airdrop`, `claim`, `connect wallet`, `dm me`
- Role-lock DMs between `👋 Visitor` and `🟣 Team`
- Delete any link shortener (bit.ly, tinyurl) automatically
- Publish a permabanned scammer-wallet list for the bot to block

### Moderator SLAs

- Visible online: 16h/day across timezones (two mods in opposite hemispheres)
- Response to flagged messages: < 30 min during active hours
- Nightly review of flagged content: 5 min skim

---

## 4. Telegram (ship last, 15 min)

### Why last

Telegram fragments community if you also run Discord. Reserve it for (a) Eastern European / Asian user base, (b) users who prefer phone-native chat, (c) announcement mirror only. **Do not try to run two primary chat channels simultaneously** — pick one for real-time conversation and use the other for cross-posting announcements.

### Recommended role

**Announcement mirror only.** Don't open it for general chat — link users to Discord or GitHub Discussions for substantive conversation.

### Setup

1. Create channel: `Tegridy Farms Announcements`
2. Make it **public** with handle `@tegridyfarms`
3. Disable message forwarding (prevents scam replication)
4. Add 2 admins: you + one team member
5. Pin the first message linking to Discord + Twitter + GitHub Discussions as the real chat surfaces

### First pinned message

> 🌾 **Tegridy Farms** — announcements only.
>
> This channel mirrors protocol-level announcements. It is NOT the place for Q&A or support.
>
> Real conversation:
> - **GitHub Discussions** (substantive, canonical): https://github.com/fomotsar-commits/tegridy-farms/discussions
> - **Discord** (community chat, governance, farming): [invite link once live]
> - **Twitter / X** (broadcast + memes): [@tegridyfarms](https://twitter.com/tegridyfarms)
>
> ⚠️ **Scam warning:** We will NEVER DM you. We will NEVER ask for your private key, seed phrase, or wallet signature in this channel. Any DM claiming to be team support IS a scammer — report + block.

### Posting cadence

- Protocol milestones (redeploys, TVL milestones, incidents)
- Link each announcement to the full-context Twitter thread / GitHub discussion / release notes
- Do NOT duplicate every tweet here — curate

---

## After all four are live

### Update README

Replace the current "Community — we don't have channels yet" section with:

```markdown
## Community

- **GitHub Discussions:** [fomotsar-commits/tegridy-farms/discussions](../../discussions)
- **Discord:** [discord.gg/tegridyfarms](https://discord.gg/tegridyfarms)
- **Twitter / X:** [@tegridyfarms](https://twitter.com/tegridyfarms)
- **Telegram (announcements):** [@tegridyfarms](https://t.me/tegridyfarms)

- **Security disclosures:** see [SECURITY.md](SECURITY.md) — do NOT post security bugs in public channels
- **Contributions:** see [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
```

### Update FUNDING.yml

Replace the current treasury-only sponsor with the real channels:

```yaml
custom:
  - "https://tegridyfarms.xyz"
  - "https://discord.gg/tegridyfarms"
  - "https://twitter.com/tegridyfarms"
```

### Add social-preview links to Discord / Twitter / Telegram channels in `frontend/src/components/layout/Footer.tsx`

Currently empty under "Community" column — populate with real links.

---

## Moderation burn-out protection

Every public channel is a DM surface for scammers. Protect your mental health:

1. **Limit your own hours.** Set specific times each day you check DMs + community channels. Never 24/7.
2. **Delegate to mods.** The Discord structure above requires 2 mods — actually have them.
3. **Document decisions.** Every permaban should have a one-line reason in a private team channel so later mods don't undo it.
4. **Quarterly review.** Look at which channels actually generate value. Close ones that don't — shrinking the surface is legitimate.

---

## Metrics to watch (not to optimise)

- **GitHub stars** — vanity metric; don't chase
- **Discord members** — scammers inflate this; check DAU instead
- **Twitter followers** — real engagement is reply ratio, not raw count
- **Good metric:** unique wallets interacting with the protocol per week. That's real signal.

---

*Last updated: 2026-04-18.*
