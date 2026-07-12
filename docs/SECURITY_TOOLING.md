# Tegridy Farms — Security & Ops Tooling Stack

Curated from two verified research passes (2026-07-12) for a **solo, security-first,
bootstrapped** Ethereum DeFi/NFT protocol on a **live token** with a hot deployer + Safe
multisig ops. Everything here was verified real + currently maintained.

Legend: **FREE** · **FREE-tier** · **$ paid** · ⚠ **key-touching / scope carefully** · 🧩 needs your action (account/key/hardware/browser — I can't do these for you).

---

## ✅ Wired in this repo (2026-07-12)

| What | Where | How to use |
|---|---|---|
| **security.txt** (RFC 9116 disclosure channel) | `frontend/public/.well-known/security.txt` | Deploys with the frontend → served at `https://tegridyfarms.vercel.app/.well-known/security.txt`. Verify it resolves after the next deploy. Swap the email for a dedicated `security@` alias when you have one. |
| **`@custom:security-contact`** on flagship contracts | `Toweli.sol`, `SwapFeeRouter.sol` | Renders a contact on Etherscan's verified-source page. Add the same one-liner to other entry contracts (Router, Staking, RevenueDistributor, NFT-AMM/lending) on their next edit. |
| **Flashbots / MEV-Blocker private send-paths** | `contracts/foundry.toml` → `[rpc_endpoints]` | `forge script … --rpc-url flashbots --broadcast --slow` for admin/deployer txs so they can't be sandwiched. Reads/nonce still use `mainnet`. |
| **SMTChecker formal-verification profile** (opt-in) | `contracts/foundry.toml` → `[profile.smtcheck.*]` | `FOUNDRY_PROFILE=smtcheck forge build` (CI, or a machine where build completes). Free formal layer, scoped to `Toweli`; widen `contracts` as you tune. |
| **VS Code extension recommendations** | `.vscode/extensions.json` | VS Code prompts to install Wake, Nomic Solidity, Solidity Visual Auditor, Solidity Metrics, Even Better TOML. |

---

## 🔜 Do-next checklist (ordered by risk-reduction per effort)

These need **your** browser / accounts / keys / hardware — I can't and shouldn't do them for you.

### 1. Flashbots Protect for the pending admin txs — **FREE, ~5 min** ⚠
Your queued single-signer txs (acceptOwnership ×8, deepen-LP into the ~0.02-WETH pool,
BootstrapTWAP) are public-mempool sandwich/arb bait **right now**. The RPC is already in
`foundry.toml` — just add `--rpc-url flashbots` to the broadcast. Docs: <https://docs.flashbots.net/flashbots-protect/quick-start>

### 2. Supabase Security Advisor (Splinter) — **FREE, minutes** 🧩
Your **backend is the single biggest un-audited live surface** (documented RLS pain: 008/009
migrations, 42501 role-grant gaps, anon-key rotation). An anon-key RLS bypass = full Postgres leak.
Supabase dashboard → **Advisors → Security**. Then run an adversarial anon-key probe before any go-live.
<https://supabase.com/docs/guides/database/database-advisors>

### 3. security.txt email + GitHub private vuln reporting — **FREE, minutes** 🧩
The file is committed. Verify it resolves post-deploy. If the repo is public, enable **Settings →
Code security → Private vulnerability reporting** and add that URL as a second `Contact:` line.
Save the **SEAL 911** break-glass contact NOW (before you need it): <https://securityalliance.org/our-work/seal-911>

### 4. Free CI trio — **FREE** (add the YAML below)
- **Sourcify** — closes the open "Etherscan verify pending" task on the 14 live contracts, verifier-independent (survives the Etherscan-key rotation):
  ```bash
  forge verify-contract <address> src/Toweli.sol:Toweli \
    --chain 1 --verifier sourcify --watch
  ```
- **Aderyn** (2nd static analyzer, SARIF → your Code Scanning tab) and **SMTChecker** — see the workflow snippet in the reference section. Both sidestep the local build hang.

### 5. Retire the hot deployer — **keystore FREE; Ledger ~$60–150** 🧩⚠
The most-repeated exposure in your own notes. Sequence with the 3-Safe rebuild + 8 acceptOwnership flushes.
```bash
cast wallet import deployer --interactive     # encrypts a key at rest (still keyloggable)
forge script … --account deployer --broadcast # signs from the keystore
forge script … --ledger --broadcast           # hardware = the real fix; key never on disk
```
<https://getfoundry.sh/guides/best-practices/key-management/>

### 6. Live monitoring + auto-pause — **FREE (self-host)** 🧩⚠
**OpenZeppelin Monitor** (OSS successor to Defender, which shuts down 2026-07-01 — do NOT build on
hosted Defender). Self-host on a $5 VPS; a trigger script reads pool reserves, computes TWAP-vs-spot
deviation, and POSTs your PauseGuardian path. This IS the arb-monitor + pool-depth watcher + auto-pause.
Start alert-only; add the pause trigger behind a **pause-only Guardian key on a separate box — never
the owner/deployer/treasury key.** <https://github.com/OpenZeppelin/openzeppelin-monitor>
Zero-effort complements: **Forta App** (free external watchtower) + **Alchemy Notify** (free webhook the
moment the deployer/Safe moves value).

### 7. Browser: isolate ops signing — **FREE + a hardware wallet** 🧩⚠
Do mainnet ops from a **separate Chrome profile** with a minimal, audited extension set, behind a
hardware wallet. Recommended installs (canonical Chrome Web Store links only — many phishing clones):
- **Rabby** (pre-sign balance/approval simulation) — <https://chromewebstore.google.com/detail/rabby-wallet/acmacodkjbdgmoleebolmdjonilkdbch>
- **Revoke.cash Sidekick** (approval hygiene; guards the inverted-spender bug class you hit) — <https://chromewebstore.google.com/detail/revokecash-web3-scam-prot/nmniboccheadcclilkfkonokbcoceced>
- **Tenderly Dev Toolkit** (dry-run admin calls on a fork from Etherscan) — <https://chromewebstore.google.com/detail/tenderly-dev-toolkit/miiolgcpknpjjfagkaddfgakbdenenfn>
- **Scam Sniffer** (site-level anti-phishing) — <https://chromewebstore.google.com/detail/scam-sniffer/mnkbccinkbalkmmnmbcicdobcmgggmfc>
- **Don't stack firewalls:** Rabby's built-in sim + Scam Sniffer is enough — more wallet-adjacent extensions = more attack surface.

### 8. Get external eyes cheaply — **mostly FREE** 🧩⚠
- **Hats Finance** — bounty denominated in your own TOWELI, pay-on-valid-finding (fund from multisig, a % you can afford). <https://app.hats.finance/vault>
- **SEAL Safe Harbor** — legal cover for whitehat rescue; pairs with PauseGuardian. <https://frameworks.securityalliance.org/safe-harbor/overview/>
- Defer **Sherlock/Cantina** ($5k–60k pot) to a per-feature graduation audit when a gated contract is deploy-bound.

### 9. Index once, stop hammering dead RPCs — **FREE/self-host** 🧩
**Ponder** → your existing Supabase Postgres; frontend queries your DB instead of the flaky roster
(fixes `eth_getLogs`-dead + dodges the Vercel 12-fn cap). Backfill with **dRPC** (free tier includes
`eth_getLogs`) or **Envio HyperRPC**. <https://github.com/ponder-sh/ponder>

### 10. Discoverability / trust — **FREE** 🧩
- **DefiLlama adapter** (canonical index page that publishes your fee/revenue story) — <https://docs.llama.fi/list-your-project/submit-a-project>
- **Bubblemaps** (self-audit holder concentration → fixes trust-copy drift) — <https://bubblemaps.io/>
- **Jupiter Referral + LP Agent** for Solana fee-capture visibility ⚠ (claiming signs from the fee-owner wallet — treat as a treasury key / Squads multisig).

### CI hardening (already partly done — you SHA-pin + least-priv)
- **StepSecurity Harden-Runner** (egress control on the runner that holds your secrets) — add `step-security/harden-runner` (audit mode) as the first step of each job. <https://github.com/step-security/harden-runner>
- **Socket** (malicious-npm behavior on dep changes — the 2025 account-takeover wave hits your wagmi/Vite tree). <https://github.com/SocketDev/action>
- Keep SHA-pinning every third-party action (you already do — R056).

---

## MCP servers (agent tooling) — add to a project `.mcp.json` when deps are installed

Read-only / safe first. **Foundry MCP is key-touching — Anvil / throwaway key ONLY, never a funded key.**

```jsonc
{
  "mcpServers": {
    "semgrep":  { "command": "uvx", "args": ["semgrep-mcp"] },                 // SAST incl. the React/viem frontend
    "tenderly": { "type": "http", "url": "https://mcp.tenderly.co/mcp" },       // simulate deployer/Safe calldata on a fork (OAuth)
    "etherscan":{ "type": "http", "url": "https://mcp.etherscan.io" }           // ⚠ needs your Etherscan key — keep it out of committed config (env only)
    // "foundry": key-touching — configure locally against Anvil only, never commit a funded key
  }
}
```
Also available first-party (already in your harness, underused): `mcp-builder` (build a **Tegridy on-chain MCP** so sessions read live TOWELI/pool/TWAP directly), `skill-creator` (codify your audit/go-live runbooks), `schedule` (cloud arb-monitor), `/security-review`, `deep-research`.

## Aderyn advisory CI workflow (add as `.github/workflows/aderyn.yml`)

Advisory-only (never gates a merge). Pin `upload-sarif` to a SHA per your R056 convention before committing:
```yaml
name: Aderyn (advisory)
on:
  push: { branches: [main, mvp-launch], paths: ["contracts/src/**", ".github/workflows/aderyn.yml"] }
  pull_request: { branches: [main, mvp-launch], paths: ["contracts/src/**"] }
permissions: { contents: read, security-events: write }
concurrency: { group: aderyn-${{ github.ref }}, cancel-in-progress: true }
jobs:
  aderyn:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332 # v4.1.7 (matches your pin)
        with: { submodules: recursive }
      - name: Install Aderyn
        run: cargo install aderyn --locked
      - name: Run Aderyn (SARIF)
        continue-on-error: true
        working-directory: contracts
        run: aderyn . --output aderyn.sarif || aderyn . --output aderyn.json
      - name: Upload SARIF
        continue-on-error: true
        uses: github/codeql-action/upload-sarif@<PIN-A-SHA> # v3
        with: { sarif_file: contracts/aderyn.sarif, category: aderyn }
```

---

## Reference catalog (both passes, grouped)

### Signing safety / wallet (Chrome)
Rabby · Revoke.cash Sidekick · Tenderly Dev Toolkit · Scam Sniffer · (2nd opinion, pick one: Kerberus Sentinel3). **Already have:** MetaMask Blockaid alerts, React DevTools.

### Monitoring & incident response
OpenZeppelin Monitor (FREE self-host) · Forta App (FREE) · Alchemy Notify (FREE-tier) · Tenderly Alerts (FREE-tier; Web3 Actions = $) · SEAL 911 (FREE) · BlockSec Phalcon / Hypernative ($ — defer).

### Security testing (all FREE, Foundry+CI-native)
SMTChecker (a foundry.toml flag) · Aderyn (SARIF) · Medusa (invariant fuzz) · Halmos (bounded proofs) · ItyFuzz (fork-mode fuzz of live contracts) · 4naly3er / Wake (extra detectors). Plus your existing Slither/gitleaks/CodeQL.

### MEV & RPC infra
Flashbots Protect (FREE) · MEV Blocker (FREE) · dRPC (FREE, has getLogs) · Envio HyperRPC (FREE-tier) · Ponder self-host indexer · QuickNode/Chainstack free archive (redundant endpoint).

### Getting audited (bootstrapped)
`@custom:security-contact` + security.txt (done) · SEAL 911 · Hats Finance (own-token bounty) · SEAL Safe Harbor · Immunefi (pay-on-results) · Sherlock/Cantina ($ — defer).

### Claude Code skills / plugins
Trail of Bits `Building Secure Contracts` (`/plugin marketplace add trailofbits/skills`) · Pashov Audit Group skills (`fizz` fuzz-gen) · VoltAgent subagents · wshobson `solidity-security`. Built-in & underused: `/security-review`, `skill-creator`, `mcp-builder`, `schedule`, `loop`, `deep-research`, `dataviz`. ⚠ Skip auto-installing `dwarvesf/claude-guardrails` (~26★, runs bash on every tool call) — the safe equivalent is a local pre-commit `gitleaks` hook.

### MCP servers
Tenderly · Etherscan (⚠ key) · Semgrep · Safe (⚠ community, read-only) · Foundry (⚠ Anvil only) · Alchemy / Nodit (data).

### Analytics / dashboards
DefiLlama adapter · Bubblemaps · Dune · Jupiter Referral + LP Agent (Solana). Frontend: RainbowKit (self-hosted, minimal-surface) over Reown AppKit (hosted).

### IDE (VS Code — wired via `.vscode/extensions.json`)
Wake (Ackee) · Solidity by Nomic · Solidity Visual Auditor · Solidity Metrics · Even Better TOML.

---

## Honesty flags

- **FREE + high-leverage:** Flashbots, MEV Blocker, dRPC, OZ Monitor, Forta, Alchemy Notify, SMTChecker, Aderyn, Medusa, Halmos, ItyFuzz, Ponder (~$5/mo host), the 5 VS Code extensions, DefiLlama adapter, Bubblemaps, security.txt, SEAL 911/Safe Harbor, Hats (own-token), Supabase Advisor, Sourcify, Harden-Runner, Socket, Foundry keystore.
- **Touch keys / scope tightly:** any auto-responder (OZ Relayer, Phalcon, Safe Harbor), Hats vault funding, Jupiter referral claim, Foundry MCP, keystore/Ledger. **Every auto-responder binds to a pause-only Guardian role on a separate box — never owner/deployer/treasury.**
- **Paid / defer-until-revenue:** BlockSec Phalcon, Hypernative, Sherlock/Cantina, Tenderly Web3 Actions, QuickNode Build ($49), Reown Pro.
- **Unaudited / low-star — read before installing:** dwarvesf/claude-guardrails, 4naly3er, community subagent collections. Prefer reputable publishers (OZ, ToB/crytic, a16z, Cyfrin, Ackee, Nomic, SEAL, Supabase, StepSecurity, Socket, Flashbots) for anything security- or key-adjacent.
