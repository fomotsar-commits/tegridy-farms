import { useMemo } from 'react';
import { useAlerts } from '../../hooks/useAlerts';
import { useAlertsEvaluation } from '../../hooks/useAlertsEvaluation';
import { useNotifications } from '../../hooks/useNotifications';
import { describeRule } from '../../lib/alerts/rules';
import { residentLabelForSubject } from '../../lib/alerts/residentPools';
import { AlertRuleBuilder } from './AlertRuleBuilder';
import { DeliveryChannelNotice } from './DeliveryChannelNotice';
import { NotificationInbox } from './NotificationInbox';
import { TelegramLinkPanel } from '../bot/TelegramLinkPanel';
import { ArtCard } from '../ui/ArtCard';

// Composition root for the alerts surface: rule store → evaluation loop → inbox.
//
// Mountable anywhere; routing it lives outside this module. The three panels are
// deliberately separate components so the honest states of each (store unusable,
// source dark, channel absent) are rendered by the piece that owns the fact,
// rather than funnelled into one banner that a reader can dismiss as chrome.
//
// ART IS ADDITIVE HERE, NOT A REPLACEMENT. The page keeps its PageArtBackdrop
// (alerts idx 0); these three cards are new surfaces (idx 2-4) that put the
// island's art behind panels which shipped as bare black boxes and read as a
// colder, different app. Each ArtCard renders an 85%-opaque panel over the
// image, so the sections below drop their own background and lose no contrast.
// Their <section aria-label> and <h3> are untouched, so the region names and the
// document's heading order are exactly what they were.
//
// THE LOOP IS NO LONGER PARKED. It used to run only when the server store said
// `ready`, which no visitor could reach — so the evaluation engine had never run
// in production. The browser store is always readable, so the only thing that
// parks the loop now is having no rules, which the loop decides for itself.

export function AlertsPanel() {
  const alerts = useAlerts();

  // Rules that are only in memory (the store could not be written) are still
  // evaluated: a rule that will not survive a reload is still a rule for this
  // session, and refusing to evaluate it would add a second, silent failure to a
  // disclosed one.
  const evaluation = useAlertsEvaluation(alerts.rules);

  const ruleLabels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const rule of alerts.rules) {
      const resident = residentLabelForSubject(rule.subject);
      out[rule.id] = resident ? `${describeRule(rule)} (${resident})` : describeRule(rule);
    }
    return out;
  }, [alerts.rules]);

  const inbox = useNotifications(evaluation.evaluations, ruleLabels);

  return (
    <div className="space-y-4">
      <ArtCard pageId="alerts" idx={2} padding="p-0">
        <AlertRuleBuilder
          rules={alerts.rules}
          limit={alerts.limit}
          writeError={alerts.writeError}
          storeWarning={alerts.detail}
          onAdd={(draft) => alerts.addRule(draft)}
          onRemove={(id) => alerts.removeRule(id)}
          onToggle={(id, enabled) => alerts.setRuleEnabled(id, enabled)}
        />
      </ArtCard>

      <ArtCard pageId="alerts" idx={3} padding="p-0">
        <NotificationInbox
          entries={inbox.entries}
          unread={inbox.unread}
          coverage={evaluation.coverage}
          lastRunAt={evaluation.lastRunAt}
          ruleCount={alerts.rules.length}
          onMarkRead={inbox.markRead}
          onMarkAllRead={inbox.markAllRead}
          onDismiss={inbox.dismiss}
        />
      </ArtCard>

      <ArtCard pageId="alerts" idx={4} padding="p-0">
        <DeliveryChannelNotice channels={inbox.channels} onSubscribe={inbox.requestNotificationPermission} />
      </ArtCard>

      {/* Sits under the delivery notice because it answers the question that notice
          raises: Telegram is the channel users expect to receive alerts on, and the
          panel's job is partly to say that it does not — no keeper exists, so a
          linked chat is a place to ASK from, not a place things arrive. */}
      <TelegramLinkPanel />
    </div>
  );
}

export default AlertsPanel;
