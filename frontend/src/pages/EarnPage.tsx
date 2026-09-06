import { lazy } from 'react';
import { SectionHost } from './SectionHost';
import { EARN_SECTION } from '../lib/navConfig';

// Referral links, the staking threshold that decides whether sharing one earns
// anything at all, and the on-chain claim. NOT flag-gated and not pilled: the
// splitter is deployed and the long-form `/?ref=0x…` link resolves in the browser
// with no server, so the surface is live. Only the optional short `/?r=code` form
// needs `019_referral_codes.sql`, and the share card prints that store's own answer
// rather than gating the page on it.
const ReferralsPage = lazy(() => import('./ReferralsPage'));
// Yield routing (#32 / #21 / #34) — a comparison of THIRD-PARTY liquid staking and
// stablecoin lending venues. This venue issues nothing here and deploys no contract:
// every figure is read live from Ethereum mainnet over the public RPC roster, and each
// route sends the deposit straight to that protocol's own permissionless entry function
// in lib/yield/venues.ts. Not flag-gated. The counterparty disclosures and the
// structural refusals (a venue with no on-chain growth rate, or no market leg, says so)
// are as much the product as the routing.
const YieldPage = lazy(() => import('./YieldPage'));
// Copy trading (#7) and trading competitions (#50). Both read the ISLAND TAPE —
// GeckoTerminal's pool-trade feed for the registry's resident pools plus the venue's
// own TOWELI/WETH pool — so neither needs an env var, a key or a proxy. NOT flag-gated,
// and the refusals rather than the feed are what make routing them right: no wallet on
// either board carries a profit figure (a pool fill is one leg of a trade), nothing
// executes for you because this venue runs no keeper, and no season pays or settles.
// A read that fails is named by each page's own ledger, not flattened into an empty table.
const CopyTradingPage = lazy(() => import('./CopyTradingPage'));
const CompetitionsPage = lazy(() => import('./CompetitionsPage'));
// Merchant checkout + recurring billing (#68 / #69). NOT flag-gated, because the
// states it can be in are the product: the buyer is shown the exact amount and the
// exact settlement asset before signing, and no signature is offered at all when the
// route cannot guarantee the merchant's exact amount. Non-custodial by construction —
// both legs are signed in the buyer's own wallet with the merchant as the direct
// recipient, and api/_lib/commerce.js holds no key. The invoice itself needs no server:
// it is an EIP-712 document the merchant signs and carries in the link's `#i=` fragment,
// which the buyer's browser verifies against the merchant address. `021_commerce.sql`
// still gates only the optional short `?invoice=` form, and that lookup answers 503
// `schema-missing` rather than "no such invoice" until an operator applies it.
const CheckoutPage = lazy(() => import('./CheckoutPage'));
// The pools themselves — staking, locks, LP farming. Came in from the top bar
// on 2026-09-05, where it was called "Farm": DeFi jargon, and the same idea this
// section was already named after, so one thing wore two names at two levels.
const FarmPage = lazy(() => import('./FarmPage'));
// Borrowing against an NFT, and the NFT AMM. Also came in from the top bar,
// where it was "NFT Finance" — a category, not something anyone wants to do.
const LendingPage = lazy(() => import('./LendingPage'));

/**
 * EarnPage — the Earn section as ONE page with tabs.
 *
 * What these five share is the visitor's job: turn attention, capital or a
 * customer into income. What they do NOT share is a contract, a feed or a
 * counterparty, which is why each keeps its own route, its own gating predicate
 * and its own disclosures — /yield's venues are other people's protocols,
 * /copy-trading and /competitions read a third-party tape and settle nothing,
 * /checkout is a browser-signed transfer. The tab strip carries each entry's
 * SOON pill straight from navConfig so collapsing the menu cannot quietly
 * un-disclose a gated one.
 */
export default function EarnPage() {
  return (
    <SectionHost
      section={EARN_SECTION}
      idPrefix="earn"
      ariaLabel="Earn sections"
      panels={{
        '/farm': FarmPage,
        '/nft-finance': LendingPage,
        '/referrals': ReferralsPage,
        '/yield': YieldPage,
        '/copy-trading': CopyTradingPage,
        '/competitions': CompetitionsPage,
        '/checkout': CheckoutPage,
      }}
    />
  );
}
