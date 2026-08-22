import { useMemo } from 'react';
import { useAlerts } from '../../hooks/useAlerts';
import { useAlertsEvaluation } from '../../hooks/useAlertsEvaluation';
import { useNotifications } from '../../hooks/useNotifications';
import { describeRule } from '../../lib/alerts/rules';
import { AlertRuleBuilder } from './AlertRuleBuilder';
import { DeliveryChannelNotice } from './DeliveryChannelNotice';
import { NotificationInbox } from './NotificationInbox';
import { TelegramLinkPanel } from '../bot/TelegramLinkPanel';

// Composition root for the alerts surface: rule store → evaluation loop → inbox.
//
// Mountable anywhere; routing it lives outside this module. The three panels are
// deliberately separate components so the honest states of each (store unusable,
// source dark, channel absent) are rendered by the piece that owns the fact,
// rather than funnelled into one banner that a reader can dismiss as chrome.

export function AlertsPanel() {
  const alerts = useAlerts();

  // Evaluation runs only against rules that were actually READ. When the store is
  // unusable `alerts.rules` is empty, and an empty pass is reported as "no rules"
  // by the inbox rather than as a quiet market — the store's own problem is shown
  // by the builder, where it belongs.
  const evaluation = useAlertsEvaluation(alerts.rules, { enabled: alerts.status === 'ready' });

  const ruleLabels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const rule of alerts.rules) out[rule.id] = describeRule(rule);
    return out;
  }, [alerts.rules]);

  const inbox = useNotifications(evaluation.evaluations, ruleLabels);

  const storeProblem = alerts.status === 'ready' ? null : alerts.detail;

  return (
    <div className="space-y-4">
      <AlertRuleBuilder
        rules={alerts.rules}
        limit={alerts.limit}
        hasPremium={alerts.hasPremium}
        busy={alerts.busy}
        writeError={alerts.writeError}
        storeProblem={storeProblem}
        onAdd={(draft) => void alerts.addRule(draft)}
        onRemove={(id) => void alerts.removeRule(id)}
        onToggle={(id, enabled) => void alerts.setRuleEnabled(id, enabled)}
      />

      {alerts.operatorStep && (
        <p className="text-white/50 text-[11px] leading-snug px-1">
          <span className="uppercase tracking-wide">Operator: </span>
          {alerts.operatorStep}
        </p>
      )}

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

      <DeliveryChannelNotice channels={inbox.channels} delivery={alerts.delivery} />

      {/* Sits under the delivery notice because it answers the question that notice
          raises: Telegram is the channel users expect to receive alerts on, and the
          panel's job is partly to say that it does not — no keeper exists, so a
          linked chat is a place to ASK from, not a place things arrive. */}
      <TelegramLinkPanel />
    </div>
  );
}

export default AlertsPanel;
