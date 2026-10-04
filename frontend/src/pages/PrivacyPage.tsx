import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { ArtImg } from '../components/ArtImg';
import { CardArt } from '../components/ui/CardArt';

/** How many section cards have an art surface of their own (privacy-cards idx 0 to 9).
 *  The index wraps here, so a section added below reuses a registered surface. */
const PRIVACY_ART_SLOTS = 10;

// Stable anchor slugs so sections can be deep-linked from FAQs / emails.
const SECTIONS = [
  {
    id: 'information-we-collect',
    title: '1. Information We Collect',
    body: 'The memetics.finance protocol interacts with publicly available blockchain data. This includes your public wallet address when you connect to the Protocol and transaction data that is permanently recorded on the Ethereum blockchain. User preferences are stored locally in your browser via localStorage (theme settings, slippage tolerance, dismissed notifications, analytics session identifier); these never leave your device. When you choose to use features backed by our servers — on-chain chat, favorites, trade offers, push notifications, Sign-In With Ethereum (SIWE) authentication, or the native orderbook — we additionally store the data needed to make those features work on our Supabase database (see Section 5). We do not associate wallet addresses with personal identities and do not collect names, emails, phone numbers, or government IDs. See Section 3 for the analytics events we emit and Section 5 for the exact server-side tables.',
  },
  {
    id: 'information-we-dont-collect',
    title: '2. Information We Don\'t Collect',
    body: 'memetics.finance does not collect personally identifiable information. We do not collect or store: email addresses, names, phone numbers, physical addresses, government IDs; browser fingerprints or device identifiers; tracking cookies or cross-site tracking mechanisms; social media profiles or linked accounts; or geolocation data. When your browser makes a request to any web endpoint — ours or a third party\'s — the receiving server necessarily sees the connecting IP as part of standard HTTP. Vercel (our hosting provider) sees that IP in access logs; Upstash (our rate-limit backend) sees it transiently in a hashed sliding-window key. Neither is linked to your wallet address or retained beyond standard operational retention. Third-party RPC providers, aggregators, and block explorers also see your IP when you interact with them from your browser; their policies, not ours, govern what they do with it.',
  },
  {
    id: 'analytics',
    title: '3. Analytics',
    body: 'We operate a first-party, privacy-preserving analytics pipeline to monitor Protocol health. No third-party analytics or tracking scripts are loaded. When enabled (controlled by the VITE_ANALYTICS_ENDPOINT build-time environment variable), the frontend batches and sends a small set of event records to our own analytics endpoint. Events emitted: page views; swaps (token symbols, amount, route); stakes and unstakes (amount, lock duration); NFT purchases (collection, token ID, price); wallet-connect events (the name of the wallet provider such as "MetaMask" or "Rainbow" — not your wallet address); and client-side errors (sanitized error message and feature context). Every event carries a random per-tab session identifier and a timestamp. Event records do NOT include your wallet address, IP, name, email, browser fingerprint, or any PII, and the session identifier is not linked to any identity. If no analytics endpoint is configured, events are logged to the browser console only. Separately, from 16 October 2026, a client-side error reporter (VITE_ERROR_ENDPOINT) sends error reports to our own endpoint, and only while you have opted in through the consent row in the footer. Before that date no error report is sent or stored, and an error that happened before it is never sent. Consent is checked when an error is captured and again when it is sent, and withdrawing it deletes any reports still waiting in your browser. Before sending, your browser removes private keys, mnemonics, bearer tokens and Ethereum addresses from the message and stack, and the query string from the page address (frontend/src/lib/errorReporting.ts), and our server scrubs again before anything is stored (frontend/api/errors.js): a page address keeps only the site and the page name, query strings and tokens are masked, and Ethereum and Solana addresses and other long identifiers are removed. Exactly this is stored for each report: the error message, the stack trace and the component stack when there is one, the page address, the time the error happened and the time our server received it, plus a running row number. It carries no session identifier, no wallet address and no IP, and the report is sent without cookies, so nothing ties one record to another or to you. Each report is kept for 30 days and then deleted automatically. If our server cannot accept reports yet, your browser keeps at most 50 and tries again after a wait; reports older than seven days are never sent.',
  },
  {
    id: 'third-party-services',
    title: '4. Third-Party Services',
    body: 'The Protocol interfaces with third-party services to function. Ethereum data: Alchemy and other public RPC providers relay transactions to the Ethereum network; block explorers (Etherscan, Basescan) link transaction details and contract verification. Wallet / connectivity: WalletConnect for wallet-to-dapp bridges; RainbowKit for connect UI. Prices and swaps: GeckoTerminal and Chainlink feeds for displayed prices; DEX aggregators (Odos, 0x, 1inch, CoW Swap, LiFi, KyberSwap, OpenOcean, Paraswap) when you request a swap quote. Hosting and infra: Vercel hosts the frontend and serverless `/api` routes; Supabase provides the Postgres database, authentication, and row-level security for server-side features; Upstash Redis backs per-IP rate limiting on every `/api` route. NFT marketplace: OpenSea for secondary-market listings and offers (via server-side proxy). When you make a request to any of these services from your browser, they see your IP as part of standard HTTP, and some will see your wallet address if it is included in the request payload (for example, an aggregator quote asks for the "taker" address to simulate the swap). Each provider has its own privacy policy — we encourage you to review them.',
  },
  {
    id: 'data-storage',
    title: '5. Data Storage',
    body: 'Client side (your browser): all user preference data is stored in your browser\'s localStorage and sessionStorage. You control it and can clear it at any time through your browser settings. Server side (Supabase): to make opt-in features work, we store the minimum data required, keyed only by public wallet address. The tables are: `messages` (chat posts you publish), `user_profiles` / `user_favorites` / `user_watchlist` (discovery surfaces tied to your wallet), `votes` (governance and opinion votes), `trade_offers` (peer-to-peer trade records), `push_subscriptions` (browser push endpoints you opt into), `native_orders` (signed marketplace orders), `siwe_nonces` (single-use auth nonces, auto-deleted within 5 minutes), `revoked_jwts` (per-session revocation list so logged-out tokens stop working — pruned as each token expires), and `error_events` (client-side error reports, stored from 16 October 2026 and only with your consent, scrubbed on our server before storage: the error message, stack trace, component stack, page address, the time of the error and the time we received it; no wallet address, no session identifier and no IP, so rows cannot be linked to each other or to you; each report is kept for 30 days and then deleted automatically). Row-Level Security is enforced on every row by the wallet claim in your SIWE-issued JWT; writes that don\'t match your wallet are rejected at the database. Blockchain (Ethereum): transaction data is permanently and publicly recorded by Ethereum itself. It is not controlled by the Protocol and cannot be altered or removed by any party.',
  },
  {
    id: 'your-rights',
    title: '6. Your Rights',
    body: 'You may disconnect your wallet at any time, ending the session. You may clear all locally stored data through your browser settings. For Supabase-backed records, you can delete your own messages, favorites, watchlist items, trade offers, and push subscriptions directly in the UI; those deletions remove the rows from our database (not just from your view). We retain audit-only data (orderbook entries after they\'re filled or cancelled; revoked_jwts until the underlying token expires) for the minimum time needed to prevent replay and fraud. If you are in the EU, UK, or California and want a machine-readable export or verified deletion of all records keyed to your wallet address, reach us through the community channels linked in the site footer and we will respond within 30 days (GDPR Articles 15 and 17; CCPA §1798.100 and §1798.105). Your on-chain transaction history is public, immutable, and outside our control.',
  },
  {
    id: 'security',
    title: '7. Security',
    body: 'The Protocol employs HTTPS for all frontend communications; a Content Security Policy header; fail-closed per-IP rate limiting on every `/api` route; SIWE (EIP-4361) authentication with single-use nonces and server-side revocation on logout; Row-Level Security on every Supabase table; and periodic smart-contract audits tracked in `AUDITS.md`. We do not store private keys, seed phrases, or passwords. No system is perfectly secure; users are responsible for the security of their own wallets and devices. See our Security Policy (`/security`) and `docs/SECRET_ROTATION.md` for how we handle credentials and incidents.',
  },
  {
    id: 'children',
    title: '8. Children',
    body: 'The memetics.finance protocol is not intended for use by individuals under the age of 18. We do not knowingly facilitate interactions with minors. If you are under 18, you must not use the Protocol. Since we do not collect personal information, we cannot verify ages and rely on users to comply.',
  },
  {
    id: 'changes-to-this-policy',
    title: '9. Changes to This Policy',
    body: 'We may update this Privacy Policy from time to time to reflect changes in our practices or for other operational, legal, or regulatory reasons. Material changes — anything that broadens the data we collect or the services we share it with — will be called out at the top of this page for at least 14 days. Minor wording or clarification changes update the "Last Updated" date only. Your continued use of the Protocol after any changes constitutes acceptance of the updated policy. Past versions are preserved in the `frontend/src/pages/PrivacyPage.tsx` git history.',
  },
  {
    id: 'contact',
    title: '10. Contact',
    body: 'For privacy questions, data-rights requests, or security disclosures, reach us through the community channels linked in the site footer. For general community discussion, join those same channels.',
  },
];

export default function PrivacyPage() {
  usePageTitle('Privacy Policy', 'How memetics.finance handles your data and privacy.');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="privacy" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        {/* Dark scrim so the long-form privacy copy stays crisp no matter where you scroll */}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(6,12,26,0.80) 0%, rgba(6,12,26,0.85) 40%, rgba(6,12,26,0.90) 100%)' }} />
      </div>

      <div className="relative z-10 max-w-[800px] mx-auto px-4 md:px-6 pt-28 pb-20">
        <m.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12"
        >
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">
            Privacy Policy
          </h1>
          <p className="text-white/70 text-sm">
            How memetics.finance handles your data — plain English, no dark patterns.
          </p>
        </m.div>

        {/* Section 9's promise, kept: a change that broadens what we collect is called
            out here for at least 14 days before it takes effect. The date and the 30 days
            are the constants the code enforces (api/_lib/errorPolicy.js), and
            PrivacyPage.test.tsx holds these words to them. Posted 2026-10-02. */}
        <div
          role="note"
          aria-labelledby="notice-error-reports-heading"
          className="relative isolate rounded-2xl p-6 md:p-8 mb-6 backdrop-blur-md"
          style={{
            background: 'rgba(13, 21, 48, 0.92)',
            border: '1px solid var(--color-purple-12)',
          }}
        >
          <CardArt pageId="privacy" idx={1} />
          <h2 id="notice-error-reports-heading" className="text-lg font-semibold text-white mb-3">
            Notice of a change on 16 October 2026: error reports
          </h2>
          <div className="space-y-3 text-white/80 text-sm leading-relaxed">
            <p>
              Posted on 2 October 2026, 14 days ahead, as section 9 below promises. From 16 October 2026, if you
              have opted in to error reports through the consent row in the footer, your browser will send a report
              to our own server when this site runs into an error, and we will store it.
            </p>
            <p>
              A stored report holds the error message, the stack trace and component stack if there is one, the
              page address without its query string, the time the error happened and the time we received it.
              Wallet addresses, keys and tokens are removed first. It has no wallet address, no session identifier
              and no IP, so it cannot be tied to you. Each report is kept for 30 days and then deleted automatically.
            </p>
            <p>
              Until 16 October 2026, no error report is sent to our server or stored there. If you have not opted
              in, nothing changes for you. Sections 3 and 5 below give the details.
            </p>
          </div>
        </div>

        <div className="space-y-6">
          {SECTIONS.map((section, i) => (
            <m.section
              key={section.id}
              id={section.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 + i * 0.05 }}
              className="relative isolate rounded-2xl p-6 md:p-8 backdrop-blur-md scroll-mt-24"
              style={{
                background: 'rgba(13, 21, 48, 0.88)',
                border: '1px solid var(--color-purple-12)',
              }}
              aria-labelledby={`${section.id}-heading`}
            >
              <CardArt pageId="privacy-cards" idx={i % PRIVACY_ART_SLOTS} />
              <h2 id={`${section.id}-heading`} className="text-lg font-semibold text-white mb-3">
                {section.title}
              </h2>
              <p className="text-white/70 text-sm leading-relaxed">
                {section.body}
              </p>
            </m.section>
          ))}
        </div>

        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.8 }}
          className="text-center mt-12"
        >
          <p className="text-white/70 text-xs">
            Last updated: <time dateTime="2026-10-02">October 2, 2026</time>
          </p>
        </m.div>
      </div>
    </div>
  );
}
