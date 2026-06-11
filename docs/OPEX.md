# OPEX — Off-Chain Operating Cost Ledger (2026-06-11)

The self-sustain bar (decided 2026-06-07): **cover off-chain opex from ETH fees** (NFT
marketplace + swap front-door) before deploying any ETH-outflow feature. This doc is the
denominator of that bar: every recurring dependency, what it costs, what breaks when it
lapses, and how the operator would notice. Sources: env usage across `frontend/api/*.js`,
`frontend/src/lib/`, `frontend/api/_lib/push.js`, `frontend/api/SERVERLESS_BUDGET.md`,
`.github/workflows/`.

> Prices are list prices as of writing — re-verify at upgrade time. "Today" = current
> scale: ~1,092 TOWELI holders, ~$266/day pool volume, modest marketplace traffic.

## Dependency ledger

### 1. Alchemy (`ALCHEMY_API_KEY`, optional `ALCHEMY_API_KEY_FALLBACK`)
| | |
|---|---|
| Used by | `api/alchemy.js` (NFT data + RPC proxy), `api/v1/index.js`, `_lib/seaport-verify.js` (order-create verification), `api/orderbook.js` (fill receipt checks) |
| Free tier | ~300M compute units/mo; current traffic fits with large headroom (per-IP caps: 60/min alchemy, 20/min v1) |
| Paid threshold | Growth ~$49/mo when CUs exceed free tier |
| Today | $0 |
| Breaks on lapse | NFT marketplace data dark (galleries, floor, sales, holders); order create/fill verification 503. **Mitigated (RESIL-1, 2026-06-11):** one-shot retry with `ALCHEMY_API_KEY_FALLBACK` on 401/403/429/5xx in all three consumers + `seaport-verify` `eth_call`s degrade to public RPCs. The NFT REST API has no public-RPC equivalent — a dual-key lapse still darkens galleries |
| Detection | Synthetic monitor probe 2 (floor price) → `prod-incident` issue within 30 min |

### 2. OpenSea API (`OPENSEA_API_KEY`)
| | |
|---|---|
| Used by | `api/opensea.js`, `api/v1` `listings` route |
| Free tier | Key is free (application-gated); no payment to lapse, but keys get revoked for inactivity/abuse |
| Today | $0 |
| Breaks on lapse | External (OpenSea) listings/offers vanish; native orderbook unaffected. Most v2 endpoints reject keyless calls |
| Detection | **None — gap.** Marketplace silently shows native-only listings |

### 3. Etherscan API (`ETHERSCAN_API_KEY`)
| | |
|---|---|
| Used by | `api/etherscan.js` (tx history, ABI/source lookups) |
| Free tier | 5 req/s, 100k req/day — proxy throttles to 30/min/IP, fits easily |
| Paid threshold | ~$199/mo (not plausibly needed) |
| Today | $0 |
| Breaks on lapse | History page empty; ABI lookups fail |
| Detection | **None — gap.** Note: rotating the leaked read-only key is the top item on the canonical pending-tasks list — rotation will lapse the old key by design; update the Vercel env in the same pass |

### 4. Supabase (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `VITE_SUPABASE_*`)
| | |
|---|---|
| Used by | `api/orderbook.js` (native_orders, trade_offers), `api/supabase-proxy.js` (messages, DMs, profiles, favorites, watchlist, votes, push subs), `api/auth/*` (SIWE nonces + JWT revocation), `_lib/push.js` |
| Free tier | 500 MB DB / 50k MAU — plenty. **BUT free projects auto-pause after ~7 days of inactivity** (caused the 2026-06-09 marketplace outage) |
| Paid threshold | Pro $25/mo (removes auto-pause, adds PITR option) |
| Today | $0, but Pro is the single most defensible paid upgrade on this list |
| Breaks on lapse/pause | Native listings vanish (reads degrade to `degraded:true` empty lists), order create/cancel/fill 5xx, DMs/profiles/push subs down, proxy writes 503 (revocation check fails closed) |
| Detection | **Weak — gap.** The synthetic monitor accepts `degraded:true` responses as healthy (probes grep for `orders`/`trades`, which the degraded shape contains). Vercel logs only |
| Backup | `.github/workflows/supabase-backup.yml` — weekly encrypted artifact, 90-day retention. Signed Seaport orders are bearer instruments; the backup is what lets makers see/cancel orders if the DB is lost |

### 5. Upstash Redis (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`)
| | |
|---|---|
| Used by | `_lib/ratelimit.js` — distributed rate limiting for the whole API surface |
| Free tier | ~10k commands/day; pay-as-you-go ~$0.20/100k beyond |
| Today | $0 (current request volume is far under) |
| Breaks on lapse | Nothing user-facing since the 2026-06-09 fix: limiter degrades to per-instance in-memory enforcement of the same limits. Cost of lapse = weaker (per-instance) abuse protection only |
| Detection | `[ratelimit] DEGRADED MODE` console.error in Vercel function logs (once per instance) |

### 6. WalletConnect / Reown (`VITE_WALLETCONNECT_PROJECT_ID`)
| | |
|---|---|
| Used by | `src/lib/wagmi.ts`, `src/nakamigos/contexts/WalletContext.jsx` |
| Free tier | Free project tier covers current scale |
| Today | $0 |
| Breaks on lapse | WalletConnect-modal pairing (mobile wallets) fails; injected wallets (MetaMask/Rabby/Frame) + Coinbase Wallet unaffected — `wagmi.ts` has an explicit no-projectId fallback |
| Detection | User reports only |

### 7. Vercel hosting (Hobby plan)
| | |
|---|---|
| Used by | The entire frontend + all 9 serverless functions |
| Free tier | Hobby: **12-function cap (main = 9, see `frontend/api/SERVERLESS_BUDGET.md`)**, 100 GB bandwidth/mo, bounded function GB-hours. Hobby ToS is non-commercial — a fee-collecting marketplace is a plausible forced-upgrade trigger |
| Paid threshold | Pro $20/mo |
| Today | $0 |
| Breaks | Function cap → deploy failures (recurring known cause, not a code bug); usage caps → site paused |
| Detection | Synthetic monitor catches dead/stale prod within 30 min; deploy failures surface in the CLI/dashboard |

### 8. GitHub Actions
| | |
|---|---|
| Used by | CI, Slither, CodeQL, gitleaks, release, synthetic monitor (every 30 min), Supabase backup (weekly) |
| Free tier | Repo is **public** → standard-runner minutes are free/unmetered. If it ever goes private: the synthetic monitor alone ≈ 1.5k min/mo of the 2k free |
| Today | $0 |
| Breaks | Monitors + backups stop — a meta-failure: the detection layer itself dies. Also: GitHub auto-disables `schedule:` workflows after **60 days without repo activity** |
| Detection | None automated for the cron-disable case; check the Actions tab during quiet months |

### 9. VAPID keypair (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `VITE_VAPID_PUBLIC_KEY`)
| | |
|---|---|
| Used by | `_lib/push.js` (trade/DM web push), `src/nakamigos/lib/notifications.js` |
| Cost | Free (self-generated, no renewal, no vendor) |
| Breaks | Losing or rotating the private key invalidates **every** `push_subscriptions` row — all users must re-opt-in. Keep the pair in the operator secret store; never regenerate casually |
| Detection | Push sends start failing in logs; users stop getting trade alerts |

### 10. Public RPC endpoints (publicnode, llamarpc, ankr)
| | |
|---|---|
| Used by | `src/lib/wagmi.ts` client transport + `_lib/seaport-verify.js` server fallback (RESIL-1) |
| Cost | Free, keyless, **no SLA** |
| Breaks | Individual endpoint outages are auto-demoted by viem's ranked `fallback` transport; total simultaneous failure is the residual risk |
| Detection | None needed individually; total failure shows up as wallet-read errors |

### 11. Domains
| | |
|---|---|
| tegridyfarms.vercel.app | Free, tied to the Vercel account, production alias (CLI-deployed). Lapse = Vercel account loss, covered by item 7 |
| nakamigos.gallery | Custom domain, **currently DOWN (ECONNREFUSED as of 2026-06-11)**. Renewal ~$20–25/yr (.gallery TLD) |
| Squatter risk | The domain is hardcoded in the CORS allowlists of `etherscan.js`, `alchemy.js`, `opensea.js`, `orderbook.js`, `supabase-proxy.js` **and** is the default `ALLOWED_ORIGIN` fallback of `api/v1` (and the other proxies). If registration lapses and a squatter registers it, their origin is **pre-authorized** against our API proxies — free quota burn, and `supabase-proxy.js` grants it *credentialed* CORS (cookie-bearing requests) — plus brand phishing against existing users. Either renew it, or if dropping it intentionally, strip it from all six allowlists first |
| Detection | **None — gap.** It is down today and nothing fired (the synthetic monitor only probes the vercel.app alias) |

### 12. Optional / currently unset
`VITE_ANALYTICS_ENDPOINT`, `VITE_ERROR_ENDPOINT` — no-op until pointed at a sink; $0
unless that sink is paid. `SEAPORT_CHAIN_ID`, `ALLOWED_ORIGINS`, `DISABLE_SECURE_COOKIE`
are config, not vendors.

## Summary — total monthly opex vs the self-sustain bar

| Posture | What's paid | Est. $/mo | Revenue needed/day |
|---|---|---|---|
| Today (all free tiers) | nakamigos.gallery renewal amortized (~$20–25/yr) | **~$2** | ~$0.07 |
| Recommended hardening | + Supabase Pro $25 (kills the auto-pause that already caused one outage) | **~$27** | ~$0.90 |
| Growth (paid tiers kick in) | + Alchemy Growth $49 + Vercel Pro $20 + Upstash PAYG ~$5 | **~$100–130** | ~$3.30–4.30 |

**Bar math.** Self-sustain = ETH fee revenue ≥ the row above that matches reality. At the
recommended posture (~$27/mo ≈ **$0.90/day**, ~0.0002–0.0005 ETH/day at $2k–4k/ETH):
current TOWELI pool volume (~$266/day) at a 0.3% LP fee is ~$0.80/day — but that fee
accrues to the UNCX-locked Uniswap LPs today, **not** the treasury. The bar is realistically
covered only after the deep protocol-owned pool (standing decision) is seeded and routed,
at which point pool fee + front-door fee + marketplace fees clear $0.90/day at today's
volume. The growth posture (~$3.30–4.30/day) needs roughly 4–5x current volume or
equivalent NFT-fee flow.

## Known detection gaps (cheap fixes, in priority order)
1. Synthetic monitor treats Supabase `degraded:true` as healthy — probe should fail (or warn) on the degraded shape.
2. No probe for nakamigos.gallery (already down, never fired) — add a probe or decide to drop the domain and strip the CORS allowlists.
3. No probe for OpenSea/Etherscan key health — both fail silently to empty UI sections.
4. Scheduled workflows self-disable after 60 idle days — calendar reminder or keep-alive commit.
