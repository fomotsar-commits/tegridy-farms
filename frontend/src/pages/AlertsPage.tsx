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
 * WHY THERE IS NO STATIC GATE LINE HERE, unlike AirdropPage's amber "factory is not
 * deployed" paragraph. That page can read its gate synchronously (`isDeployed(addr)`).
 * The rule store's state is a SERVER fact — signed out, not configured, table missing,
 * unreachable — that arrives with the first read, and each panel below prints the one it
 * owns. A static line here would either duplicate that answer or contradict it. In
 * particular, until `016_alert_rules.sql` is applied by hand, every alerts call answers
 * 503 `schema-missing` and the builder says so with the operator's next step attached;
 * that disclosed state is the surface working, not the surface broken, so nothing here
 * hides it behind a flag.
 */
export default function AlertsPage() {
  usePageTitle(
    'Alerts',
    'Watch a token, a wallet or a deployer and be told when something moves — whale transfers, reputation changes, LP unlocks, launches going live, Heat tier changes.',
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
            Rules over the same subjects the trust tools read on demand — a token, a wallet, a deployer — checked on a
            loop and collected in an inbox. Every panel below reports its own state: whether your rules could be read,
            whether anything has evaluated them, and where an alert can actually be delivered.
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
              Rules are stored against your wallet, so they cannot be read or saved until you are signed in. That is
              stated as itself and never as “you have no rules”.
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
              An unread rule store is not an empty one. If the store cannot answer, the list stays empty and the reason
              is printed above it, with whatever an operator has to do about it.
            </li>
          </ul>
        </div>
      </div>
    </>
  );
}
