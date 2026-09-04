import { useEffect } from 'react';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { AlertsPanel } from '../components/notifications/AlertsPanel';

/**
 * Alerts — the route for the rule store, the evaluation loop, the inbox and the
 * delivery report. The surface itself is `components/notifications/AlertsPanel.tsx`,
 * which is a composition root: this page supplies only the title, the analytics ping
 * and the page frame, the way AirdropPage does for its two panels.
 *
 * WHY THIS IS ITS OWN ROUTE AND NOT A TAB IN A HUB. ActivityPage / LearnPage / InfoPage
 * are tab hosts over whole PAGE modules that were merged for IA reasons, and every one
 * of their tabs is a read-only record (leaderboard, history, changelog, terms). Alerts
 * is a wallet-bound read/write tool over arbitrary tokens and wallets — the same shape as
 * /airdrop and /vesting, which are also standalone pages that gate themselves in-page.
 * navConfig's own rule is that a hub gets exactly ONE nav entry, so promoting alerts as a
 * hub tab would have meant a second entry into the Activity hub.
 *
 * WHERE THE RULES LIVE, AND WHY IT IS NOT THE SERVER. A server rule store exists
 * (api/_lib/alerts.js) and is kept for a later wallet-sync step, but no visitor of this
 * venue can reach it: it needs a SIWE session and there is no sign-in control in the nav,
 * and behind that it needs `016_alert_rules.sql`, a migration applied by hand. So the
 * store is this browser's localStorage — no session, no table, no operator step — and the
 * page says so in the panel header rather than promising a wallet-bound store nobody can
 * reach. Wallet sync and Telegram binding still need a sign-in this venue does not offer;
 * bullet 1 below scopes the claim to exactly that.
 *
 * WHY THERE IS NO STATIC GATE LINE HERE, unlike AirdropPage's amber "factory is not
 * deployed" paragraph. Each panel below owns one fact and prints it: the builder owns
 * whether a write reached storage, the source registry owns which rule kinds this
 * deployment can read, and the delivery panel owns where an alert can go. A static line
 * here would either duplicate one of those answers or contradict it.
 */
export default function AlertsPage() {
  usePageTitle(
    'Alerts',
    'Watch a token, a wallet, a deployer or a pool and be told when something moves — reputation changes, launches going live, Heat tier changes, loan deadlines, and price crossings or large swaps on any GeckoTerminal pool.',
  );

  useEffect(() => {
    trackPageView('/alerts');
  }, []);

  return (
    <>
      <PageArtBackdrop pageId="alerts" />
      <div className="relative z-10 max-w-4xl mx-auto px-4 py-10">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Alerts</h1>
          <p className="text-white/60 text-sm mt-1 max-w-2xl leading-relaxed">
            Rules over the same subjects the trust tools read on demand — a token, a wallet, a deployer, a pool —
            checked on a loop and collected in an inbox. Every panel below reports its own state: whether your rules
            reached this browser’s storage, whether anything has evaluated them, and where an alert can actually be
            delivered.
          </p>
        </div>

        {/* The three panels carry their own <h3> headings, so this level exists to keep
            the document from stepping h1 → h3. It is announced, not drawn. */}
        <h2 className="sr-only">Your rules, inbox and delivery</h2>
        <AlertsPanel />

        <div className="mt-10 rounded-2xl border border-white/10 bg-black/20 p-5">
          <h2 className="text-white/80 font-semibold text-sm mb-2">What this page does and does not promise</h2>
          <ul className="text-white/50 text-xs space-y-1.5 leading-relaxed list-disc pl-4 marker:text-white/25">
            <li>
              Rules are saved in this browser and need no sign-in. Wallet sync and Telegram binding do need one, and
              this venue does not offer a sign-in yet — so rules do not follow you to another device.
            </li>
            <li>
              Evaluation runs in this browser tab, roughly once a minute, only while this page is open. Nothing
              evaluates a rule when the tab is closed, and no panel here claims otherwise.
            </li>
            <li>
              A rule whose source is unreadable on this deployment says “cannot evaluate” — the builder discloses that
              at the moment you pick the rule type, rather than letting it surface later as silence.
            </li>
            <li>
              A rule that could not be written to this browser is shown as a warning on an enabled form, never as an
              empty list — it still evaluates for this session, and the warning says it will not survive a reload.
            </li>
          </ul>
        </div>
      </div>
    </>
  );
}
