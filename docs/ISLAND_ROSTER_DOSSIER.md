# Island roster dossier — the 12 token bungalows, read live 2026-08-25

*Market reads: Dexscreener token API, best pair by liquidity, 2026-08-25.
Addresses are the island canon (memetics.wtf SIGNSV2) and are pinned in
`frontend/src/lib/bungalows.ts` + its registry test. Purpose: the operator's
outreach pack for the art drops (task #16) and honest context for phase-2
per-bungalow economics. Numbers move; re-read before quoting externally.*

| Bungalow | Chain | MC | Liquidity | 24h vol | Community / links |
|---|---|---|---|---|---|
| **PEPE** | Ethereum | **$1.59B** | $28.3M | $1.58M | pepe.vip · @pepecoineth |
| **BNKR** (Bankr) | Base | $26.0M | $1.86M | $120k | bankr.bot · @bankrbot · Warpcast |
| **DRB** | Base | $13.1M | $1.21M | **$1.24M** | bio.site/drbtaskforce · X group chat |
| **BOBO** (Bobo the Bear) | Solana | $7.19M | $345k | $26k | bobothebear.io · bobomemes.com · @bobocouncil |
| **$mfer** (mfercoin) | Base | $693k | $214k | $4.4k | sartoshi's mirror essay · @sartoshi_rip |
| **BAYLA** | Solana | $578k | $65k | $11.5k | memetics.wtf · OpenSea junglebay · @JungleBayAC |
| **QR** | Base | $217k | $127k | $5.6k | qrcoin.fun · @qrcoindotfun |
| **BRAINLET** | Solana | $38k | $48k | $165 | @brainletbadger |
| **SOY** (Soyjak) | Solana | $17k | $18k | $284 | soyjak.life · @Soyjak_Solana |
| **TOWELI** | Ethereum | — | — | — | no Dexscreener-indexed pair (native pool ~$14; Uniswap pool below index size) |
| **JBM** | Base | — | — | — | no Dexscreener-indexed pair on 2026-08-25 |
| **RIZZ** | Base | — | — | — | no Dexscreener-indexed pair on 2026-08-25 |

The 13th spot is the island's unmarked QUIET bungalow ("Someone is
building here.") — no token, by design.

## Reading it

- **The island spans four orders of magnitude** — PEPE's $1.59B down to
  SOY's $17k. Skins are the same one-session recipe regardless of size, so
  outreach order is a community-warmth question, not a technical one.
- **DRB is the activity outlier**: $1.24M daily volume on a $13M cap —
  the most *alive* bungalow after PEPE, and its bungalow art (boxing-ring
  canon: "Der Bar enters the ring") is already in the app's classic set.
- **BOBO's status line on the island is "SETTLED · hammers up"** — the only
  bungalow the island singles out as actively building. Warm door.
- **Three tokens read dark on Dexscreener** (TOWELI, JBM, RIZZ — no indexed
  pair on read day). For TOWELI that's the known native-pool story; for
  JBM/RIZZ it means quoting "market cap" in outreach would be fiction —
  lead with the skin, not the chart.
- **Registry now carries a canon trade route for every settled bungalow**
  (dexscreener `<chain>/<ca>` for EVM — the island's own swapUrlFor
  fallback — and Jupiter deep links for Solana, matching Bayla's sign).
  They're dormant until each slot flips live; the in-venue `/solana?out=`
  preset takes over for Solana tokens wherever the venue fee surface is
  configured.

## Outreach shape per bungalow (for task #16)

The ask to each community is identical and small: **15–30 pieces of your
art** + a blessing. In exchange the bungalow gets: its own address
(memetics.finance/&lt;slug&gt; — the door already exists), the full venue
re-skinned in its art, a token-first hero + contract card, scanner
integration, and its trade route on every surface. The Bayla bungalow at
`/bayla` is the living demo.
